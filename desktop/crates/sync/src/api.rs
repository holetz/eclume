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

/// O cursor do próximo `?since=`: o maior `updated_at` da listagem menos `margin_secs`. A margem
/// cobre a transação que confirmou depois de outra com `updated_at` maior (o `now()` do servidor é
/// o início da transação): reler o que já estava certo é barato, perder uma mudança não é.
/// Compara datas de verdade, porque o servidor omite os microssegundos quando zero.
pub fn cursor_from(items: &[LibraryRecording], margin_secs: i64) -> Option<String> {
    items
        .iter()
        .filter_map(|item| item.updated_at.as_deref())
        .filter_map(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .max()
        .map(|latest| {
            (latest.with_timezone(&chrono::Utc) - chrono::Duration::seconds(margin_secs))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        })
}

/// O início de uma gravação (`recorded_at`, RFC 3339) no fuso `zone`, como `AAAA-MM-DDTHH:MM:SS`.
pub fn start_in<Tz>(recorded_at: &str, zone: &Tz) -> Option<String>
where
    Tz: chrono::TimeZone,
    Tz::Offset: std::fmt::Display,
{
    chrono::DateTime::parse_from_rfc3339(recorded_at)
        .ok()
        .map(|at| {
            at.with_timezone(zone)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
}

/// O mesmo que [`start_in`] num deslocamento fixo em segundos a leste de UTC (Brasília: `-10800`).
pub fn start_at_offset(recorded_at: &str, east_seconds: i32) -> Option<String> {
    let zone = chrono::FixedOffset::east_opt(east_seconds)?;
    start_in(recorded_at, &zone)
}

/// O início de uma gravação no fuso deste computador: dá o mês da pasta e o nome do arquivo na
/// pasta sincronizada, para baterem com a hora que a pessoa vê.
pub fn local_start(recorded_at: &str) -> Option<String> {
    start_in(recorded_at, &chrono::Local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(updated_at: Option<&str>) -> LibraryRecording {
        LibraryRecording {
            id: "r".into(),
            title: String::new(),
            status: String::new(),
            recorded_at: None,
            created_at: None,
            updated_at: updated_at.map(str::to_string),
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: vec![],
        }
    }

    #[test]
    fn o_inicio_local_vira_a_hora_do_fuso_e_muda_de_mes_junto() {
        let brasilia = chrono::FixedOffset::west_opt(3 * 3600).unwrap();
        assert_eq!(
            start_in("2026-09-18T14:00:05Z", &brasilia).as_deref(),
            Some("2026-09-18T11:00:05")
        );
        // 02:30 UTC de 1º de outubro ainda é 30 de setembro à noite em Brasília.
        assert_eq!(
            start_in("2026-10-01T02:30:00Z", &brasilia).as_deref(),
            Some("2026-09-30T23:30:00")
        );
        assert_eq!(
            start_in("2026-09-18T14:00:05.250000Z", &chrono::Utc).as_deref(),
            Some("2026-09-18T14:00:05")
        );
        assert_eq!(start_in("lixo", &brasilia), None);
        // O fuso do computador só muda a hora, nunca a forma.
        let local = local_start("2026-09-18T14:00:05Z").unwrap();
        assert_eq!(local.len(), 19);
        assert_eq!(&local[10..11], "T");
    }

    #[test]
    fn o_cursor_e_o_maior_updated_at_menos_a_margem_comparando_datas() {
        // Como texto, "…:05Z" > "…:05.5Z" (o `Z` vem depois do `.`); como data, o segundo é maior.
        let items = [
            at(Some("2026-09-19T10:00:05Z")),
            at(None),
            at(Some("2026-09-19T10:00:05.500000Z")),
            at(Some("lixo")),
        ];
        assert_eq!(
            cursor_from(&items, 0).as_deref(),
            Some("2026-09-19T10:00:05Z")
        );
        assert_eq!(
            cursor_from(&items, 120).as_deref(),
            Some("2026-09-19T09:58:05Z")
        );
        // A margem atravessa a virada de dia.
        assert_eq!(
            cursor_from(&[at(Some("2026-09-19T00:01:00-03:00"))], 120).as_deref(),
            Some("2026-09-19T02:59:00Z")
        );
        assert_eq!(cursor_from(&[at(None)], 120), None);
        assert_eq!(cursor_from(&[], 120), None);
    }
}
