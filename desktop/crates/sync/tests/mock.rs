//! Integration with the contract v1 mock (Prism, `deploy/docker-compose.mock.yml`).
//!
//!     docker compose -f deploy/docker-compose.mock.yml up -d --wait
//!     ECLUME_MOCK_URL=http://127.0.0.1:4010 cargo test -p eclume-sync --test mock
//!
//! Without `ECLUME_MOCK_URL`, each case reports itself skipped. The part URLs in the fixtures point
//! to `127.0.0.1:4010`, so the mock must use that port on the test machine. The mock is static:
//! resume and retry are proven in protocol unit tests.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use eclume_recorder::{sync_pending, Kind, NewImport, Queue, RecordedAtSource, Status, SyncReport};
use eclume_sync::{
    Client, HttpRequest, HttpResponse, HttpUploader, RetryPolicy, Transport, UreqTransport,
    Watermark,
};

/// Recording and upload from the contract fixtures.
const RECORDING_ID: &str = "01928f3a-1c00-7a00-8000-000000000401";
const UPLOAD_ID: &str = "01928f3a-1c00-7a00-8000-000000000601";
/// Fixture file size: 3 parts of 8 MiB, the last one smaller.
const FIXTURE_SIZE: usize = 19_287_595;
const VERSION: &str = "eclume-desktop/0.1.0";
const PAT: &str = "eclp_mockmockmockmockmockmockmockmock";

fn mock_url() -> Option<String> {
    let url = std::env::var("ECLUME_MOCK_URL")
        .ok()
        .filter(|u| !u.is_empty());
    if url.is_none() {
        eprintln!("ECLUME_MOCK_URL missing: integration test skipped");
    }
    url
}

/// Real transport with a mock adjustment along the way: `Prefer: code=201` on `POST /uploads`, so
/// Prism simulates a new upload (without it, responds with 200 `deduplicated`), or without the PAT.
struct MockTransport {
    inner: UreqTransport,
    prefer_new_upload: bool,
    strip_pat: bool,
}

impl Transport for MockTransport {
    fn send(&self, mut request: HttpRequest) -> Result<HttpResponse> {
        if self.prefer_new_upload
            && request.method == "POST"
            && request.url.ends_with("/api/v1/uploads")
        {
            request = request.header("Prefer", "code=201");
        }
        if self.strip_pat {
            request.headers.retain(|(name, _)| name != "Authorization");
        }
        self.inner.send(request)
    }
}

fn client(base: &str, prefer_new_upload: bool, strip_pat: bool) -> Client {
    let transport = MockTransport {
        inner: UreqTransport::new(None, VERSION).unwrap(),
        prefer_new_upload,
        strip_pat,
    };
    Client::new(Arc::new(transport), base, PAT, RetryPolicy::default()).unwrap()
}

/// A queue with a `pending` Teams recording of `size` bytes.
fn queue_with_recording(name: &str, size: usize) -> (Arc<Mutex<Queue>>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("eclume-mock-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("g.ogg");
    let content: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, content).unwrap();
    let queue = Queue::open_in_memory().unwrap();
    queue
        .begin("g", &dir.join("g.ogg.part"), 1_758_733_205_000)
        .unwrap();
    queue
        .finish(
            "g",
            &path,
            1_758_733_371_000,
            166_000,
            i64::try_from(size).unwrap(),
        )
        .unwrap();
    queue.set_meeting_app("g", "teams").unwrap();
    (Arc::new(Mutex::new(queue)), dir)
}

#[test]
fn new_upload_completes() {
    let Some(base) = mock_url() else { return };
    let (queue, dir) = queue_with_recording("novo", FIXTURE_SIZE);
    let uploader =
        HttpUploader::from_client(client(&base, true, false), Arc::clone(&queue), VERSION);

    let report = sync_pending(&queue, &uploader).unwrap();
    let queue = queue.lock().unwrap();
    let recording = queue.get("g").unwrap().unwrap();
    assert_eq!(
        report,
        SyncReport {
            synced: 1,
            failed: 0
        },
        "{:?}",
        recording.last_error
    );
    assert_eq!(recording.status, Status::Synced);
    assert_eq!(recording.remote_id.as_deref(), Some(RECORDING_ID));
    assert_eq!(recording.upload_id.as_deref(), Some(UPLOAD_ID));
    assert_eq!(recording.sha256.as_deref().map(str::len), Some(64));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn deduplicated_upload() {
    let Some(base) = mock_url() else { return };
    let (queue, dir) = queue_with_recording("dedup", 1024);
    let uploader =
        HttpUploader::from_client(client(&base, false, false), Arc::clone(&queue), VERSION);

    let report = sync_pending(&queue, &uploader).unwrap();
    assert_eq!(
        report,
        SyncReport {
            synced: 1,
            failed: 0
        }
    );
    let queue = queue.lock().unwrap();
    let recording = queue.get("g").unwrap().unwrap();
    assert_eq!(recording.remote_id.as_deref(), Some(RECORDING_ID));
    // Deduplication does not open an upload: nothing to resume.
    assert_eq!(recording.upload_id, None);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Prism validates the body against the contract: a request outside it returns 422 and the
/// recording fails.
fn assert_synced(queue: &Arc<Mutex<Queue>>, id: &str, report: SyncReport) {
    let queue = queue.lock().unwrap();
    let recording = queue.get(id).unwrap().unwrap();
    assert_eq!(
        report,
        SyncReport {
            synced: 1,
            failed: 0
        },
        "{:?}",
        recording.last_error
    );
    assert_eq!(recording.remote_id.as_deref(), Some(RECORDING_ID));
}

#[test]
fn voice_note_with_markers_passes_contract() {
    let Some(base) = mock_url() else { return };
    let (queue, dir) = queue_with_recording("nota", 1024);
    {
        let queue = queue.lock().unwrap();
        queue.set_kind("g", Kind::Note).unwrap();
        queue.add_marker("g", 4_000, Some("decisão")).unwrap();
        queue.add_marker("g", 9_500, None).unwrap();
    }
    let uploader =
        HttpUploader::from_client(client(&base, false, false), Arc::clone(&queue), VERSION);

    let report = sync_pending(&queue, &uploader).unwrap();
    assert_synced(&queue, "g", report);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn copied_import_passes_contract() {
    let Some(base) = mock_url() else { return };
    let dir = std::env::temp_dir().join(format!("eclume-mock-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("i.avi");
    std::fs::write(&path, vec![7u8; 1024]).unwrap();
    let queue = Queue::open_in_memory().unwrap();
    queue
        .begin_import(&NewImport {
            id: "i",
            path: &path,
            recorded_at: 1_758_733_205_000,
            recorded_at_source: RecordedAtSource::User,
            original_name: "kickoff-guion",
            content_type: Some("video/x-msvideo"),
            duration_ms: 2_820_000,
            bytes: 1024,
        })
        .unwrap();
    let queue = Arc::new(Mutex::new(queue));
    let uploader =
        HttpUploader::from_client(client(&base, false, false), Arc::clone(&queue), VERSION);

    let report = sync_pending(&queue, &uploader).unwrap();
    assert_synced(&queue, "i", report);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn missing_pat_returns_401() {
    let Some(base) = mock_url() else { return };
    let (queue, dir) = queue_with_recording("401", 1024);
    let uploader =
        HttpUploader::from_client(client(&base, false, true), Arc::clone(&queue), VERSION);

    let report = sync_pending(&queue, &uploader).unwrap();
    assert_eq!(
        report,
        SyncReport {
            synced: 0,
            failed: 1
        }
    );
    let queue = queue.lock().unwrap();
    let recording = queue.get("g").unwrap().unwrap();
    assert_eq!(recording.status, Status::Failed);
    let error = recording.last_error.unwrap();
    assert!(error.contains("401"), "{error}");
    assert!(recording.next_attempt_at.is_some());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn pat_check_against_mock() {
    let Some(base) = mock_url() else { return };
    client(&base, false, false).check().unwrap();
    assert!(client(&base, false, true).check().is_err());
}

#[test]
fn mock_since_listing_feeds_watermark() {
    let Some(base) = mock_url() else { return };
    let items = client(&base, false, false)
        .library(Some("2026-01-01T00:00:00Z"))
        .unwrap();
    // The contract example ends before the watermark: no retroactive notification.
    let mut mark = Watermark::starting(chrono::Utc::now());
    assert!(mark.take(&items).is_empty());
}
