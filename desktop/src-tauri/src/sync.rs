//! Laço de sync: a cada 30 s, ou quando cutucado (gravação encerrada, configurações salvas,
//! "Sincronizar agora"), devolve à fila as falhas cujo backoff venceu, sobe as `pending` pelo
//! `HttpUploader` e aplica a retenção — o arquivo local só sai depois da confirmação do servidor.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_recorder::{now_ms, sync_pending, Queue, Status};
use eclume_sync::HttpUploader;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const INTERVAL: Duration = Duration::from_secs(30);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
            while let Ok(()) | Err(RecvTimeoutError::Timeout) = rx.recv_timeout(INTERVAL) {
                // Vários cutucões seguidos valem uma passada só.
                while rx.try_recv().is_ok() {}
                if let Err(err) = run_once(&app) {
                    log::error!("falha no sync: {err:#}");
                }
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
                        state.set_syncing(true)?;
                        crate::refresh_ui(app);
                        let report = sync_pending(state.queue(), &uploader);
                        state.set_syncing(false)?;
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
