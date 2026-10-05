//! O painel de gravações recentes do topo da janela: as últimas N gravações da conta, com a fase
//! do processamento, o progresso e o alerta quando a pessoa precisa agir.
//!
//! A fonte é dupla. As linhas da fila local que ainda não chegaram ao servidor (gravando,
//! aguardando envio, enviando, falhou o envio) vêm primeiro; depois, a página das N mais
//! recentes da conta (`GET /recordings?limit=N&sort=created_desc`), que a thread
//! `eclume-recentes` lê a cada 5 s com a janela visível e algo em andamento, e a cada 60 s fora
//! disso. Uma gravação enviada daqui e presente na página é uma linha só, a do servidor.
//!
//! O Rust entrega códigos (fase, etapa, motivo); os rótulos são os do vocabulário compartilhado
//! (`ui/js/vocabulario.js`), aplicados pela janela.

use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use eclume_recorder::{now_ms, QueuedRecording, Status};
use eclume_sync::api::LibraryRecording;
use eclume_sync::{Client, QueueWait};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// Com a janela visível e alguma linha em andamento: o progresso anda na tela.
pub const BUSY_INTERVAL: Duration = Duration::from_secs(5);
/// Fora disso, uma leitura por minuto basta para o painel estar em dia ao abrir.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(60);

/// Os estados da gravação que o contrato 2.20.0 conhece (`RecordingStatus`).
const KNOWN_STATUS: [&str; 5] = ["uploading", "queued", "processing", "transcribed", "failed"];
/// Os estados de etapa que o contrato 2.20.0 conhece (`PipelineStep.state`).
const KNOWN_STEP_STATES: [&str; 5] = ["pending", "active", "done", "failed", "skipped"];
/// O motivo de resumo pulado que a própria pessoa resolve no web (escolher o tipo de agenda).
const ACTIONABLE_NO_SUMMARY: [&str; 1] = ["no_agenda_type"];

/// Onde a gravação está.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// No aparelho: gravando.
    Recording,
    /// No aparelho: aguardando envio.
    Pending,
    /// No aparelho: enviando.
    Uploading,
    /// No aparelho: o envio falhou.
    UploadFailed,
    /// Enviada daqui, sem notícia do servidor (sem leitura ainda, ou fora da página).
    Uploaded,
    /// Na fila do servidor.
    Queued,
    /// Transcrevendo, com a etapa do job e o progresso.
    Transcribing,
    /// Numa etapa do pipeline depois da transcrição (tipo de agenda, campos, resumo).
    Processing,
    /// O resumo está pronto: a linha oferece Copiar resumo.
    SummaryReady,
    /// Transcrita, sem etapa de resumo.
    Transcribed,
    /// Pronta sem resumo (a etapa foi pulada, com o motivo).
    NoSummary,
    SummaryFailed,
    TranscriptionFailed,
    /// A transcrição foi cancelada pelo dono.
    Cancelled,
    /// Um estado que este app não conhece: o servidor é mais novo.
    Unknown,
}

impl Phase {
    /// Em andamento: o laço lê mais vezes enquanto há uma linha assim.
    pub fn in_progress(self) -> bool {
        matches!(
            self,
            Self::Recording
                | Self::Pending
                | Self::Uploading
                | Self::Uploaded
                | Self::Queued
                | Self::Transcribing
                | Self::Processing
        )
    }
}

/// Por que a pessoa precisa agir.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    /// O envio falhou: "Tentar agora" (`sync_now`).
    UploadFailed,
    /// A transcrição falhou sem retentativa automática: "Abrir no web".
    TranscriptionFailed,
    /// O resumo falhou: "Abrir no web" para gerar de novo.
    SummaryFailed,
    /// Pronta sem resumo por um motivo que a pessoa resolve (o tipo de agenda): "Abrir no web".
    NoSummary,
    /// Um estado que o app não conhece (como "aguardando locutores"): "Abrir no web".
    NeedsYou,
}

/// Uma linha do painel.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentItem {
    /// Chave estável da linha: o id do servidor, ou `local:<id>` antes do envio.
    pub key: String,
    pub remote_id: Option<String>,
    pub local_id: Option<String>,
    /// O título; vazio quando ninguém deu um (a janela mostra a data).
    pub title: String,
    /// Início local em ms (linhas do aparelho).
    pub started_at: Option<i64>,
    /// `created_at` do servidor.
    pub created_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub phase: Phase,
    /// A etapa em curso: do job (`asr`…) na transcrição, do pipeline (`summary`…) depois, ou a
    /// etapa do estado desconhecido.
    pub stage: Option<String>,
    /// Progresso da transcrição em milésimos (0–1000).
    pub progress: Option<u16>,
    pub attention: Option<Attention>,
    /// O motivo no vocabulário de `PipelineStep.reason`.
    pub reason: Option<String>,
    /// O texto cru: o erro do envio, o código do erro do job ou o estado desconhecido.
    pub detail: Option<String>,
    /// A espera na fila do servidor, quando o sync a leu.
    pub wait: Option<QueueWait>,
}

/// O que o comando `recent` devolve.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentView {
    /// Quantas linhas a pessoa pediu; `0` esconde o painel.
    pub count: u8,
    pub items: Vec<RecentItem>,
    /// Quantas linhas pedem a pessoa.
    pub needs_you: usize,
    /// Quando o servidor foi lido por último (ms), `None` antes da primeira leitura.
    pub fetched_at: Option<i64>,
    /// A falha da última leitura; o painel segue com o que sabia.
    pub error: Option<String>,
}

/// O que a fase de uma linha do servidor diz.
#[derive(Debug, PartialEq)]
struct Classified {
    phase: Phase,
    stage: Option<String>,
    progress: Option<u16>,
    attention: Option<Attention>,
    reason: Option<String>,
    detail: Option<String>,
}

impl Classified {
    fn of(phase: Phase) -> Self {
        Self {
            phase,
            stage: None,
            progress: None,
            attention: None,
            reason: None,
            detail: None,
        }
    }
}

/// A fase de uma gravação do servidor, na precedência alerta > em andamento > pronto: um
/// estado desconhecido no meio de um pipeline com resumo pronto ainda é alerta.
fn classify(recording: &LibraryRecording) -> Classified {
    if !recording.status.is_empty() && !KNOWN_STATUS.contains(&recording.status.as_str()) {
        return Classified {
            attention: Some(Attention::NeedsYou),
            detail: Some(recording.status.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    if let Some(step) = recording
        .pipeline
        .iter()
        .find(|step| !KNOWN_STEP_STATES.contains(&step.state.as_str()))
    {
        return Classified {
            stage: Some(step.step.clone()),
            attention: Some(Attention::NeedsYou),
            reason: step.reason.clone(),
            detail: Some(step.state.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    let job = recording.job.as_ref();
    let job_state = job.map(|job| job.state.as_str());
    let error = job.and_then(|job| job.error.as_ref());
    if job_state == Some("cancelled") || error.is_some_and(|e| e.code == "cancelled") {
        return Classified::of(Phase::Cancelled);
    }
    if recording.status == "failed" || job_state == Some("failed") {
        let retryable = error.is_some_and(|e| e.retryable);
        return Classified {
            attention: (!retryable).then_some(Attention::TranscriptionFailed),
            detail: error.map(|e| e.code.clone()).filter(|c| !c.is_empty()),
            ..Classified::of(Phase::TranscriptionFailed)
        };
    }
    let summary = recording.summary_step();
    if let Some(step) = summary.filter(|step| step.state == "failed") {
        return Classified {
            attention: Some(Attention::SummaryFailed),
            reason: step.reason.clone(),
            ..Classified::of(Phase::SummaryFailed)
        };
    }
    match job_state {
        Some("queued") => return Classified::of(Phase::Queued),
        Some("running") => {
            return Classified {
                stage: job.and_then(|job| job.stage.clone()),
                progress: job.and_then(|job| job.progress),
                ..Classified::of(Phase::Transcribing)
            }
        }
        _ => {}
    }
    // Depois da transcrição: a etapa ativa, senão a primeira à espera.
    let running = recording
        .pipeline
        .iter()
        .find(|step| step.state == "active")
        .or_else(|| {
            recording
                .pipeline
                .iter()
                .find(|step| step.state == "pending")
        });
    if let Some(step) = running {
        return Classified {
            stage: Some(step.step.clone()),
            ..Classified::of(Phase::Processing)
        };
    }
    if let Some(step) = summary {
        match step.state.as_str() {
            "done" => return Classified::of(Phase::SummaryReady),
            "skipped" => {
                let actionable = step
                    .reason
                    .as_deref()
                    .is_some_and(|r| ACTIONABLE_NO_SUMMARY.contains(&r));
                return Classified {
                    attention: actionable.then_some(Attention::NoSummary),
                    reason: step.reason.clone(),
                    ..Classified::of(Phase::NoSummary)
                };
            }
            _ => {}
        }
    }
    match recording.status.as_str() {
        "transcribed" => Classified::of(Phase::Transcribed),
        "processing" => Classified::of(Phase::Processing),
        _ => Classified::of(Phase::Queued),
    }
}

/// O título dado ao parar, senão o que o servidor deu, senão o nome do arquivo importado.
fn local_title(recording: &QueuedRecording) -> String {
    recording
        .title
        .clone()
        .or_else(|| recording.server_title.clone())
        .or_else(|| recording.original_name.clone())
        .unwrap_or_default()
}

fn local_item(recording: &QueuedRecording) -> RecentItem {
    let (phase, attention) = match recording.status {
        Status::Recording => (Phase::Recording, None),
        Status::Pending => (Phase::Pending, None),
        Status::Syncing => (Phase::Uploading, None),
        Status::Failed => (Phase::UploadFailed, Some(Attention::UploadFailed)),
        Status::Synced => (Phase::Uploaded, None),
    };
    RecentItem {
        key: recording
            .remote_id
            .clone()
            .unwrap_or_else(|| format!("local:{}", recording.id)),
        remote_id: recording.remote_id.clone(),
        local_id: Some(recording.id.clone()),
        title: local_title(recording),
        started_at: Some(recording.started_at),
        created_at: None,
        duration_ms: recording.duration_ms,
        phase,
        stage: None,
        progress: None,
        attention,
        reason: None,
        detail: (recording.status == Status::Failed)
            .then(|| recording.last_error.clone())
            .flatten(),
        wait: None,
    }
}

fn remote_item(
    recording: &LibraryRecording,
    local: Option<&QueuedRecording>,
    wait: Option<&QueueWait>,
) -> RecentItem {
    let classified = classify(recording);
    let title = if recording.title.trim().is_empty() {
        local.map(local_title).unwrap_or_default()
    } else {
        recording.title.clone()
    };
    RecentItem {
        key: recording.id.clone(),
        remote_id: Some(recording.id.clone()),
        local_id: local.map(|rec| rec.id.clone()),
        title,
        started_at: local.map(|rec| rec.started_at),
        created_at: recording.created_at.clone(),
        duration_ms: local.and_then(|rec| rec.duration_ms),
        wait: (classified.phase == Phase::Queued)
            .then(|| wait.cloned())
            .flatten(),
        phase: classified.phase,
        stage: classified.stage,
        progress: classified.progress,
        attention: classified.attention,
        reason: classified.reason,
        detail: classified.detail,
    }
}

/// Junta a fila local (mais recente primeiro) e a página do servidor numa lista de no máximo
/// `count` linhas. As linhas locais ainda não enviadas vêm primeiro; uma enviada daqui que está
/// na página vira a linha do servidor. Sem leitura do servidor (`remote` `None`), as enviadas
/// aparecem como "Enviada".
pub fn build(
    local: &[QueuedRecording],
    remote: Option<&[LibraryRecording]>,
    waits: &BTreeMap<String, QueueWait>,
    count: u8,
) -> Vec<RecentItem> {
    let by_remote: HashMap<&str, &QueuedRecording> = local
        .iter()
        .filter_map(|rec| rec.remote_id.as_deref().map(|id| (id, rec)))
        .collect();
    let mut items: Vec<RecentItem> = local
        .iter()
        .filter(|rec| rec.status != Status::Synced || remote.is_none())
        .map(local_item)
        .collect();
    for recording in remote.unwrap_or_default() {
        let local = by_remote.get(recording.id.as_str()).copied();
        items.push(remote_item(recording, local, waits.get(&recording.id)));
    }
    items.truncate(usize::from(count));
    items
}

/// Quanto o laço espera até a próxima leitura.
pub fn interval(items: &[RecentItem], visible: bool) -> Duration {
    if visible && items.iter().any(|item| item.phase.in_progress()) {
        BUSY_INTERVAL
    } else {
        IDLE_INTERVAL
    }
}

/// A última leitura do servidor.
#[derive(Default)]
struct Snapshot {
    items: Option<Vec<LibraryRecording>>,
    fetched_at: Option<i64>,
    error: Option<String>,
}

/// O canal para cutucar o laço e a última leitura.
pub struct RecentHandle {
    tx: Mutex<Sender<()>>,
    snapshot: Mutex<Snapshot>,
}

/// Sobe a thread `eclume-recentes` e registra o canal no app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(RecentHandle {
        tx: Mutex::new(tx),
        snapshot: Mutex::new(Snapshot::default()),
    });
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-recentes".into())
        .spawn(move || {
            let mut wait = Duration::ZERO;
            while let Ok(()) | Err(RecvTimeoutError::Timeout) = rx.recv_timeout(wait) {
                while rx.try_recv().is_ok() {}
                if let Err(err) = fetch(&app) {
                    log::info!("recentes: {err:#}");
                }
                crate::refresh_ui(&app);
                let visible = app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                wait = view(&app)
                    .map(|view| interval(&view.items, visible))
                    .unwrap_or(IDLE_INTERVAL);
            }
        });
    if let Err(err) = spawned {
        log::error!("falha ao iniciar o painel de recentes: {err}");
    }
}

/// Pede uma leitura já (envio concluído, configurações salvas, a principal aberta).
pub fn nudge(app: &AppHandle) {
    if let Some(handle) = app.try_state::<RecentHandle>() {
        if let Ok(tx) = handle.tx.lock() {
            let _ = tx.send(());
        }
    }
}

/// Lê a página das recentes. Sem credencial ou com o painel escondido, não lê nada; a falha
/// fica em `error` e o último retrato segue valendo.
fn fetch(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let count = state.recent_count()?;
    let Some(config) = state.uploader_config()? else {
        return Ok(());
    };
    if count == 0 {
        return Ok(());
    }
    let result = Client::from_config(&config).and_then(|client| client.recent(u32::from(count)));
    let handle = app.state::<RecentHandle>();
    let mut snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    match result {
        Ok(items) => {
            snapshot.items = Some(items);
            snapshot.fetched_at = Some(now_ms());
            snapshot.error = None;
            Ok(())
        }
        Err(err) => {
            snapshot.error = Some(format!("{err:#}"));
            Err(err)
        }
    }
}

/// O painel como a janela o desenha.
pub fn view(app: &AppHandle) -> Result<RecentView> {
    let state = app.state::<AppState>();
    let count = state.recent_count()?;
    let local = state.recordings(u32::from(count))?;
    let waits = state.view()?.queue_waits;
    let handle = app.state::<RecentHandle>();
    let snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    let items = build(&local, snapshot.items.as_deref(), &waits, count);
    Ok(RecentView {
        count,
        needs_you: items.iter().filter(|item| item.attention.is_some()).count(),
        items,
        fetched_at: snapshot.fetched_at,
        error: snapshot.error.clone(),
    })
}

/// "Copiar resumo": põe o Markdown do resumo atual na área de transferência, o mesmo que o
/// "Copiar" do aviso de resumo pronto copia.
pub fn copy_summary(app: &AppHandle, recording_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let config = state
        .uploader_config()?
        .context("Entre para copiar o resumo")?;
    let summary = Client::from_config(&config)?
        .current_summary(recording_id)?
        .context("O resumo ainda não está pronto")?;
    app.clipboard()
        .write_text(summary.content_md)
        .map_err(|err| anyhow!("falha ao copiar o resumo: {err}"))
}

/// "Abrir no web": a página da gravação no eclume web.
pub fn open_recording(app: &AppHandle, recording_id: &str) -> Result<()> {
    let url = crate::sync::recording_url(&app.state::<AppState>().web_url()?, recording_id);
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use eclume_recorder::{Kind, RecordedAtSource, Source};
    use eclume_sync::api::{JobError, JobInfo, PipelineStepInfo};

    fn step(step: &str, state: &str, reason: Option<&str>) -> PipelineStepInfo {
        PipelineStepInfo {
            step: step.into(),
            state: state.into(),
            finished_at: None,
            reason: reason.map(str::to_string),
        }
    }

    fn remota(id: &str, status: &str) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: status.into(),
            recorded_at: None,
            created_at: Some("2026-10-05T12:00:00Z".into()),
            updated_at: None,
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: vec![],
            job: None,
        }
    }

    fn com_job(mut rec: LibraryRecording, job: JobInfo) -> LibraryRecording {
        rec.job = Some(job);
        rec
    }

    fn com_etapas(mut rec: LibraryRecording, etapas: Vec<PipelineStepInfo>) -> LibraryRecording {
        rec.pipeline = etapas;
        rec
    }

    fn job(state: &str) -> JobInfo {
        JobInfo {
            state: state.into(),
            ..JobInfo::default()
        }
    }

    fn local(id: &str, status: Status, started_at: i64, remote: Option<&str>) -> QueuedRecording {
        QueuedRecording {
            id: id.into(),
            path: std::path::PathBuf::from(format!("/tmp/{id}.ogg")),
            started_at,
            ended_at: None,
            duration_ms: Some(60_000),
            bytes: None,
            status,
            interrupted: false,
            attempts: 0,
            last_error: (status == Status::Failed).then(|| "servidor fora do ar".to_string()),
            remote_id: remote.map(str::to_string),
            upload_id: None,
            sha256: None,
            next_attempt_at: None,
            synced_at: None,
            purged_at: None,
            meeting_app: None,
            kind: Kind::Meeting,
            recorded_at_source: RecordedAtSource::Capture,
            source: Source::Desktop,
            original_name: None,
            content_type: None,
            title: None,
            agenda_type_id: None,
            details_pending: false,
            server_title: None,
            language: None,
        }
    }

    #[test]
    fn fase_de_cada_estado_do_servidor() {
        let fase = |rec: &LibraryRecording| classify(rec).phase;
        assert_eq!(
            fase(&com_job(remota("a", "queued"), job("queued"))),
            Phase::Queued
        );
        let transcrevendo = classify(&com_job(
            remota("b", "processing"),
            JobInfo {
                stage: Some("asr".into()),
                progress: Some(420),
                ..job("running")
            },
        ));
        assert_eq!(
            (
                transcrevendo.phase,
                transcrevendo.stage.as_deref(),
                transcrevendo.progress
            ),
            (Phase::Transcribing, Some("asr"), Some(420))
        );
        let resumindo = classify(&com_etapas(
            com_job(remota("c", "transcribed"), job("succeeded")),
            vec![
                step("transcription", "done", None),
                step("agenda_type", "done", None),
                step("summary", "active", None),
            ],
        ));
        assert_eq!(
            (resumindo.phase, resumindo.stage.as_deref()),
            (Phase::Processing, Some("summary"))
        );
        assert_eq!(
            fase(&com_etapas(
                remota("d", "transcribed"),
                vec![step("summary", "done", None)]
            )),
            Phase::SummaryReady
        );
        assert_eq!(fase(&remota("e", "transcribed")), Phase::Transcribed);
        assert_eq!(
            fase(&com_job(remota("f", "failed"), job("cancelled"))),
            Phase::Cancelled
        );
    }

    #[test]
    fn alertas_so_onde_a_pessoa_resolve() {
        let alerta = |rec: &LibraryRecording| classify(rec).attention;
        let falhou = |retryable| {
            com_job(
                remota("a", "failed"),
                JobInfo {
                    error: Some(JobError {
                        code: "engine_error".into(),
                        retryable,
                    }),
                    ..job("failed")
                },
            )
        };
        assert_eq!(alerta(&falhou(false)), Some(Attention::TranscriptionFailed));
        assert_eq!(
            classify(&falhou(false)).detail.as_deref(),
            Some("engine_error")
        );
        // Passageira: o servidor tenta de novo.
        assert_eq!(alerta(&falhou(true)), None);
        assert_eq!(
            alerta(&com_etapas(
                remota("b", "transcribed"),
                vec![step("summary", "failed", None)]
            )),
            Some(Attention::SummaryFailed)
        );
        let pulado = |motivo| {
            com_etapas(
                remota("c", "transcribed"),
                vec![step("summary", "skipped", Some(motivo))],
            )
        };
        assert_eq!(
            alerta(&pulado("no_agenda_type")),
            Some(Attention::NoSummary)
        );
        assert_eq!(classify(&pulado("no_provider")).phase, Phase::NoSummary);
        assert_eq!(alerta(&pulado("no_provider")), None);
        assert_eq!(alerta(&pulado("cancelled")), None);
    }

    #[test]
    fn estado_desconhecido_vira_precisa_de_voce_mesmo_com_o_resumo_pronto() {
        let etapa = classify(&com_etapas(
            remota("a", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "awaiting_speakers", Some("speakers_required")),
                step("summary", "done", None),
            ],
        ));
        assert_eq!(etapa.phase, Phase::Unknown);
        assert_eq!(etapa.attention, Some(Attention::NeedsYou));
        assert_eq!(etapa.stage.as_deref(), Some("speakers"));
        assert_eq!(etapa.detail.as_deref(), Some("awaiting_speakers"));
        assert_eq!(etapa.reason.as_deref(), Some("speakers_required"));

        let status = classify(&remota("b", "awaiting_speakers"));
        assert_eq!(
            (status.phase, status.attention, status.detail.as_deref()),
            (
                Phase::Unknown,
                Some(Attention::NeedsYou),
                Some("awaiting_speakers")
            )
        );
    }

    #[test]
    fn locutores_aguardando_viram_alerta_com_a_etapa_e_o_motivo() {
        let etapa = classify(&com_etapas(
            remota("w", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "waiting", Some("unnamed_speakers")),
                step("summary", "pending", None),
            ],
        ));
        assert_eq!(etapa.phase, Phase::Unknown);
        assert_eq!(etapa.attention, Some(Attention::NeedsYou));
        assert_eq!(etapa.stage.as_deref(), Some("speakers"));
        assert_eq!(etapa.detail.as_deref(), Some("waiting"));
        assert_eq!(etapa.reason.as_deref(), Some("unnamed_speakers"));
    }

    #[test]
    fn junta_a_fila_local_e_a_pagina_sem_duplicar_e_corta_em_n() {
        let fila = vec![
            local("l-gravando", Status::Recording, 500, None),
            local("l-falhou", Status::Failed, 400, None),
            local("l-enviada", Status::Synced, 300, Some("r1")),
            local("l-velha", Status::Synced, 100, Some("r-fora")),
        ];
        let pagina = vec![
            com_job(remota("r1", "queued"), job("queued")),
            com_etapas(
                remota("r2", "transcribed"),
                vec![step("summary", "done", None)],
            ),
            remota("r3", "transcribed"),
        ];
        let mut esperas = BTreeMap::new();
        esperas.insert(
            "r1".to_string(),
            QueueWait {
                reason: "gpu_busy".into(),
                ahead: Some(2),
                account_ahead: None,
                estimated_start_at: None,
                resumes_at: None,
                processor: None,
            },
        );
        let linhas = build(&fila, Some(pagina.as_slice()), &esperas, 4);
        assert_eq!(
            linhas.iter().map(|l| l.key.as_str()).collect::<Vec<_>>(),
            ["local:l-gravando", "local:l-falhou", "r1", "r2"]
        );
        assert_eq!(linhas[1].attention, Some(Attention::UploadFailed));
        assert_eq!(linhas[1].detail.as_deref(), Some("servidor fora do ar"));
        // A enviada daqui é a linha do servidor, com o id local e a espera na fila.
        assert_eq!(linhas[2].local_id.as_deref(), Some("l-enviada"));
        assert_eq!(linhas[2].wait.as_ref().map(|w| w.ahead), Some(Some(2)));
        assert_eq!(linhas[3].phase, Phase::SummaryReady);

        // Sem leitura do servidor, as enviadas aparecem como "Enviada".
        let sem_servidor = build(&fila, None, &BTreeMap::new(), 5);
        assert_eq!(sem_servidor.len(), 4);
        assert_eq!(sem_servidor[2].phase, Phase::Uploaded);
        assert_eq!(sem_servidor[2].key, "r1");

        assert!(build(&fila, Some(pagina.as_slice()), &esperas, 0).is_empty());
    }

    #[test]
    fn le_mais_vezes_so_com_a_janela_visivel_e_algo_em_andamento() {
        let fila = vec![local("l", Status::Pending, 1, None)];
        let andando = build(&fila, Some(&[][..]), &BTreeMap::new(), 5);
        assert_eq!(interval(&andando, true), BUSY_INTERVAL);
        assert_eq!(interval(&andando, false), IDLE_INTERVAL);
        let pronta = build(
            &[],
            Some(
                &[com_etapas(
                    remota("r", "transcribed"),
                    vec![step("summary", "done", None)],
                )][..],
            ),
            &BTreeMap::new(),
            5,
        );
        assert_eq!(interval(&pronta, true), IDLE_INTERVAL);
    }
}
