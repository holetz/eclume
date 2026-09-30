//! Os tipos do contrato v1 (`contracts/openapi-v1.yaml`) que o upload usa. Tolerantes como o
//! contrato exige: propriedades desconhecidas são ignoradas e os estados ficam em texto, para um
//! valor novo de enum não quebrar o cliente.

use eclume_recorder::{Kind, RecordedAtSource, Source};
use serde::{Deserialize, Serialize};

/// Contexto da captura, preenchido pelo app que gravou (desktop ou celular).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Capture {
    /// `teams`, `meet`, `zoom`, `other` ou nada (gravação manual).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub client_version: String,
}

/// Um marcador feito durante a gravação; o `client_id` torna o reenvio idempotente.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MarkerInput {
    pub client_id: String,
    pub at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `POST /api/v1/uploads`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UploadCreate {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    /// Título escolhido ao parar; sem valor, o servidor deriva do nome do arquivo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    pub recorded_at_source: RecordedAtSource,
    pub kind: Kind,
    /// Tipo de agenda escolhido ao parar: dispensa a detecção no servidor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agenda_type_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<MarkerInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Idioma da transcrição (`pt`, `es`, `en`); sem valor, vale o padrão do servidor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub source: Source,
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

/// `GET /api/v1/server`: o descritor público (holetz/eclume#35).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub url: String,
    /// SHA-256 (hex minúsculo) do DER da CA raiz; `None` enquanto a raiz não foi publicada.
    pub ca_sha256: Option<String>,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub contract_version: String,
}

/// `POST /api/v1/devices/login`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeviceLogin<'a> {
    pub email: &'a str,
    pub password: &'a str,
    pub device_name: &'a str,
    pub platform: &'a str,
}

/// `POST /api/v1/devices/pair`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DevicePair<'a> {
    pub code: &'a str,
    pub device_name: &'a str,
    pub platform: &'a str,
}

/// O token emitido, sem o segredo.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
}

/// A credencial de dispositivo: o segredo (só nesta resposta) e o servidor que a emitiu.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DeviceCredential {
    pub token: TokenInfo,
    pub secret: String,
    pub server: ServerInfo,
}

/// O que o desktop lê de `GET /api/v1/me`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Me {
    pub user: MeUser,
    pub auth: MeAuth,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MeUser {
    pub email: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MeAuth {
    pub method: String,
    pub token_id: Option<String>,
}

/// Uma Collection de `GET /api/v1/collections` (plana: sem hierarquia).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CollectionInfo {
    pub id: String,
    pub name: String,
}

/// Uma página de `GET /api/v1/collections`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CollectionPage {
    #[serde(default)]
    pub items: Vec<CollectionInfo>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// O tipo de agenda de uma gravação: só o nome importa para o espelho local.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct AgendaRef {
    #[serde(default)]
    pub name: String,
}

/// Uma etapa do pipeline de uma gravação.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PipelineStepInfo {
    pub step: String,
    pub state: String,
}

/// O que o espelho local lê de uma gravação da biblioteca (`GET /api/v1/recordings`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LibraryRecording {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub recorded_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub collection_ids: Vec<String>,
    #[serde(default)]
    pub transcript_id: Option<String>,
    #[serde(default)]
    pub agenda_type: Option<AgendaRef>,
    #[serde(default)]
    pub pipeline: Vec<PipelineStepInfo>,
}

impl LibraryRecording {
    /// Estado da etapa `summary` do pipeline, quando a gravação a tem.
    pub fn summary_state(&self) -> Option<&str> {
        self.pipeline
            .iter()
            .find(|step| step.step == "summary")
            .map(|step| step.state.as_str())
    }
}

/// Uma página de `GET /api/v1/recordings`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LibraryPage {
    #[serde(default)]
    pub items: Vec<LibraryRecording>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// Um locutor da transcrição.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TranscriptSpeaker {
    pub id: String,
    #[serde(default)]
    pub label: String,
}

/// Um segmento da transcrição (as palavras ficam de fora: só vêm com `?include=words`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TranscriptSegment {
    #[serde(default)]
    pub speaker_id: Option<String>,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    #[serde(default)]
    pub text: String,
}

/// A transcrição de `GET /api/v1/transcripts`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Transcript {
    pub id: String,
    pub recording_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub recorded_at: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub speakers: Vec<TranscriptSpeaker>,
    #[serde(default)]
    pub segments: Vec<TranscriptSegment>,
}

/// Uma página de `GET /api/v1/transcripts`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TranscriptPage {
    #[serde(default)]
    pub items: Vec<Transcript>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}
