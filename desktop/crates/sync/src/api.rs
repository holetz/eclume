//! The contract v1 types (`contracts/openapi-v1.yaml`) used by uploads. Tolerant as the contract
//! requires: unknown properties are ignored and states remain text, so a new enum value does not
//! break the client.

use eclume_recorder::{Kind, RecordedAtSource, Source};
use serde::{Deserialize, Serialize};

/// Capture context, filled by the recording app (desktop or phone).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Capture {
    /// `teams`, `meet`, `zoom`, `other` or nothing (manual recording).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub client_version: String,
}

/// A marker made during recording; `client_id` makes resending idempotent.
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
    /// Title chosen when stopping; without a value, the server derives it from the filename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    pub recorded_at_source: RecordedAtSource,
    pub kind: Kind,
    /// Agenda type chosen when stopping: skips server detection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agenda_type_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<MarkerInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Transcript language (`pt`, `es`, `en` or `auto`); without a value, the account language
    /// applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub source: Source,
    pub capture: Capture,
}

/// A part URL, with the headers the `PUT` must carry.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PartUrl {
    pub part_number: u32,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

/// A part already confirmed by storage.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ReceivedPart {
    pub part_number: u32,
    pub etag: String,
}

/// The upload, at creation and on resume.
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

/// A part in `complete`.
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

/// What the desktop reads from the created recording.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Recording {
    pub id: String,
}

/// An `application/problem+json` error (RFC 9457) with the contract's stable `code`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Problem {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub code: Option<String>,
}

/// `GET /api/v1/server`: the public descriptor (holetz/eclume#35).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub url: String,
    /// SHA-256 (lowercase hex) of the root CA DER; `None` until the root is published.
    pub ca_sha256: Option<String>,
    /// The next root during rotation (contract 2.21.0); `None` otherwise.
    #[serde(default)]
    pub ca_next_sha256: Option<String>,
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

/// The issued token, without the secret.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
}

/// The device credential: the secret (only in this response) and the server that issued it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct DeviceCredential {
    pub token: TokenInfo,
    pub secret: String,
    pub server: ServerInfo,
}

/// What the desktop reads from `GET /api/v1/me`.
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

/// A collection from `GET /api/v1/collections` (flat: no hierarchy). The account's transcript
/// language: `GET /api/v1/me/transcription` (contract 2.20.0).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TranscriptionPreference {
    /// The account's choice (`pt`, `auto`…); `None` means the server default.
    pub language: Option<String>,
    pub platform_default: String,
}

impl TranscriptionPreference {
    /// The language that applies to the account: its choice, otherwise the server's.
    pub fn effective(&self) -> &str {
        self.language.as_deref().unwrap_or(&self.platform_default)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CollectionInfo {
    pub id: String,
    pub name: String,
}

/// A page of `GET /api/v1/collections`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CollectionPage {
    #[serde(default)]
    pub items: Vec<CollectionInfo>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// A recording's agenda type: only the name matters for the local mirror.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct AgendaRef {
    #[serde(default)]
    pub name: String,
}

/// A recording's pipeline step.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PipelineStepInfo {
    pub step: String,
    pub state: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// Why the step was skipped (`no_provider`, `cancelled`, `summary_deleted`…).
    #[serde(default)]
    pub reason: Option<String>,
}

/// A recording's transcription job: state and end determine the outcome; step, progress and error
/// feed the window's recent recordings panel.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct JobInfo {
    pub state: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// The current step (`preprocessing`, `asr`…), `None` when not running.
    #[serde(default)]
    pub stage: Option<String>,
    /// Job progress in thousandths (0–1000): the contract sends a number from 0 to 1, and the
    /// integer preserves `Eq` for the listing types.
    #[serde(default, deserialize_with = "permille")]
    pub progress: Option<u16>,
    #[serde(default)]
    pub error: Option<JobError>,
}

/// The error of a failed job.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct JobError {
    #[serde(default)]
    pub code: String,
    /// The failure is transient (the server retries); absent on servers before 1.4.0.
    #[serde(default)]
    pub retryable: bool,
}

/// `progress` from 0 to 1 in thousandths, clamped to the range; `null` or absent means `None`.
fn permille<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u16>, D::Error> {
    let value: Option<f64> = Option::deserialize(deserializer)?;
    Ok(value
        .filter(|v| v.is_finite())
        .map(|v| (v.clamp(0.0, 1.0) * 1000.0).round() as u16))
}

/// What the local mirror reads from a library recording (`GET /api/v1/recordings`).
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
    #[serde(default)]
    pub job: Option<JobInfo>,
}

impl LibraryRecording {
    /// Whether the recording changed at or after `since` (`updated_at >= since`, as the server
    /// compares). Without a readable `updated_at`, counts as changed: rereading is cheap, missing a
    /// change is not.
    pub fn updated_since(&self, since: &str) -> bool {
        match (
            self.updated_at.as_deref().and_then(instant_ms),
            instant_ms(since),
        ) {
            (Some(updated), Some(since)) => updated >= since,
            _ => true,
        }
    }

    /// State of the pipeline's `summary` step, when the recording has one.
    pub fn summary_state(&self) -> Option<&str> {
        self.summary_step().map(|step| step.state.as_str())
    }

    /// The pipeline's `summary` step, when the recording has one.
    pub fn summary_step(&self) -> Option<&PipelineStepInfo> {
        self.pipeline.iter().find(|step| step.step == "summary")
    }
}

/// A page of `GET /api/v1/recordings`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LibraryPage {
    #[serde(default)]
    pub items: Vec<LibraryRecording>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// A transcript speaker.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TranscriptSpeaker {
    pub id: String,
    #[serde(default)]
    pub label: String,
}

/// A transcript segment (words are omitted: only included with `?include=words`).
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

/// The transcript from `GET /api/v1/transcripts`.
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

/// A marker from `GET /api/v1/recordings/{id}/markers`: the time and optional note.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Marker {
    pub at_ms: u64,
    #[serde(default)]
    pub note: Option<String>,
}

/// The (single) page of `GET /api/v1/recordings/{id}/markers`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct MarkerPage {
    #[serde(default)]
    pub items: Vec<Marker>,
}

/// A page of `GET /api/v1/transcripts`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TranscriptPage {
    #[serde(default)]
    pub items: Vec<Transcript>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// The next `?since=` cursor: the listing's highest `updated_at` minus `margin_secs`. The margin
/// covers a transaction committing after another with a higher `updated_at` (the server's `now()`
/// is the transaction start): rereading correct data is cheap, missing a change is not. Compares
/// actual dates, because the server omits microseconds when zero.
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

/// An RFC 3339 timestamp in milliseconds since the Unix epoch; `None` if the text is not a date.
/// Compares actual dates: as text, "…:05Z" comes after "…:05.5Z".
pub fn instant_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// Whether a read with `?since=cached` already includes everything one with `?since=wanted` would
/// (`cached <= wanted`). Text that is not a date never covers it.
pub fn since_covers(cached: &str, wanted: &str) -> bool {
    matches!((instant_ms(cached), instant_ms(wanted)), (Some(cached), Some(wanted)) if cached <= wanted)
}

/// A timestamp in milliseconds since the Unix epoch as RFC 3339 (UTC), for a `?since=`.
pub fn rfc3339_from_ms(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// A recording's start (`recorded_at`, RFC 3339) in `zone`, as `AAAA-MM-DDTHH:MM:SS`.
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

/// Like [`start_in`] with a fixed offset in seconds east of UTC (Brasilia: `-10800`).
pub fn start_at_offset(recorded_at: &str, east_seconds: i32) -> Option<String> {
    let zone = chrono::FixedOffset::east_opt(east_seconds)?;
    start_in(recorded_at, &zone)
}

/// A recording's start in this computer's time zone: provides the folder month and filename in the
/// synced folder, matching the time the user sees.
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
            job: None,
        }
    }

    #[test]
    fn listing_job_reads_step_progress_and_error_and_accepts_old_server() {
        let complete: JobInfo = serde_json::from_value(serde_json::json!({
            "state": "running", "finished_at": null, "stage": "asr", "progress": 0.426,
            "error": null, "attempts": 1
        }))
        .unwrap();
        assert_eq!(complete.stage.as_deref(), Some("asr"));
        assert_eq!(complete.progress, Some(426));
        assert_eq!(complete.error, None);

        let failed: JobInfo = serde_json::from_value(serde_json::json!({
            "state": "failed", "progress": 7,
            "error": {"code": "gpu_oom", "message": "sem VRAM", "retryable": true}
        }))
        .unwrap();
        assert_eq!(failed.progress, Some(1000));
        assert_eq!(
            failed.error,
            Some(JobError {
                code: "gpu_oom".into(),
                retryable: true
            })
        );

        let legacy: JobInfo =
            serde_json::from_value(serde_json::json!({"state": "queued"})).unwrap();
        assert_eq!(
            (legacy.stage, legacy.progress, legacy.error),
            (None, None, None)
        );
    }

    #[test]
    fn local_start_uses_time_zone_and_changes_month_with_it() {
        let brasilia = chrono::FixedOffset::west_opt(3 * 3600).unwrap();
        assert_eq!(
            start_in("2026-09-18T14:00:05Z", &brasilia).as_deref(),
            Some("2026-09-18T11:00:05")
        );
        // 02:30 UTC on October 1 is still the evening of September 30 in Brasilia.
        assert_eq!(
            start_in("2026-10-01T02:30:00Z", &brasilia).as_deref(),
            Some("2026-09-30T23:30:00")
        );
        assert_eq!(
            start_in("2026-09-18T14:00:05.250000Z", &chrono::Utc).as_deref(),
            Some("2026-09-18T14:00:05")
        );
        assert_eq!(start_in("lixo", &brasilia), None);
        // The computer's time zone changes only the time, never the format.
        let local = local_start("2026-09-18T14:00:05Z").unwrap();
        assert_eq!(local.len(), 19);
        assert_eq!(&local[10..11], "T");
    }

    #[test]
    fn cursor_is_latest_updated_at_minus_margin_comparing_dates() {
        // As text, "…:05Z" > "…:05.5Z" (`Z` comes after `.`); as dates, the second is later.
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
        // The margin crosses the day boundary.
        assert_eq!(
            cursor_from(&[at(Some("2026-09-19T00:01:00-03:00"))], 120).as_deref(),
            Some("2026-09-19T02:59:00Z")
        );
        assert_eq!(cursor_from(&[at(None)], 120), None);
        assert_eq!(cursor_from(&[], 120), None);
    }

    #[test]
    fn since_covers_by_comparing_dates_and_updated_since_filters_by_time() {
        assert!(since_covers(
            "2026-09-19T10:00:00Z",
            "2026-09-19T10:00:00.500000Z"
        ));
        assert!(since_covers("2026-09-19T10:00:00Z", "2026-09-19T10:00:00Z"));
        // As text, "…:05Z" > "…:05.5Z"; as dates, the second is later.
        assert!(since_covers(
            "2026-09-19T10:00:05Z",
            "2026-09-19T10:00:05.500000Z"
        ));
        assert!(!since_covers(
            "2026-09-19T10:00:06Z",
            "2026-09-19T10:00:05Z"
        ));
        assert!(!since_covers("lixo", "2026-09-19T10:00:05Z"));
        assert!(!since_covers("2026-09-19T10:00:05Z", "lixo"));

        let mut item = at(Some("2026-09-19T10:00:05.500000Z"));
        assert!(item.updated_since("2026-09-19T10:00:05Z"));
        assert!(!item.updated_since("2026-09-19T10:00:06Z"));
        // Without a readable `updated_at`, counts as changed.
        item.updated_at = None;
        assert!(item.updated_since("2026-09-19T10:00:06Z"));
    }
}
