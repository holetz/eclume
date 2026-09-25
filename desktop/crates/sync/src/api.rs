//! Os tipos do contrato v1 (`contracts/openapi-v1.yaml`) que o upload usa. Tolerantes como o
//! contrato exige: propriedades desconhecidas são ignoradas e os estados ficam em texto, para um
//! valor novo de enum não quebrar o cliente.

use serde::{Deserialize, Serialize};

/// Contexto da captura, preenchido pelo desktop.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Capture {
    /// `teams`, `meet`, `zoom`, `other` ou nada (gravação manual).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub client_version: String,
}

/// `POST /api/v1/uploads`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UploadCreate {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub source: String,
    pub capture: Capture,
}

/// URL de uma parte, com os headers que o `PUT` deve levar.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PartUrl {
    pub part_number: u32,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

/// Parte que o armazenamento já confirmou.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ReceivedPart {
    pub part_number: u32,
    pub etag: String,
}

/// O upload, na criação e na retomada.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Upload {
    pub id: String,
    pub status: String,
    pub part_size: u64,
    pub part_count: u32,
    #[serde(default)]
    pub parts_received: Vec<ReceivedPart>,
    #[serde(default)]
    pub parts: Vec<PartUrl>,
    pub recording_id: Option<String>,
}

pub mod status {
    pub const IN_PROGRESS: &str = "in_progress";
    pub const COMPLETED: &str = "completed";
    pub const DEDUPLICATED: &str = "deduplicated";
}

/// `POST /api/v1/uploads/{id}/part-urls`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PartUrlsRequest {
    pub part_numbers: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PartUrls {
    pub parts: Vec<PartUrl>,
}

/// Uma parte no `complete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CompletedPart {
    pub part_number: u32,
    pub etag: String,
}

/// `POST /api/v1/uploads/{id}/complete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UploadComplete {
    pub parts: Vec<CompletedPart>,
}

/// O que o desktop lê da gravação criada.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Recording {
    pub id: String,
}

/// Erro em `application/problem+json` (RFC 9457) com o `code` estável do contrato.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Problem {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub code: Option<String>,
}
