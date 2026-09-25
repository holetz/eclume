//! Pontos de extensão para a spec `desktop-deteccao-e-sync`: o upload das gravações e a
//! detecção de reuniões. Esta spec só define os contratos e o laço de sync sobre a fila; as
//! implementações reais (HTTP por PAT, heurística de processo e mic) chegam lá.

use std::sync::Mutex;

use anyhow::{anyhow, Result};

use crate::queue::{Queue, QueuedRecording};

/// Envia uma gravação ao servidor do eclume e devolve o id remoto dela.
pub trait Uploader: Send + Sync {
    fn upload(&self, recording: &QueuedRecording) -> Result<String>;
}

/// Mudança observada pelo detector de reuniões.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeetingEvent {
    /// Uma reunião começou; `app` identifica o programa (Teams, Meet, Zoom...).
    Started { app: String },
    /// A reunião em curso terminou.
    Ended,
}

/// Detector de reuniões, consultado periodicamente pelo app.
pub trait MeetingDetector: Send {
    /// Devolve o próximo evento, se houver; não bloqueia.
    fn poll(&mut self) -> Option<MeetingEvent>;
}

/// Resultado de uma passada de sync.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub synced: usize,
    pub failed: usize,
}

/// Sincroniza, uma a uma, as gravações `pending` da fila. Cada falha fica registrada na própria
/// gravação e não interrompe as demais; as falhas voltam à fila por [`Queue::retry_failed`].
pub fn sync_pending(queue: &Mutex<Queue>, uploader: &dyn Uploader) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    loop {
        let claimed = lock(queue)?.claim_next()?;
        let Some(recording) = claimed else {
            return Ok(report);
        };
        // O upload roda sem segurar a fila, para a UI e o gravador seguirem livres.
        match uploader.upload(&recording) {
            Ok(remote_id) => {
                lock(queue)?.mark_synced(&recording.id, &remote_id)?;
                report.synced += 1;
            }
            Err(err) => {
                lock(queue)?.mark_failed(&recording.id, &format!("{err:#}"))?;
                report.failed += 1;
            }
        }
    }
}

fn lock(queue: &Mutex<Queue>) -> Result<std::sync::MutexGuard<'_, Queue>> {
    queue
        .lock()
        .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::queue::Status;

    struct FlakyUploader;

    impl Uploader for FlakyUploader {
        fn upload(&self, recording: &QueuedRecording) -> Result<String> {
            if recording.id.starts_with("ruim") {
                Err(anyhow!("servidor recusou"))
            } else {
                Ok(format!("srv-{}", recording.id))
            }
        }
    }

    #[test]
    fn session_sync_passa_pela_fila_e_isola_falhas() {
        let queue = Queue::open_in_memory().unwrap();
        for (i, id) in ["boa-1", "ruim-1", "boa-2"].iter().enumerate() {
            let started = i as i64;
            queue
                .begin(id, Path::new("/tmp/x.ogg.part"), started)
                .unwrap();
            queue
                .finish(id, Path::new("/tmp/x.ogg"), started + 1, 1, 1)
                .unwrap();
        }
        let queue = Mutex::new(queue);

        let report = sync_pending(&queue, &FlakyUploader).unwrap();
        assert_eq!(
            report,
            SyncReport {
                synced: 2,
                failed: 1
            }
        );

        let queue = queue.into_inner().unwrap();
        let ruim = queue.get("ruim-1").unwrap().unwrap();
        assert_eq!(ruim.status, Status::Failed);
        assert_eq!(ruim.last_error.as_deref(), Some("servidor recusou"));
        assert_eq!(
            queue.get("boa-2").unwrap().unwrap().remote_id.as_deref(),
            Some("srv-boa-2")
        );
    }

    struct ScriptedDetector(Vec<MeetingEvent>);

    impl MeetingDetector for ScriptedDetector {
        fn poll(&mut self) -> Option<MeetingEvent> {
            if self.0.is_empty() {
                None
            } else {
                Some(self.0.remove(0))
            }
        }
    }

    #[test]
    fn session_detector_entrega_eventos_em_ordem() {
        let mut detector: Box<dyn MeetingDetector> = Box::new(ScriptedDetector(vec![
            MeetingEvent::Started {
                app: "teams".into(),
            },
            MeetingEvent::Ended,
        ]));
        assert_eq!(
            detector.poll(),
            Some(MeetingEvent::Started {
                app: "teams".into()
            })
        );
        assert_eq!(detector.poll(), Some(MeetingEvent::Ended));
        assert_eq!(detector.poll(), None);
    }
}
