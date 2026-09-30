//! A pasta sincronizada: o laço que espelha a biblioteca do usuário (resumos em Markdown e
//! transcrições em JSONL, uma subpasta por Collection) numa pasta local. Roda em thread própria,
//! para uma biblioteca grande não atrasar o upload das gravações.
//!
//! Cada ciclo lê só o que mudou desde o último (`?since=` do manifesto); de tempos em tempos, e em
//! "Sincronizar agora", uma varredura confere a biblioteca inteira e apaga o que saiu do servidor.
//! O contrato está em docs/standards/code/desktop-pasta-sincronizada.md.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_mirror::{Applied, Mirror, MirrorItem, Segment, Speaker, Summary, Transcript};
use eclume_recorder::now_ms;
use eclume_sync::api::{self, CollectionInfo, LibraryRecording};
use eclume_sync::{Client, LibrarySummary, MissingScope};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Intervalo entre ciclos.
const INTERVAL: Duration = Duration::from_secs(60);
/// A varredura que confere a biblioteca inteira e apaga o que saiu do servidor.
const SWEEP_EVERY_MS: i64 = 6 * 60 * 60 * 1000;

static LAST_SWEEP: AtomicI64 = AtomicI64::new(0);

/// O que o espelho lê do servidor. O `Client` real de um lado, um falso nos testes.
pub trait Source {
    fn collections(&self) -> Result<Vec<CollectionInfo>>;
    fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>>;
    fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>>;
    fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>>;
    /// O início da gravação em hora local (`AAAA-MM-DDTHH:MM:SS`), que dá mês e nome ao arquivo.
    /// O padrão usa o fuso deste computador; os testes fixam um.
    fn local_start(&self, recorded_at: &str) -> Option<String> {
        api::local_start(recorded_at)
    }
}

impl Source for Client {
    fn collections(&self) -> Result<Vec<CollectionInfo>> {
        Client::collections(self)
    }
    fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>> {
        Client::library(self, since)
    }
    fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>> {
        Client::current_summary(self, recording_id)
    }
    fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>> {
        Client::transcript(self, recording_id)
    }
}

/// O resultado de um ciclo.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    /// Gravações lidas neste ciclo (as que mudaram, ou todas na primeira passada).
    pub recordings: usize,
    pub written: usize,
    pub unchanged: usize,
    pub removed: usize,
    /// Gravações que falharam ao ler: o cursor não avança e o próximo ciclo as tenta de novo.
    pub failed: usize,
    /// O servidor recusou a leitura de transcrições (403 `insufficient_scope`): os resumos foram
    /// sincronizados e as transcrições esperam o servidor liberar o escopo.
    pub transcripts_denied: bool,
}

/// Monta o que o espelho escreve a partir do que o servidor devolveu.
pub fn to_item(
    recording: &LibraryRecording,
    local_start: Option<String>,
    collections: &HashMap<String, String>,
    summary: Option<LibrarySummary>,
    transcript: Option<api::Transcript>,
) -> MirrorItem {
    let title = if recording.title.trim().is_empty() {
        transcript
            .as_ref()
            .map(|t| t.title.clone())
            .unwrap_or_default()
    } else {
        recording.title.clone()
    };
    let mut names: Vec<String> = recording
        .collection_ids
        .iter()
        .filter_map(|id| collections.get(id).cloned())
        .collect();
    names.sort();
    names.dedup();
    let agenda_type = summary
        .as_ref()
        .and_then(|s| s.agenda_type.clone())
        .or_else(|| recording.agenda_type.as_ref().map(|a| a.name.clone()))
        .filter(|name| !name.is_empty());
    MirrorItem {
        recording_id: recording.id.clone(),
        title,
        recorded_at: recording.recorded_at.clone(),
        local_start,
        collections: names,
        agenda_type,
        summary: summary.map(|s| Summary {
            version: s.version,
            markdown: s.content_md,
        }),
        transcript: transcript.map(|t| Transcript {
            id: t.id,
            language: t.language,
            duration_ms: t.duration_ms,
            revision: t.revision,
            speakers: t
                .speakers
                .into_iter()
                .map(|s| Speaker {
                    id: s.id,
                    label: s.label,
                })
                .collect(),
            segments: t
                .segments
                .into_iter()
                .map(|s| Segment {
                    speaker_id: s.speaker_id,
                    start_ms: s.start_ms,
                    end_ms: s.end_ms,
                    text: s.text,
                })
                .collect(),
        }),
    }
}

/// Margem do cursor `since`, em segundos: cobre a transação que confirma depois de outra com
/// `updated_at` maior (o `now()` do servidor é o início da transação).
const CURSOR_MARGIN_SECS: i64 = 120;

/// Os nomes de Collection por id, com uma grafia só por nome: "Clientes" e "clientes" viram a
/// mesma pasta em Windows e macOS, então todas usam a primeira (em ordem de nome e id).
fn collection_names(mut collections: Vec<CollectionInfo>) -> HashMap<String, String> {
    collections.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
    let mut canonical: HashMap<String, String> = HashMap::new();
    let mut names = HashMap::new();
    for collection in collections {
        let spelled = canonical
            .entry(collection.name.to_lowercase())
            .or_insert_with(|| collection.name.clone())
            .clone();
        names.insert(collection.id, spelled);
    }
    names
}

/// Um ciclo: lê o que mudou (ou tudo, na primeira passada), escreve, e numa varredura apaga o que
/// saiu do servidor. O manifesto é sempre gravado no fim, mesmo depois de um erro: os arquivos
/// já escritos não podem ficar sem registro.
pub fn sync_library(
    source: &dyn Source,
    mirror: &mut Mirror,
    transcripts: bool,
    sweep: bool,
) -> Result<Report> {
    let names = collection_names(source.collections()?);
    // Arquivos de outro desenho de pasta e nome, ou escritos com a opção de transcrições de
    // antes: relê tudo, e o manifesto move e apaga o que ficou para trás.
    let since = if mirror.needs_rebuild(transcripts) {
        None
    } else {
        mirror.since().map(str::to_string)
    };
    let changed = source.library(since.as_deref())?;
    let cursor = api::cursor_from(&changed, CURSOR_MARGIN_SECS);
    let mut pending = mirror.pending().clone();

    // Primeira passada: a listagem já é a biblioteca inteira. Depois, a varredura (e as
    // gravações que falharam antes) pede a inteira, para achar o que saiu do servidor, o que o
    // manifesto ainda não tem e as pendentes.
    let mut todo = changed;
    let mut present: Option<Vec<String>> = None;
    if since.is_none() {
        present = Some(todo.iter().map(|r| r.id.clone()).collect());
    } else if sweep || !pending.is_empty() {
        let all = source.library(None)?;
        if sweep {
            present = Some(all.iter().map(|r| r.id.clone()).collect());
        }
        for recording in all {
            // O que o manifesto não tem, as transcrições que ficaram faltando (um servidor sem o
            // escopo, antes) e as pendentes; só a varredura completa as transcrições.
            let missing = pending.contains(&recording.id)
                || (sweep
                    && match mirror.entry(&recording.id) {
                        None => true,
                        Some(entry) => {
                            transcripts
                                && recording.transcript_id.is_some()
                                && entry.transcript_revision.is_none()
                        }
                    });
            if missing && !todo.iter().any(|r| r.id == recording.id) {
                todo.push(recording);
            }
        }
    }

    let mut report = Report::default();
    // Sem o escopo, a primeira recusa vale para o ciclo todo: as demais gravações nem pedem.
    let mut transcripts_on = transcripts;
    for recording in &todo {
        report.recordings += 1;
        // Uma gravação que já tinha `.jsonl` e agora é recusada fica como está: degradar é não
        // atualizar, não apagar.
        let had_transcript = mirror
            .entry(&recording.id)
            .is_some_and(|entry| entry.transcript_revision.is_some());
        let read = |transcripts_on: &mut bool, denied: &mut bool| -> Result<Option<MirrorItem>> {
            let summary = if recording.transcript_id.is_some() {
                source.current_summary(&recording.id)?
            } else {
                None
            };
            let transcript = if *transcripts_on && recording.transcript_id.is_some() {
                match source.transcript(&recording.id) {
                    Ok(transcript) => transcript,
                    Err(err) if err.downcast_ref::<MissingScope>().is_some() => {
                        log::warn!("pasta sincronizada: sem o escopo das transcrições: {err:#}");
                        *transcripts_on = false;
                        *denied = true;
                        None
                    }
                    Err(err) => return Err(err),
                }
            } else {
                None
            };
            if *denied && had_transcript {
                return Ok(None);
            }
            let local_start = recording
                .recorded_at
                .as_deref()
                .and_then(|at| source.local_start(at));
            Ok(Some(to_item(
                recording,
                local_start,
                &names,
                summary,
                transcript,
            )))
        };
        let outcome = match read(&mut transcripts_on, &mut report.transcripts_denied) {
            Ok(Some(item)) => mirror.apply(&item),
            Ok(None) => Ok(Applied::default()),
            Err(err) => Err(err),
        };
        match outcome {
            Ok(applied) => {
                pending.remove(&recording.id);
                report.written += applied.written;
                report.unchanged += applied.unchanged;
                report.removed += applied.removed;
            }
            Err(err) => {
                log::warn!("pasta sincronizada: gravação {}: {err:#}", recording.id);
                pending.insert(recording.id.clone());
                report.failed += 1;
            }
        }
    }
    let mut fatal = None;
    if let Some(ids) = present {
        let keep = ids.into_iter().collect();
        match mirror.retain_only(&keep) {
            Ok(applied) => report.removed += applied.removed,
            Err(err) => fatal = Some(err),
        }
    }
    // O cursor avança mesmo com falhas: as gravações que falharam ficam em `pending` e são elas
    // que o ciclo seguinte repete, não a biblioteca inteira.
    if let Some(cursor) = cursor {
        mirror.set_since(Some(cursor));
    } else if since.is_none() {
        // Biblioteca vazia: o próximo ciclo já é incremental.
        mirror.set_since(Some("1970-01-01T00:00:00Z".to_string()));
    }
    mirror.set_pending(pending);
    mirror.mark_layout_current();
    mirror.set_transcripts(transcripts);
    if let Err(err) = mirror.write_agents(transcripts) {
        // Uma pasta com o nome do arquivo, ou um arquivo travado: o `AGENTS.md` não é motivo
        // para perder o registro do que já foi escrito.
        log::warn!("pasta sincronizada: AGENTS.md: {err:#}");
    }
    mirror.save()?;
    match fatal {
        Some(err) => Err(err),
        None => Ok(report),
    }
}

/// O que a aba mostra além do "sincronizada": nada quando tudo passou, ou o que ficou de fora.
pub fn status_note(report: &Report) -> Option<String> {
    let mut notes = Vec::new();
    if report.transcripts_denied {
        notes.push(
            "Resumos sincronizados, mas o servidor ainda não permite que o app leia transcrições \
             (precisa do contrato 2.8.0): atualize o servidor"
                .to_string(),
        );
    }
    if report.failed > 0 {
        notes.push(format!(
            "{} gravações não puderam ser lidas; nova tentativa no próximo ciclo",
            report.failed
        ));
    }
    (!notes.is_empty()).then(|| notes.join(" · "))
}

/// O canal para cutucar o laço; a mensagem diz se é para varrer a biblioteca inteira.
pub struct MirrorHandle(Mutex<Sender<bool>>);

/// Sobe a thread da pasta sincronizada e registra o canal no app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<bool>();
    app.manage(MirrorHandle(Mutex::new(tx)));
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-mirror".into())
        .spawn(move || loop {
            let forced = match rx.recv_timeout(INTERVAL) {
                Ok(sweep) => sweep,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            // Vários cutucões seguidos valem um ciclo só.
            let forced = forced | rx.try_iter().any(|sweep| sweep);
            let due = now_ms() - LAST_SWEEP.load(Ordering::Relaxed) >= SWEEP_EVERY_MS;
            if let Err(err) = tick(&app, forced || due) {
                log::error!("falha na pasta sincronizada: {err:#}");
            }
            crate::refresh_ui(&app);
        });
    if let Err(err) = spawned {
        log::error!("falha ao iniciar a pasta sincronizada: {err}");
    }
}

/// Pede um ciclo já (`sweep`: conferir também a biblioteca inteira).
pub fn nudge(app: &AppHandle, sweep: bool) {
    if let Some(handle) = app.try_state::<MirrorHandle>() {
        if let Ok(tx) = handle.0.lock() {
            let _ = tx.send(sweep);
        }
    }
}

fn tick(app: &AppHandle, sweep: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let config = state.mirror_config()?;
    if !config.enabled {
        return Ok(());
    }
    let dir = config
        .dir
        .clone()
        .ok_or_else(|| anyhow!("pasta dos resumos não escolhida"))?;
    let Some(uploader) = state.uploader_config()? else {
        state.update_mirror(|status| {
            status.running = false;
            status.last_error = Some("Entre na conta para sincronizar a pasta".into());
        })?;
        return Ok(());
    };
    state.update_mirror(|status| status.running = true)?;
    crate::refresh_ui(app);
    let result = Client::from_config(&uploader).and_then(|client| {
        let mut mirror = Mirror::open(&dir)?;
        sync_library(&client, &mut mirror, config.transcripts, sweep)
    });
    if result.is_ok() && sweep {
        LAST_SWEEP.store(now_ms(), Ordering::Relaxed);
    }
    state.update_mirror(|status| {
        status.running = false;
        match &result {
            Ok(report) => {
                status.last_sync_ms = Some(now_ms());
                status.last_error = status_note(report);
                status.last = Some(*report);
            }
            Err(err) => status.last_error = Some(format!("{err:#}")),
        }
    })?;
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    #[derive(Default)]
    struct Fake {
        collections: Vec<CollectionInfo>,
        recordings: RefCell<Vec<LibraryRecording>>,
        summaries: RefCell<BTreeMap<String, LibrarySummary>>,
        transcripts: RefCell<BTreeMap<String, api::Transcript>>,
        broken_transcript: RefCell<Vec<String>>,
        /// O servidor recusa `transcripts:read` (403 `insufficient_scope`).
        denied_transcripts: RefCell<bool>,
        transcript_calls: RefCell<usize>,
        /// Fuso do "computador" do teste, em horas a oeste de UTC (0 = UTC).
        west_hours: RefCell<i32>,
        calls: RefCell<Vec<String>>,
    }

    impl Source for Fake {
        fn collections(&self) -> Result<Vec<CollectionInfo>> {
            Ok(self.collections.clone())
        }
        fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>> {
            self.calls
                .borrow_mut()
                .push(format!("library since={since:?}"));
            Ok(self
                .recordings
                .borrow()
                .iter()
                .filter(|r| since.is_none_or(|s| r.updated_at.as_deref() >= Some(s)))
                .cloned()
                .collect())
        }
        fn current_summary(&self, id: &str) -> Result<Option<LibrarySummary>> {
            Ok(self.summaries.borrow().get(id).cloned())
        }
        fn local_start(&self, recorded_at: &str) -> Option<String> {
            api::start_at_offset(recorded_at, -*self.west_hours.borrow() * 3600)
        }
        fn transcript(&self, id: &str) -> Result<Option<api::Transcript>> {
            *self.transcript_calls.borrow_mut() += 1;
            if *self.denied_transcripts.borrow() {
                return Err(anyhow::Error::new(eclume_sync::MissingScope::new(
                    "403 (insufficient_scope)",
                )));
            }
            if self.broken_transcript.borrow().iter().any(|b| b == id) {
                return Err(anyhow!("500"));
            }
            Ok(self.transcripts.borrow().get(id).cloned())
        }
    }

    fn recording(
        id: &str,
        colecoes: &[&str],
        atualizado: &str,
        com_transcricao: bool,
    ) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: "done".into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            created_at: None,
            updated_at: Some(atualizado.into()),
            collection_ids: colecoes.iter().map(|c| c.to_string()).collect(),
            transcript_id: com_transcricao.then(|| format!("t-{id}")),
            agenda_type: None,
            pipeline: vec![],
        }
    }

    fn summary(version: u64) -> LibrarySummary {
        LibrarySummary {
            version,
            agenda_type: Some("Reunião de equipe".into()),
            content_md: format!("# Ata v{version}"),
        }
    }

    fn transcript(id: &str) -> api::Transcript {
        api::Transcript {
            id: format!("t-{id}"),
            recording_id: id.into(),
            title: String::new(),
            language: Some("pt".into()),
            recorded_at: None,
            duration_ms: Some(1000),
            revision: 1,
            speakers: vec![api::TranscriptSpeaker {
                id: "S1".into(),
                label: "Ana".into(),
            }],
            segments: vec![api::TranscriptSegment {
                speaker_id: Some("S1".into()),
                start_ms: 0,
                end_ms: 900,
                text: "oi".into(),
            }],
        }
    }

    fn fake() -> Fake {
        let fake = Fake {
            collections: vec![
                CollectionInfo {
                    id: "c1".into(),
                    name: "Clientes".into(),
                },
                CollectionInfo {
                    id: "c2".into(),
                    name: "Interno".into(),
                },
            ],
            ..Fake::default()
        };
        *fake.recordings.borrow_mut() = vec![
            recording("aaaaaaaa-1", &["c1", "c2"], "2026-09-19T10:00:00Z", true),
            recording("bbbbbbbb-2", &[], "2026-09-19T11:00:00Z", true),
            recording("cccccccc-3", &["c1"], "2026-09-19T12:00:00Z", false),
        ];
        for id in ["aaaaaaaa-1", "bbbbbbbb-2"] {
            fake.summaries.borrow_mut().insert(id.into(), summary(1));
            fake.transcripts
                .borrow_mut()
                .insert(id.into(), transcript(id));
        }
        fake
    }

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("eclume-mirror-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn listed(root: &std::path::Path) -> Vec<String> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.retain(|name| !name.starts_with('.') && name != "AGENTS.md");
        out.sort();
        out
    }

    #[test]
    fn primeira_passada_espelha_a_biblioteca_e_a_segunda_nao_reescreve() {
        let dir = tmp("primeira");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        let first = sync_library(&fake, &mut mirror, true, false).unwrap();
        // aaaaaaaa: md e jsonl nas duas Collections (4); bbbbbbbb: sem-colecao (2);
        // cccccccc: sem transcrição, nada a escrever.
        assert_eq!((first.recordings, first.written, first.failed), (3, 6, 0));
        assert_eq!(
            listed(&dir),
            [
                "Clientes/2026-09/2026-09-18_1400_aaaaaaaa.jsonl",
                "Clientes/2026-09/2026-09-18_1400_aaaaaaaa.md",
                "Interno/2026-09/2026-09-18_1400_aaaaaaaa.jsonl",
                "Interno/2026-09/2026-09-18_1400_aaaaaaaa.md",
                "sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.jsonl",
                "sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md",
            ]
        );
        assert!(dir.join("AGENTS.md").exists());
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));

        // O segundo ciclo lê a partir do cursor (inclusivo: só a última) e não reescreve nada.
        let second = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((second.recordings, second.written), (1, 0));
        assert_eq!(
            fake.calls.borrow().last().unwrap(),
            "library since=Some(\"2026-09-19T11:58:00Z\")"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resumo_refeito_chega_pelo_since_e_reescreve_so_o_md() {
        let dir = tmp("refeito");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        // O servidor move `updated_at` quando o resumo muda (contrato 2.8.0).
        fake.summaries
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), summary(2));
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // O cursor é inclusivo: a última gravação vem de novo, sem nada a escrever.
        assert_eq!(
            (report.recordings, report.written, report.unchanged),
            (2, 1, 1)
        );
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md"))
                .unwrap();
        assert!(md.contains("summary_version: 2") && md.contains("# Ata v2"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_varredura_apaga_o_que_saiu_do_servidor_e_o_incremental_nao() {
        let dir = tmp("varredura");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        fake.recordings.borrow_mut().remove(1);

        let incremental = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(incremental.removed, 0);
        assert!(dir.join("sem-colecao").is_dir());

        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!(sweep.removed, 2);
        assert!(!dir.join("sem-colecao").exists());
        assert!(dir.join("Clientes").is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_varredura_traz_o_que_o_manifesto_nao_tem() {
        let dir = tmp("faltante");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        // Uma gravação antiga (antes do cursor) que o manifesto nunca viu.
        let mut antiga = recording("dddddddd-4", &["c2"], "2026-09-01T00:00:00Z", true);
        antiga.title = "Antiga".into();
        fake.summaries
            .borrow_mut()
            .insert("dddddddd-4".into(), summary(1));
        fake.transcripts
            .borrow_mut()
            .insert("dddddddd-4".into(), transcript("dddddddd-4"));
        fake.recordings.borrow_mut().push(antiga);
        assert_eq!(
            sync_library(&fake, &mut mirror, true, false)
                .unwrap()
                .written,
            0
        );
        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!(sweep.written, 2);
        assert!(dir
            .join("Interno/2026-09/2026-09-18_1400_dddddddd.md")
            .exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn falha_numa_gravacao_vira_pendencia_e_nao_faz_reler_a_biblioteca_inteira() {
        let dir = tmp("falha");
        let fake = fake();
        fake.broken_transcript
            .borrow_mut()
            .push("aaaaaaaa-1".into());
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((report.failed, report.written), (1, 2));
        // O cursor avança e a que falhou fica pendente: é ela que se repete, não tudo.
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));
        assert!(mirror.pending().contains("aaaaaaaa-1"));
        assert!(status_note(&report).unwrap().contains("1 gravações"));

        // Ainda quebrada: outro ciclo tenta só a pendente, sem reler a biblioteca do início.
        fake.calls.borrow_mut().clear();
        let still = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((still.failed, still.recordings), (1, 2));
        assert_eq!(
            fake.calls.borrow().first().unwrap(),
            "library since=Some(\"2026-09-19T11:58:00Z\")"
        );

        // Consertada, a pendente entra e a fila esvazia.
        fake.broken_transcript.borrow_mut().clear();
        let again = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((again.failed, again.written), (0, 4));
        assert!(mirror.pending().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ligar_e_desligar_as_transcricoes_refaz_a_pasta_nos_dois_sentidos() {
        let dir = tmp("liga-desliga");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );

        // Desligada: mesmo sem nada novo no servidor, os `.jsonl` saem e o `.md` perde o link.
        sync_library(&fake, &mut mirror, false, false).unwrap();
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md"))
                .unwrap();
        assert!(!md.contains("transcript:"));
        assert!(!std::fs::read_to_string(dir.join("AGENTS.md"))
            .unwrap()
            .contains("jsonl"));

        // Ligada de novo: voltam na hora, sem esperar a varredura de 6 h.
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn colecoes_que_so_diferem_em_maiusculas_usam_uma_grafia_so() {
        let names = collection_names(vec![
            CollectionInfo {
                id: "2".into(),
                name: "clientes".into(),
            },
            CollectionInfo {
                id: "1".into(),
                name: "Clientes".into(),
            },
            CollectionInfo {
                id: "3".into(),
                name: "Interno".into(),
            },
        ]);
        assert_eq!(names["1"], "Clientes");
        assert_eq!(names["2"], "Clientes");
        assert_eq!(names["3"], "Interno");
    }

    #[test]
    fn sem_o_escopo_o_jsonl_que_ja_existia_fica_como_esta() {
        let dir = tmp("escopo-preserva");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        let jsonl = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.jsonl");
        assert!(jsonl.exists());

        // O resumo muda, mas o servidor passa a recusar as transcrições: o `.jsonl` não some e o
        // `.md` (com o link para ele) não é reescrito sem transcrição.
        *fake.denied_transcripts.borrow_mut() = true;
        fake.summaries
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), summary(2));
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert!(report.transcripts_denied);
        assert!(jsonl.exists());
        let md = std::fs::read_to_string(jsonl.with_extension("md")).unwrap();
        assert!(md.contains("transcript:") && md.contains("summary_version: 1"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn o_manifesto_e_gravado_mesmo_com_o_agents_md_travado() {
        let dir = tmp("agents-travado");
        let fake = fake();
        // Uma pasta no lugar do arquivo: escrever o `AGENTS.md` falha em todo ciclo.
        std::fs::create_dir_all(dir.join("AGENTS.md")).unwrap();
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(report.failed, 0);
        let reopened = Mirror::open(&dir).unwrap();
        assert_eq!(reopened.known_ids().len(), 2);
        assert!(reopened.since().is_some());
        // O próximo ciclo é incremental: o erro do `AGENTS.md` não força reler tudo.
        assert!(!reopened.needs_rebuild(true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn servidor_sem_o_escopo_das_transcricoes_sincroniza_os_resumos_e_nao_insiste() {
        let dir = tmp("sem-escopo");
        let fake = fake();
        *fake.denied_transcripts.borrow_mut() = true;
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // Os resumos de aaaaaaaa (2 Collections) e bbbbbbbb (1) saem; nenhum `.jsonl`; nada falhou.
        assert_eq!(
            (report.written, report.failed, report.transcripts_denied),
            (3, 0, true)
        );
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        // A primeira recusa vale para o ciclo todo: uma chamada só, não uma por gravação.
        assert_eq!(*fake.transcript_calls.borrow(), 1);
        // O cursor avança (não se relê tudo a cada minuto) e a aba explica o que faltou.
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));
        let nota = status_note(&report).unwrap();
        assert!(nota.contains("transcrições") && nota.contains("contrato 2.8.0"));
        assert!(!nota.contains("não puderam ser lidas"));

        // O servidor é atualizado: a varredura completa as transcrições que faltavam.
        *fake.denied_transcripts.borrow_mut() = false;
        let incremental = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(incremental.written, 0);
        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!((sweep.transcripts_denied, sweep.failed), (false, 0));
        // Os três `.jsonl` que faltavam, e os três `.md`, que ganham a propriedade `transcript`.
        assert_eq!(sweep.written, 6);
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );
        assert_eq!(status_note(&sweep), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_nota_da_aba_soma_recusa_e_falhas() {
        assert_eq!(status_note(&Report::default()), None);
        let so_falhas = Report {
            failed: 2,
            ..Report::default()
        };
        assert!(status_note(&so_falhas)
            .unwrap()
            .starts_with("2 gravações não puderam"));
        let ambos = Report {
            failed: 1,
            transcripts_denied: true,
            ..Report::default()
        };
        let nota = status_note(&ambos).unwrap();
        assert!(nota.contains("contrato 2.8.0") && nota.contains(" · 1 gravações"));
    }

    #[test]
    fn a_pasta_e_o_nome_seguem_a_hora_local_do_computador() {
        let dir = tmp("hora-local");
        let fake = fake();
        *fake.west_hours.borrow_mut() = 3;
        // 02:30 UTC de 1º de outubro é 23:30 de 30 de setembro no computador (UTC-3).
        fake.recordings.borrow_mut()[1].recorded_at = Some("2026-10-01T02:30:00Z".into());
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert!(dir
            .join("sem-colecao/2026-09/2026-09-30_2330_bbbbbbbb.md")
            .exists());
        assert!(dir
            .join("Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md")
            .exists());
        // O `recorded_at` do front matter continua em UTC.
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-30_2330_bbbbbbbb.md"))
                .unwrap();
        assert!(md.contains("recorded_at: \"2026-10-01T02:30:00Z\""));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quem_ja_sincronizou_no_layout_antigo_e_migrado_sem_duplicar() {
        let dir = tmp("migracao");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();

        // Volta a pasta ao desenho antigo: arquivo com título no nome, direto na Collection, e o
        // manifesto sem a versão do layout.
        let novo = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md");
        let antigo_rel = "sem-colecao/2026-09-18 Reunião bbbbbbbb-2 - bbbbbbbb.md";
        std::fs::rename(&novo, dir.join(antigo_rel)).unwrap();
        let manifesto = dir.join(".eclume-sync.json");
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifesto).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("layout");
        json["recordings"]["bbbbbbbb-2"]["files"] = serde_json::json!([antigo_rel]);
        std::fs::write(&manifesto, serde_json::to_vec(&json).unwrap()).unwrap();

        let mut mirror = Mirror::open(&dir).unwrap();
        assert!(mirror.needs_rebuild(true));
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // Tudo foi relido (não só o que mudou desde o cursor) e o arquivo antigo se foi.
        assert_eq!(report.recordings, 3);
        assert!(!dir.join(antigo_rel).exists());
        assert!(novo.exists());
        assert!(!mirror.needs_rebuild(true));
        // O ciclo seguinte volta a ser incremental.
        let next = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((next.recordings, next.written), (1, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sem_transcricoes_so_o_markdown_e_o_agents_muda() {
        let dir = tmp("sem-jsonl");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, false, false).unwrap();
        assert_eq!(report.written, 3);
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        let agents = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(!agents.contains("jsonl"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn colecao_desconhecida_e_ignorada_e_o_titulo_cai_na_transcricao() {
        let mut rec = recording("eeeeeeee-5", &["c1", "sumiu"], "2026-09-19T10:00:00Z", true);
        rec.title = "  ".into();
        let names = HashMap::from([("c1".to_string(), "Clientes".to_string())]);
        let mut t = transcript("eeeeeeee-5");
        t.title = "Título da transcrição".into();
        let item = to_item(&rec, None, &names, Some(summary(1)), Some(t));
        assert_eq!(item.collections, ["Clientes"]);
        assert_eq!(item.title, "Título da transcrição");
        assert_eq!(item.agenda_type.as_deref(), Some("Reunião de equipe"));
    }
}
