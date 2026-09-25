//! `HttpUploader`: a implementação real do `Uploader` do `eclume-recorder`. Calcula o `sha256`
//! uma vez, guarda-o e o upload em curso na fila (para a retomada) e sobe pelo [`Client`].

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{anyhow, Context, Result};
use chrono::{Local, SecondsFormat, TimeZone, Utc};
use eclume_recorder::{Queue, QueuedRecording, Uploader};
use sha2::{Digest, Sha256};

use crate::api::{Capture, UploadCreate};
use crate::protocol::{Client, RetryPolicy};
use crate::transport::UreqTransport;

/// Tipo do arquivo que o desktop grava (Ogg/Opus mono 16 kHz).
pub const CONTENT_TYPE: &str = "audio/ogg; codecs=opus";

/// O que o uploader precisa saber além da fila.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploaderConfig {
    /// Endereço da API (`https://host:8443`), sem o `/api/v1`.
    pub api_url: String,
    pub pat: String,
    /// PEM com a CA extra a confiar.
    pub ca_path: Option<PathBuf>,
    /// `eclume-desktop/<versão>`.
    pub client_version: String,
}

pub struct HttpUploader {
    client: Client,
    queue: Arc<Mutex<Queue>>,
    client_version: String,
    device_name: Option<String>,
}

impl HttpUploader {
    pub fn new(config: &UploaderConfig, queue: Arc<Mutex<Queue>>) -> Result<Self> {
        let transport = UreqTransport::new(config.ca_path.as_deref(), &config.client_version)?;
        let client = Client::new(
            Arc::new(transport),
            &config.api_url,
            &config.pat,
            RetryPolicy::default(),
        )?;
        Ok(Self::from_client(client, queue, &config.client_version))
    }

    /// Sobre um cliente já montado (transporte próprio, nos testes).
    pub fn from_client(client: Client, queue: Arc<Mutex<Queue>>, client_version: &str) -> Self {
        Self {
            client,
            queue,
            client_version: client_version.to_string(),
            device_name: gethostname::gethostname().into_string().ok(),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn lock(&self) -> Result<MutexGuard<'_, Queue>> {
        self.queue
            .lock()
            .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
    }

    fn create_request(
        &self,
        recording: &QueuedRecording,
        size: u64,
        sha256: String,
    ) -> UploadCreate {
        UploadCreate {
            filename: filename(recording),
            content_type: CONTENT_TYPE.to_string(),
            size_bytes: size,
            sha256,
            recorded_at: Utc
                .timestamp_millis_opt(recording.started_at)
                .single()
                .map(|at| at.to_rfc3339_opts(SecondsFormat::Secs, true)),
            duration_ms: recording.duration_ms.and_then(|ms| u64::try_from(ms).ok()),
            source: "desktop".to_string(),
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
        let create = self.create_request(recording, size, sha256.clone());
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
                "gravação {} já estava no servidor ({})",
                recording.id,
                uploaded.recording_id
            );
        }
        Ok(uploaded.recording_id)
    }
}

/// `2026-09-24 14-00 Teams.ogg`, na hora local, como o navegador nomeia.
pub fn filename(recording: &QueuedRecording) -> String {
    let when = Local
        .timestamp_millis_opt(recording.started_at)
        .single()
        .map_or_else(
            || recording.id.clone(),
            |at| at.format("%Y-%m-%d %H-%M").to_string(),
        );
    let what = match recording.meeting_app.as_deref() {
        Some("teams") => "Teams",
        Some("meet") => "Meet",
        Some("zoom") => "Zoom",
        Some(_) => "reunião",
        None => "gravação",
    };
    format!("{when} {what}.ogg")
}

/// SHA-256 do arquivo inteiro, em hex minúsculo, lido em blocos.
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
    use super::*;

    fn recording(meeting_app: Option<&str>) -> QueuedRecording {
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
        if let Some(app) = meeting_app {
            queue.set_meeting_app("g1", app).unwrap();
        }
        queue.get("g1").unwrap().unwrap()
    }

    #[test]
    fn sha256_do_arquivo() {
        let path = std::env::temp_dir().join(format!("eclume-sha-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn nome_do_arquivo_diz_quando_e_qual_reuniao() {
        let teams = filename(&recording(Some("teams")));
        assert!(teams.ends_with(" Teams.ogg"), "{teams}");
        assert!(teams.starts_with("2025-09-2"), "{teams}");
        assert!(filename(&recording(Some("other"))).ends_with(" reunião.ogg"));
        assert!(filename(&recording(None)).ends_with(" gravação.ogg"));
    }

    #[test]
    fn pedido_de_upload_segue_o_contrato() {
        let queue = Arc::new(Mutex::new(Queue::open_in_memory().unwrap()));
        let client = Client::new(
            Arc::new(UreqTransport::new(None, "eclume-desktop/0.1.0").unwrap()),
            "https://eclume.test",
            "eclp_x",
            RetryPolicy::default(),
        )
        .unwrap();
        let uploader = HttpUploader::from_client(client, queue, "eclume-desktop/0.1.0");
        let create = uploader.create_request(&recording(Some("meet")), 10, "ab".into());
        let json = serde_json::to_value(&create).unwrap();
        assert_eq!(json["recorded_at"], "2025-09-24T17:00:05Z");
        assert_eq!(json["duration_ms"], 60_000);
        assert_eq!(json["content_type"], CONTENT_TYPE);
        assert_eq!(json["source"], "desktop");
        assert_eq!(json["capture"]["meeting_app"], "meet");
        assert_eq!(json["capture"]["client_version"], "eclume-desktop/0.1.0");
        let manual = uploader.create_request(&recording(None), 10, "ab".into());
        let json = serde_json::to_value(&manual).unwrap();
        assert!(json["capture"].get("meeting_app").is_none());
    }
}
