//! Laço de sync: a cada 30 s, ou quando cutucado (gravação encerrada, configurações salvas,
//! "Sincronizar agora"), devolve à fila as falhas cujo backoff venceu, sobe as `pending` pelo
//! `HttpUploader` e aplica a retenção — o arquivo local só sai depois da confirmação do servidor.
//! Depois, no máximo a cada minuto, lê as gravações da conta que mudaram (`?since=`) e avisa o fim
//! do processamento de cada uma (resumo pronto, resumo que falhou, pronta sem resumo, transcrição
//! que falhou), guarda o título que o servidor deu às enviadas daqui e a espera na fila delas.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_recorder::{now_ms, sync_pending, Queue, QueuedRecording, Status};
use eclume_sync::{Client, Ended, HttpUploader, Outcome, Watermark};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const INTERVAL: Duration = Duration::from_secs(30);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Intervalo mínimo entre duas leituras dos desfechos no servidor.
const OUTCOMES_EVERY_MS: i64 = 60 * 1000;
/// A marca d'água do aviso de desfechos ([`Watermark`]), no diretório de dados. O nome é o do
/// antigo aviso de resumo pronto; o formato antigo (id → instante) não lê como marca e recomeça.
const NOTIFIED_FILE: &str = "resumos-avisados.json";

static LAST_OUTCOMES_CHECK: AtomicI64 = AtomicI64::new(0);

/// Sem credencial, as gravações esperam o próximo login.
fn sign_in_to_send(pending: u32) -> String {
    match pending {
        1 => "Entre para enviar 1 gravação".into(),
        n => format!("Entre para enviar {n} gravações"),
    }
}

/// O canal para cutucar o laço.
pub struct SyncHandle(Mutex<Sender<()>>);

/// Sobe a thread do sync e registra o canal no app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(SyncHandle(Mutex::new(tx)));
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-sync".into())
        .spawn(move || {
            // Acorda a cada `INTERVAL` ou a cada cutucão; termina quando o app fecha o canal.
            let mut backoff = crate::supervise::Backoff::default();
            while let Ok(()) | Err(RecvTimeoutError::Timeout) = rx.recv_timeout(INTERVAL) {
                // Vários cutucões seguidos valem uma passada só.
                while rx.try_recv().is_ok() {}
                crate::supervise::pass(&mut backoff, "sync", || {
                    if let Err(err) = run_once(&app) {
                        log::error!("falha no sync: {err:#}");
                    }
                });
                crate::refresh_ui(&app);
            }
        });
    if let Err(err) = spawned {
        log::error!("falha ao iniciar o sync: {err}");
    }
}

/// Pede uma passada de sync já.
pub fn nudge(app: &AppHandle) {
    if let Some(handle) = app.try_state::<SyncHandle>() {
        if let Ok(tx) = handle.0.lock() {
            let _ = tx.send(());
        }
    }
}

/// "Sincronizar agora": as falhas voltam à fila sem esperar o backoff.
pub fn sync_now(app: &AppHandle) -> Result<()> {
    lock(app.state::<AppState>().queue())?.retry_failed(i64::MAX)?;
    nudge(app);
    Ok(())
}

fn lock(queue: &Mutex<Queue>) -> Result<std::sync::MutexGuard<'_, Queue>> {
    queue
        .lock()
        .map_err(|_| anyhow!("fila envenenada por um pânico"))
}

fn run_once(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let pending = {
        let queue = lock(state.queue())?;
        queue.retry_due(now_ms(), i64::MAX)?;
        queue.counts()?.pending
    };
    if pending > 0 {
        match state.uploader_config()? {
            None if state.pinned_ca_changed()? => {}
            None => state.set_sync_notice(Some(sign_in_to_send(pending)))?,
            Some(config) => {
                let uploader = HttpUploader::new(&config, state.shared_queue())
                    .map(|uploader| uploader.with_language(state.language().ok().flatten()));
                let notice = match uploader {
                    Ok(uploader) => {
                        let syncing = state.syncing();
                        crate::refresh_ui(app);
                        let report = sync_pending(state.queue(), &uploader);
                        drop(syncing);
                        let report = report?;
                        log::info!("sync: {report:?}");
                        (report.failed > 0)
                            .then(|| last_failure(state.queue()))
                            .transpose()?
                            .flatten()
                    }
                    Err(err) => Some(format!("{err:#}")),
                };
                let failed = notice.is_some();
                state.set_sync_notice(notice.map(|err| format!("Falha ao sincronizar: {err}")))?;
                if failed {
                    check_pinned_ca(&state)?;
                }
            }
        }
    }
    // Retenção lida antes de travar a fila: a ordem dos locks é sempre estado → fila.
    let retention_days = state.retention_days()?;
    apply_retention(&*lock(state.queue())?, retention_days, now_ms())?;
    if let Err(err) = check_outcomes(app, &state) {
        log::info!("desfechos: {err:#}");
    }
    Ok(())
}

/// Lê as gravações da conta que mudaram desde a marca d'água: avisa cada desfecho novo (se o
/// aviso está ligado), guarda o título do servidor das enviadas daqui e lê a espera na fila das
/// enviadas nas últimas 24 h ainda sem desfecho. Sem marca (a primeira abertura, ou o arquivo do
/// formato antigo), nada anterior a agora é avisado: a atualização não dispara uma rajada.
fn check_outcomes(app: &AppHandle, state: &AppState) -> Result<()> {
    let now = now_ms();
    if now - LAST_OUTCOMES_CHECK.load(Ordering::Relaxed) < OUTCOMES_EVERY_MS {
        return Ok(());
    }
    LAST_OUTCOMES_CHECK.store(now, Ordering::Relaxed);
    let Some(config) = state.uploader_config()? else {
        return Ok(());
    };
    let client = Client::from_config(&config)?;
    let path = state.data_dir().join(NOTIFIED_FILE);
    let mut mark = load_mark(&path).unwrap_or_else(|| Watermark::starting_ms(now));
    let items = client.library(Some(&mark.since))?;
    let ended = mark.take(&items);
    let mut changed = false;
    {
        let queue = lock(state.queue())?;
        for item in items.iter().filter(|item| !item.title.trim().is_empty()) {
            changed |= queue.set_server_title(&item.id, &item.title)?;
        }
    }
    if state.notify_summary()? && !ended.is_empty() {
        announce(app, &client, &state.web_url()?, &ended);
    }
    save_mark(&path, &mark)?;

    let synced = lock(state.queue())?.by_status(Status::Synced)?;
    let mut waits = BTreeMap::new();
    for remote_id in wait_candidates(&synced, &mark, now) {
        match client.queue_wait(&remote_id) {
            Ok(Some(wait)) => {
                waits.insert(remote_id, wait);
            }
            Ok(None) => {}
            // Servidor fora: a próxima volta tenta de novo.
            Err(err) => {
                log::info!("espera de {remote_id}: {err:#}");
                break;
            }
        }
    }
    if state.set_queue_waits(waits)? || changed {
        crate::refresh_ui(app);
    }
    Ok(())
}

/// Um aviso por desfecho, ou um agrupado quando passam de [`crate::notify::GROUP_ABOVE`]. O
/// resumo pronto lê o Markdown para o "Copiar"; sem ele, o aviso sai só com "Abrir".
fn announce(app: &AppHandle, client: &Client, web_url: &str, ended: &[Ended]) {
    if ended.len() > crate::notify::GROUP_ABOVE {
        let library = format!("{}/", web_url.trim_end_matches('/'));
        crate::notify::outcomes_grouped(app, ended.len(), library);
        return;
    }
    for item in ended {
        let markdown = (item.outcome == Outcome::SummaryReady)
            .then(|| match client.current_summary(&item.recording_id) {
                Ok(summary) => summary.map(|summary| summary.content_md),
                Err(err) => {
                    log::info!("resumo de {}: {err:#}", item.recording_id);
                    None
                }
            })
            .flatten();
        let url = recording_url(web_url, &item.recording_id);
        crate::notify::outcome(app, item, markdown, url);
    }
}

/// As gravações enviadas daqui nas últimas 24 h ainda sem desfecho: a espera na fila delas.
fn wait_candidates(synced: &[QueuedRecording], mark: &Watermark, now: i64) -> Vec<String> {
    synced
        .iter()
        .filter(|rec| rec.synced_at.is_some_and(|at| now - at < DAY_MS))
        .filter_map(|rec| rec.remote_id.clone())
        .filter(|id| !mark.notified.contains_key(id))
        .collect()
}

/// A página da gravação no eclume web.
fn recording_url(web_url: &str, remote_id: &str) -> String {
    format!("{}/gravacoes/{remote_id}", web_url.trim_end_matches('/'))
}

/// `None` quando o arquivo não existe, é ilegível ou é do formato antigo: recomeça da marca.
fn load_mark(path: &Path) -> Option<Watermark> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_mark(path: &Path, mark: &Watermark) -> Result<()> {
    std::fs::write(path, serde_json::to_vec(mark)?)?;
    Ok(())
}

/// Depois de uma falha, confere se a CA fixada ainda é a do servidor; se mudou, o sync para e a
/// janela volta à primeira execução ("O certificado do servidor mudou").
fn check_pinned_ca(state: &AppState) -> Result<()> {
    let Some((web_url, pinned)) = state.pinned_ca()? else {
        return Ok(());
    };
    match crate::account::ca_changed(&crate::account::RealNet, &web_url, &pinned) {
        Ok(true) => state.mark_ca_changed(),
        Ok(false) => Ok(()),
        Err(err) => {
            log::info!("não deu para conferir a CA do servidor: {err:#}");
            Ok(())
        }
    }
}

/// O erro da falha mais recente, para a janela.
fn last_failure(queue: &Mutex<Queue>) -> Result<Option<String>> {
    Ok(lock(queue)?
        .by_status(Status::Failed)?
        .into_iter()
        .last()
        .and_then(|rec| rec.last_error))
}

/// Apaga o arquivo local das gravações confirmadas há mais de `retention_days` dias (`None`:
/// nunca). A linha fica na fila com `purged_at`. Devolve quantas apagou.
pub fn apply_retention(queue: &Queue, retention_days: Option<u32>, now: i64) -> Result<usize> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let cutoff = now - i64::from(days) * DAY_MS;
    let mut purged = 0;
    for recording in queue.purge_candidates(cutoff)? {
        match std::fs::remove_file(&recording.path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                log::warn!("falha ao apagar {}: {err}", recording.path.display());
                continue;
            }
        }
        queue.mark_purged(&recording.id, now)?;
        purged += 1;
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn synced(queue: &mut Queue, id: &str, path: &Path) {
        std::fs::write(path, b"ogg").unwrap();
        queue.begin(id, &path.with_extension("part"), 1).unwrap();
        queue.finish(id, path, 2, 1, 3).unwrap();
        queue.claim_next().unwrap().unwrap();
        queue.mark_synced(id, &format!("srv-{id}")).unwrap();
    }

    #[test]
    fn retencao_apaga_so_depois_do_prazo_e_so_o_confirmado() {
        let dir = std::env::temp_dir().join(format!("eclume-retencao-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        let confirmed = dir.join("a.ogg");
        synced(&mut queue, "a", &confirmed);
        let pending = dir.join("b.ogg");
        std::fs::write(&pending, b"ogg").unwrap();
        queue.begin("b", &dir.join("b.part"), 3).unwrap();
        queue.finish("b", &pending, 4, 1, 3).unwrap();

        let now = now_ms();
        assert_eq!(
            apply_retention(&queue, None, now + 365 * DAY_MS).unwrap(),
            0
        );
        assert_eq!(apply_retention(&queue, Some(7), now).unwrap(), 0);
        assert!(confirmed.exists());
        assert_eq!(
            apply_retention(&queue, Some(7), now + 8 * DAY_MS).unwrap(),
            1
        );
        assert!(!confirmed.exists());
        assert!(
            pending.exists(),
            "gravação não confirmada nunca sai do disco"
        );
        assert!(queue.get("a").unwrap().unwrap().purged_at.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn espera_so_das_enviadas_nas_ultimas_24_h_sem_desfecho_e_marca_no_arquivo() {
        let dir = std::env::temp_dir().join(format!("eclume-desfechos-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        synced(&mut queue, "a", &dir.join("a.ogg"));
        synced(&mut queue, "b", &dir.join("b.ogg"));
        let recs = queue.by_status(Status::Synced).unwrap();
        let now = now_ms();

        let mut mark = Watermark::starting_ms(now);
        let mut ids = wait_candidates(&recs, &mark, now);
        ids.sort();
        assert_eq!(ids, ["srv-a", "srv-b"]);
        mark.notified.insert("srv-a".into(), mark.mark.clone());
        assert_eq!(wait_candidates(&recs, &mark, now), ["srv-b"]);
        assert!(wait_candidates(&recs, &mark, now + DAY_MS).is_empty());

        assert!(queue.set_server_title("srv-a", "Alinhamento").unwrap());
        assert_eq!(
            queue.get("a").unwrap().unwrap().server_title.as_deref(),
            Some("Alinhamento")
        );

        let path = dir.join(NOTIFIED_FILE);
        assert_eq!(load_mark(&path), None, "sem arquivo, a primeira abertura");
        save_mark(&path, &mark).unwrap();
        assert_eq!(load_mark(&path), Some(mark));
        // O formato antigo (id → instante) recomeça da marca: nada retroativo.
        std::fs::write(&path, br#"{"srv-a": 1727780000000}"#).unwrap();
        assert_eq!(load_mark(&path), None);
        assert_eq!(
            recording_url("https://192.168.15.199:8443/", "srv-a"),
            "https://192.168.15.199:8443/gravacoes/srv-a"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sem_credencial_as_gravacoes_esperam_o_login() {
        assert_eq!(sign_in_to_send(1), "Entre para enviar 1 gravação");
        assert_eq!(sign_in_to_send(2), "Entre para enviar 2 gravações");
    }

    #[test]
    fn retencao_zero_apaga_logo_e_tolera_arquivo_sumido() {
        let dir = std::env::temp_dir().join(format!("eclume-retencao0-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        let path = dir.join("c.ogg");
        synced(&mut queue, "c", &path);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(apply_retention(&queue, Some(0), now_ms() + 1).unwrap(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
