//! `HttpUploader`: the real `Uploader` implementation from `eclume-recorder`. Computes `sha256`
//! once, saves it and the active upload in the queue (for resuming) and uploads through [`Client`].

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{anyhow, Context, Result};
use chrono::{Local, SecondsFormat, TimeZone, Utc};
use eclume_recorder::{Kind, Marker, Queue, QueuedRecording, Source, Uploader};
use sha2::{Digest, Sha256};

use crate::api::{Capture, MarkerInput, UploadCreate};
use crate::protocol::Client;
use crate::transport::TrustMode;

/// The file type the desktop records (Ogg/Opus mono 16 kHz), used for rows without `content_type`.
pub const CONTENT_TYPE: &str = "audio/ogg; codecs=opus";

/// What the uploader needs to know beyond the queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploaderConfig {
    /// API address (`https://host:8443`), without `/api/v1`.
    pub api_url: String,
    pub pat: String,
    /// What TLS trusts: the pinned CA (`Pinned`), a manually chosen CA or none (`PlatformPlus`).
    pub trust: TrustMode,
    /// `eclume-desktop/<version>`.
    pub client_version: String,
}

pub struct HttpUploader {
    client: Client,
    queue: Arc<Mutex<Queue>>,
    client_version: String,
    device_name: Option<String>,
    language: Option<String>,
}

impl HttpUploader {
    pub fn new(config: &UploaderConfig, queue: Arc<Mutex<Queue>>) -> Result<Self> {
        let client = Client::from_config(config)?;
        Ok(Self::from_client(client, queue, &config.client_version))
    }

    /// Uses an existing client (custom transport: the phone's pinned CA, or tests).
    pub fn from_client(client: Client, queue: Arc<Mutex<Queue>>, client_version: &str) -> Self {
        Self {
            client,
            queue,
            client_version: client_version.to_string(),
            device_name: Some(crate::device_name()),
            language: None,
        }
    }

    /// Changes `capture.device_name` (the device model on the phone).
    pub fn with_device_name(mut self, device_name: impl Into<String>) -> Self {
        self.device_name = Some(device_name.into());
        self
    }

    /// The device's transcript language, for recordings without their own language; `None` leaves
    /// the account's language.
    pub fn with_language(mut self, language: Option<String>) -> Self {
        self.language = language;
        self
    }

    fn lock(&self) -> Result<MutexGuard<'_, Queue>> {
        self.queue
            .lock()
            .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
    }

    fn create_request(
        &self,
        recording: &QueuedRecording,
        markers: &[Marker],
        size: u64,
        sha256: String,
    ) -> UploadCreate {
        UploadCreate {
            filename: filename(recording),
            content_type: recording
                .content_type
                .clone()
                .unwrap_or_else(|| CONTENT_TYPE.to_string()),
            size_bytes: size,
            sha256,
            title: recording.title.clone(),
            recorded_at: Utc
                .timestamp_millis_opt(recording.started_at)
                .single()
                .map(|at| at.to_rfc3339_opts(SecondsFormat::Secs, true)),
            recorded_at_source: recording.recorded_at_source,
            kind: recording.kind,
            agenda_type_id: recording.agenda_type_id.clone(),
            markers: markers
                .iter()
                .map(|marker| MarkerInput {
                    client_id: marker.client_id.clone(),
                    at_ms: u64::try_from(marker.at_ms).unwrap_or(0),
                    note: marker.note.clone(),
                })
                .collect(),
            duration_ms: recording.duration_ms.and_then(|ms| u64::try_from(ms).ok()),
            // The recording's language, otherwise the device's; with neither, the server account's
            // applies.
            language: recording.language.clone().or_else(|| self.language.clone()),
            source: recording.source,
            capture: Capture {
                meeting_app: recording.meeting_app.clone(),
                device_name: self.device_name.clone(),
                client_version: self.client_version.clone(),
            },
        }
    }
}

impl Uploader for HttpUploader {
    fn upload(&self, recording: &QueuedRecording) -> Result<String> {
        let size = std::fs::metadata(&recording.path)
            .with_context(|| format!("falha ao ler {}", recording.path.display()))?
            .len();
        let sha256 = match &recording.sha256 {
            Some(sha256) => sha256.clone(),
            None => {
                let sha256 = sha256_file(&recording.path)?;
                self.lock()?.set_upload_state(
                    &recording.id,
                    recording.upload_id.as_deref(),
                    Some(&sha256),
                )?;
                sha256
            }
        };
        let markers = self.lock()?.markers(&recording.id)?;
        let create = self.create_request(recording, &markers, size, sha256.clone());
        let uploaded = self.client.upload(
            &recording.path,
            &create,
            recording.upload_id.as_deref(),
            &mut |upload_id| {
                self.lock()?
                    .set_upload_state(&recording.id, upload_id, Some(&sha256))
            },
        )?;
        if uploaded.deduplicated {
            log::info!(
                "recording {} was already on the server ({})",
                recording.id,
                uploaded.recording_id
            );
        }
        Ok(uploaded.recording_id)
    }
}

/// The name from which the server derives the title. An import uses the original name with the
/// uploaded file's extension (`kickoff-guion.ogg`); an app recording uses
/// `2026-09-24 14-00 Teams.ogg` or `2026-09-26 10-42 nota.ogg`, in local time, as the browser names
/// it.
pub fn filename(recording: &QueuedRecording) -> String {
    if let (Source::Upload, Some(name)) = (recording.source, &recording.original_name) {
        let ext = recording
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("ogg");
        return format!("{name}.{ext}");
    }
    let when = Local
        .timestamp_millis_opt(recording.started_at)
        .single()
        .map_or_else(
            || recording.id.clone(),
            |at| at.format("%Y-%m-%d %H-%M").to_string(),
        );
    let what = match (recording.kind, recording.meeting_app.as_deref()) {
        (Kind::Note, _) => "nota",
        (_, Some("teams")) => "Teams",
        (_, Some("meet")) => "Meet",
        (_, Some("zoom")) => "Zoom",
        (_, Some(_)) => "reunião",
        (_, None) => "gravação",
    };
    format!("{when} {what}.ogg")
}

/// SHA-256 of the whole file, in lowercase hex, read in blocks.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("falha ao abrir {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use eclume_recorder::{NewImport, RecordedAtSource};

    use super::*;
    use crate::protocol::RetryPolicy;
    use crate::transport::UreqTransport;

    fn recording(meeting_app: Option<&str>) -> QueuedRecording {
        let queue = recorded_queue();
        if let Some(app) = meeting_app {
            queue.set_meeting_app("g1", app).unwrap();
        }
        queue.get("g1").unwrap().unwrap()
    }

    fn recorded_queue() -> Queue {
        let queue = Queue::open_in_memory().unwrap();
        queue
            .begin("g1", Path::new("/tmp/g1.ogg.part"), 1_758_733_205_000)
            .unwrap();
        queue
            .finish(
                "g1",
                Path::new("/tmp/g1.ogg"),
                1_758_733_265_000,
                60_000,
                10,
            )
            .unwrap();
        queue
    }

    fn imported(path: &str, content_type: Option<&str>) -> QueuedRecording {
        let queue = Queue::open_in_memory().unwrap();
        queue
            .begin_import(&NewImport {
                id: "i1",
                path: Path::new(path),
                recorded_at: 1_758_733_205_000,
                recorded_at_source: RecordedAtSource::FileMetadata,
                original_name: "kickoff-guion",
                content_type,
                duration_ms: 2_820_000,
                bytes: 10,
            })
            .unwrap();
        queue.get("i1").unwrap().unwrap()
    }

    fn uploader() -> HttpUploader {
        let queue = Arc::new(Mutex::new(Queue::open_in_memory().unwrap()));
        let client = Client::new(
            Arc::new(UreqTransport::new(None, "eclume-desktop/0.1.0").unwrap()),
            "https://eclume.test",
            "eclp_x",
            RetryPolicy::default(),
        )
        .unwrap();
        HttpUploader::from_client(client, queue, "eclume-desktop/0.1.0")
    }

    #[test]
    fn file_sha256() {
        let path = std::env::temp_dir().join(format!("eclume-sha-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn filename_tells_when_and_which_meeting() {
        let teams = filename(&recording(Some("teams")));
        assert!(teams.ends_with(" Teams.ogg"), "{teams}");
        assert!(teams.starts_with("2025-09-2"), "{teams}");
        assert!(filename(&recording(Some("other"))).ends_with(" reunião.ogg"));
        assert!(filename(&recording(None)).ends_with(" gravação.ogg"));
    }

    #[test]
    fn voice_note_and_import_filename() {
        let queue = recorded_queue();
        queue.set_kind("g1", Kind::Note).unwrap();
        let note = filename(&queue.get("g1").unwrap().unwrap());
        assert!(note.ends_with(" nota.ogg"), "{note}");
        assert!(note.starts_with("2025-09-2"), "{note}");
        assert_eq!(
            filename(&imported("/tmp/i1.ogg", None)),
            "kickoff-guion.ogg"
        );
        assert_eq!(
            filename(&imported("/tmp/i1.avi", Some("video/x-msvideo"))),
            "kickoff-guion.avi"
        );
    }

    #[test]
    fn upload_request_follows_contract() {
        let uploader = uploader();
        let create = uploader.create_request(&recording(Some("meet")), &[], 10, "ab".into());
        let json = serde_json::to_value(&create).unwrap();
        assert_eq!(json["recorded_at"], "2025-09-24T17:00:05Z");
        assert_eq!(json["recorded_at_source"], "capture");
        assert_eq!(json["kind"], "meeting");
        assert!(json.get("markers").is_none());
        assert_eq!(json["duration_ms"], 60_000);
        assert_eq!(json["content_type"], CONTENT_TYPE);
        assert_eq!(json["source"], "desktop");
        assert_eq!(json["capture"]["meeting_app"], "meet");
        assert_eq!(json["capture"]["client_version"], "eclume-desktop/0.1.0");
        assert!(json.get("title").is_none());
        assert!(json.get("agenda_type_id").is_none());
        let manual = uploader.create_request(&recording(None), &[], 10, "ab".into());
        let json = serde_json::to_value(&manual).unwrap();
        assert!(json["capture"].get("meeting_app").is_none());
    }

    #[test]
    fn mobile_request_includes_source_title_type_and_device() {
        let queue = recorded_queue();
        queue.set_source("g1", Source::Mobile).unwrap();
        queue
            .save_details(
                "g1",
                Some("Visita ao cliente"),
                Some("7c0e2f7a-1b2c-4d5e-8f90-a1b2c3d4e5f6"),
                None,
            )
            .unwrap();
        let marker = queue.add_marker("g1", 42_000, Some("prazo")).unwrap();
        let uploader = uploader().with_device_name("Pixel 8");
        let create = uploader.create_request(
            &queue.get("g1").unwrap().unwrap(),
            &queue.markers("g1").unwrap(),
            10,
            "ab".into(),
        );
        let json = serde_json::to_value(&create).unwrap();
        assert_eq!(json["source"], "mobile");
        assert_eq!(json["recorded_at_source"], "capture");
        assert_eq!(json["title"], "Visita ao cliente");
        assert_eq!(
            json["agenda_type_id"],
            "7c0e2f7a-1b2c-4d5e-8f90-a1b2c3d4e5f6"
        );
        assert_eq!(json["markers"][0]["client_id"], marker.client_id);
        assert_eq!(json["capture"]["device_name"], "Pixel 8");
        assert!(
            json.get("language").is_none(),
            "without a language, the server language applies"
        );

        let create = uploader.with_language(Some("es".into())).create_request(
            &queue.get("g1").unwrap().unwrap(),
            &[],
            10,
            "ab".into(),
        );
        assert_eq!(serde_json::to_value(&create).unwrap()["language"], "es");

        // The language chosen for the recording overrides the device's.
        queue.save_details("g1", None, None, Some("auto")).unwrap();
        let create = self::uploader()
            .with_language(Some("es".into()))
            .create_request(&queue.get("g1").unwrap().unwrap(), &[], 10, "ab".into());
        assert_eq!(serde_json::to_value(&create).unwrap()["language"], "auto");
    }

    #[test]
    fn voice_note_request_includes_markers() {
        let queue = recorded_queue();
        queue.set_kind("g1", Kind::Note).unwrap();
        let without_note = queue.add_marker("g1", 12_000, None).unwrap();
        let with_note = queue.add_marker("g1", 3_000, Some("decisão")).unwrap();
        let markers = queue.markers("g1").unwrap();
        let create = uploader().create_request(
            &queue.get("g1").unwrap().unwrap(),
            &markers,
            10,
            "ab".into(),
        );
        let json = serde_json::to_value(&create).unwrap();
        assert_eq!(json["kind"], "note");
        assert_eq!(
            json["markers"],
            serde_json::json!([
                {"client_id": with_note.client_id, "at_ms": 3_000, "note": "decisão"},
                {"client_id": without_note.client_id, "at_ms": 12_000},
            ])
        );
    }

    #[test]
    fn import_request_includes_source_and_type_from_row() {
        let uploader = uploader();
        let copied = imported("/tmp/i1.avi", Some("video/x-msvideo"));
        let json =
            serde_json::to_value(uploader.create_request(&copied, &[], 10, "ab".into())).unwrap();
        assert_eq!(json["source"], "upload");
        assert_eq!(json["kind"], "meeting");
        assert_eq!(json["recorded_at_source"], "file_metadata");
        assert_eq!(json["recorded_at"], "2025-09-24T17:00:05Z");
        assert_eq!(json["content_type"], "video/x-msvideo");
        assert_eq!(json["filename"], "kickoff-guion.avi");
        assert_eq!(json["capture"]["client_version"], "eclume-desktop/0.1.0");
        let converted = imported("/tmp/i1.ogg", None);
        let json = serde_json::to_value(uploader.create_request(&converted, &[], 10, "ab".into()))
            .unwrap();
        assert_eq!(json["content_type"], CONTENT_TYPE);
    }
}
