//! App extension points: recording uploads and meeting detection. This holds the contracts and
//! sync loop over the queue; the actual implementations are `HttpUploader` from `eclume-sync`
//! (HTTP with the account credential) and `DebouncedDetector` from `eclume-detect` (mic and
//! process).

use std::sync::Mutex;

use anyhow::{anyhow, Result};

use crate::queue::{Queue, QueuedRecording};

/// Uploads a recording to the eclume server and returns its remote id.
pub trait Uploader: Send + Sync {
    fn upload(&self, recording: &QueuedRecording) -> Result<String>;
}

/// Change observed by the meeting detector.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeetingEvent {
    /// A meeting started; `app` identifies the program (Teams, Meet, Zoom...).
    Started { app: String },
    /// The current meeting ended.
    Ended,
}

/// Meeting detector, polled periodically by the app.
pub trait MeetingDetector: Send {
    /// Returns the next event, if any; does not block.
    fn poll(&mut self) -> Option<MeetingEvent>;
}

/// Sync was interrupted intentionally (the eclume network went down, the system stopped the
/// sync job): this is not a recording failure. Any transport can return it; the HTTP client
/// does not retry it, and [`sync_pending`] returns the recording to `pending` without spending
/// an attempt and ends the pass. Only mobile triggers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncInterrupted;

impl std::fmt::Display for SyncInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("sync interrompido")
    }
}

impl std::error::Error for SyncInterrupted {}

/// Whether the error chain contains a [`SyncInterrupted`].
pub fn is_interrupted(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<SyncInterrupted>())
}

/// Result of a sync pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub synced: usize,
    pub failed: usize,
}

/// Syncs the queue's `pending` recordings one at a time. Each failure is recorded on its
/// recording and does not interrupt the others; failures return to the queue through
/// [`Queue::retry_due`], after the backoff scheduled by [`Queue::mark_failed`]. A
/// [`SyncInterrupted`] in the error chain returns the recording to `pending`
/// ([`Queue::release_claim`]) and ends the pass.
pub fn sync_pending(queue: &Mutex<Queue>, uploader: &dyn Uploader) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    loop {
        let claimed = lock(queue)?.claim_next()?;
        let Some(recording) = claimed else {
            return Ok(report);
        };
        // Upload runs without holding the queue, keeping the UI and recorder free.
        match uploader.upload(&recording) {
            Ok(remote_id) => {
                lock(queue)?.mark_synced(&recording.id, &remote_id)?;
                report.synced += 1;
            }
            Err(err) if is_interrupted(&err) => {
                lock(queue)?.release_claim(&recording.id)?;
                log::info!("sync interrupted; {} returns to the queue", recording.id);
                return Ok(report);
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

    /// Uploads the first and is interrupted on the second.
    struct InterruptedUploader;

    impl Uploader for InterruptedUploader {
        fn upload(&self, recording: &QueuedRecording) -> Result<String> {
            if recording.id == "segunda" {
                Err(anyhow::Error::new(SyncInterrupted).context("PUT da parte 2"))
            } else {
                Ok(format!("srv-{}", recording.id))
            }
        }
    }

    #[test]
    fn interrupted_sync_returns_recording_without_spending_attempt() {
        let queue = Queue::open_in_memory().unwrap();
        for (i, id) in ["primeira", "segunda", "terceira"].iter().enumerate() {
            let started = i as i64;
            queue
                .begin(id, Path::new("/tmp/x.ogg.part"), started)
                .unwrap();
            queue
                .finish(id, Path::new("/tmp/x.ogg"), started + 1, 1, 1)
                .unwrap();
        }
        let queue = Mutex::new(queue);

        let report = sync_pending(&queue, &InterruptedUploader).unwrap();
        assert_eq!(
            report,
            SyncReport {
                synced: 1,
                failed: 0
            }
        );
        let queue = queue.into_inner().unwrap();
        let second = queue.get("segunda").unwrap().unwrap();
        assert_eq!(second.status, Status::Pending);
        assert_eq!(second.attempts, 0);
        assert_eq!(second.last_error, None);
        // The pass stopped: the third was never attempted.
        let third = queue.get("terceira").unwrap().unwrap();
        assert_eq!((third.status, third.attempts), (Status::Pending, 0));
    }

    #[test]
    fn session_sync_uses_queue_and_isolates_failures() {
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
        let bad = queue.get("ruim-1").unwrap().unwrap();
        assert_eq!(bad.status, Status::Failed);
        assert_eq!(bad.last_error.as_deref(), Some("servidor recusou"));
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
    fn session_detector_delivers_events_in_order() {
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
