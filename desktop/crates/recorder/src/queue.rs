//! Local persistent recording queue in SQLite.
//!
//! One row per recording, with the lifecycle `recording → pending → syncing → synced | failed`.
//! `failed` returns to `pending` through `retry_due` (after backoff) or `retry_failed`
//! (immediately). A row left in `recording` when the process died is recovered on the next
//! startup as `pending` with `interrupted = 1`.
//!
//! Schema v2: `upload_id` and `sha256` store the ongoing upload for resumption,
//! `next_attempt_at` schedules the next attempt after a failure, `synced_at` marks server
//! confirmation, `purged_at` marks local file removal by retention, and `meeting_app` stores
//! the meeting app seen by detection (`teams`, `meet`, `zoom`, `other`).
//!
//! Schema v3: `kind` distinguishes a meeting from a voice note, `recorded_at_source` indicates
//! where the start date came from (capture, imported file metadata or the person), `source`
//! distinguishes app recording from file import, and `original_name`/`content_type` store the
//! imported file's name and type. The `markers` table stores each recording's markers until
//! upload.
//!
//! Schema v4: `title` and `agenda_type_id` are the title and agenda type chosen on stop (on
//! mobile, the "Recording saved" sheet), and `details_pending` holds sync while that sheet is
//! open, for at most [`DETAILS_WAIT_MS`].
//!
//! Schema v5: `server_title` is the title the server gives the recording after processing, read
//! from the listing with `?since=`; the queue shows the local title, falling back to this one.
//!
//! Schema v6: `language` is the transcript language chosen for the recording (on mobile, the
//! "Recording saved" sheet; `auto` requests detection); without it, upload sends the device
//! language, and without either, the account language applies. A v1 to v5 queue gains the
//! columns and table on open, without losing rows.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::Serialize;

const SCHEMA_VERSION: i32 = 6;

/// How long a recording with `details_pending` waits for title and type before uploading
/// without them.
pub const DETAILS_WAIT_MS: i64 = 10 * 60 * 1_000;

/// Maximum marker note length, in characters (the contract limit).
pub const MAX_MARKER_NOTE: usize = 500;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS recordings (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    duration_ms INTEGER,
    bytes       INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('recording','pending','syncing','synced','failed')),
    interrupted INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    remote_id   TEXT,
    upload_id       TEXT,
    sha256          TEXT,
    next_attempt_at INTEGER,
    synced_at       INTEGER,
    purged_at       INTEGER,
    meeting_app     TEXT,
    kind               TEXT NOT NULL DEFAULT 'meeting',
    recorded_at_source TEXT NOT NULL DEFAULT 'capture',
    source             TEXT NOT NULL DEFAULT 'desktop',
    original_name      TEXT,
    content_type       TEXT,
    title              TEXT,
    agenda_type_id     TEXT,
    details_pending    INTEGER NOT NULL DEFAULT 0,
    server_title       TEXT,
    language           TEXT
);
CREATE INDEX IF NOT EXISTS recordings_status ON recordings (status, started_at);
CREATE TABLE IF NOT EXISTS markers (
    client_id    TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL,
    at_ms        INTEGER NOT NULL,
    note         TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS markers_recording ON markers (recording_id, at_ms);
";

/// Columns added by v2 to v6, with their types, to migrate an older queue.
const ADDED_COLUMNS: [(&str, &str); 16] = [
    ("upload_id", "TEXT"),
    ("sha256", "TEXT"),
    ("next_attempt_at", "INTEGER"),
    ("synced_at", "INTEGER"),
    ("purged_at", "INTEGER"),
    ("meeting_app", "TEXT"),
    ("kind", "TEXT NOT NULL DEFAULT 'meeting'"),
    ("recorded_at_source", "TEXT NOT NULL DEFAULT 'capture'"),
    ("source", "TEXT NOT NULL DEFAULT 'desktop'"),
    ("original_name", "TEXT"),
    ("content_type", "TEXT"),
    ("title", "TEXT"),
    ("agenda_type_id", "TEXT"),
    ("details_pending", "INTEGER NOT NULL DEFAULT 0"),
    ("server_title", "TEXT"),
    ("language", "TEXT"),
];

/// An enum stored as text in the queue, read, written and serialized in the contract
/// vocabulary.
macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                let text = value.as_str()?;
                Self::parse(text).ok_or_else(|| {
                    FromSqlError::Other(
                        format!("{} desconhecido na fila: {text}", stringify!($name)).into(),
                    )
                })
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }
    };
}

text_enum! {
    /// The recording kind (`kind` in the contract).
    Kind {
        /// Meeting or manual recording: microphone and system audio.
        Meeting = "meeting",
        /// Voice note: microphone only, with silence stop.
        Note = "note",
    }
}

text_enum! {
    /// Where the start date came from (`recorded_at_source` in the contract).
    RecordedAtSource {
        /// The computer clock at capture time.
        Capture = "capture",
        /// Read from the imported file's metadata and confirmed.
        FileMetadata = "file_metadata",
        /// Entered by the person on import.
        User = "user",
    }
}

text_enum! {
    /// How the audio arrived (`source` in the contract).
    Source {
        /// Recorded by the desktop app.
        Desktop = "desktop",
        /// Recorded by the mobile app.
        Mobile = "mobile",
        /// Imported file.
        Upload = "upload",
    }
}

/// An imported file, ready to enter the queue.
#[derive(Clone, Debug)]
pub struct NewImport<'a> {
    pub id: &'a str,
    /// The file in `gravacoes/` (converted to Opus or a copy of the original).
    pub path: &'a Path,
    /// Recording start, in Unix ms.
    pub recorded_at: i64,
    pub recorded_at_source: RecordedAtSource,
    /// Selected file name, without extension.
    pub original_name: &'a str,
    /// Type of the file at `path`; `None` for Ogg/Opus.
    pub content_type: Option<&'a str>,
    pub duration_ms: i64,
    pub bytes: i64,
}

/// A recording marker: a moment in the audio, with an optional note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Marker {
    /// UUID v4, the upload idempotency key.
    pub client_id: String,
    pub recording_id: String,
    /// Position in the audio, in ms.
    pub at_ms: i64,
    pub note: Option<String>,
    pub created_at: i64,
}

impl Marker {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            client_id: row.get("client_id")?,
            recording_id: row.get("recording_id")?,
            at_ms: row.get("at_ms")?,
            note: row.get("note")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// Wait before the next attempt, after `attempts` attempts: 30 s doubling with each failure, up
/// to 1 h.
pub fn retry_backoff_ms(attempts: i64) -> i64 {
    const BASE_MS: i64 = 30_000;
    const MAX_MS: i64 = 3_600_000;
    let exponent = u32::try_from(attempts.saturating_sub(1).clamp(0, 16)).unwrap_or(16);
    BASE_MS.saturating_mul(1_i64 << exponent).min(MAX_MS)
}

/// State of a recording in the queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Recording,
    Pending,
    Syncing,
    Synced,
    Failed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Pending => "pending",
            Self::Syncing => "syncing",
            Self::Synced => "synced",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "recording" => Self::Recording,
            "pending" => Self::Pending,
            "syncing" => Self::Syncing,
            "synced" => Self::Synced,
            "failed" => Self::Failed,
            other => bail!("estado desconhecido na fila: {other}"),
        })
    }
}

/// A recording in the queue.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct QueuedRecording {
    pub id: String,
    pub path: PathBuf,
    /// Start, in milliseconds since the Unix epoch.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    pub status: Status,
    /// The recording was cut short by an unexpected shutdown.
    pub interrupted: bool,
    pub attempts: i64,
    pub last_error: Option<String>,
    /// Recording identifier on the server, after sync.
    pub remote_id: Option<String>,
    /// Ongoing upload on the server, for resumption.
    pub upload_id: Option<String>,
    /// File SHA-256 (hex), calculated once for upload.
    pub sha256: Option<String>,
    /// When the next attempt becomes available after a failure.
    pub next_attempt_at: Option<i64>,
    /// When the server confirmed the recording.
    pub synced_at: Option<i64>,
    /// When retention deleted the local file.
    pub purged_at: Option<i64>,
    /// Detected meeting app, in the contract vocabulary (`capture.meeting_app`).
    pub meeting_app: Option<String>,
    pub kind: Kind,
    pub recorded_at_source: RecordedAtSource,
    pub source: Source,
    /// Imported file name, without extension.
    pub original_name: Option<String>,
    /// File type; `None` means Ogg/Opus.
    pub content_type: Option<String>,
    /// Title chosen on stop; `None` lets the server derive it.
    pub title: Option<String>,
    /// Agenda type chosen on stop (server UUID).
    pub agenda_type_id: Option<String>,
    /// The person can still provide title and type: sync waits.
    pub details_pending: bool,
    /// The title the server gave the recording after processing.
    pub server_title: Option<String>,
    /// Transcript language chosen for the recording (`pt`, `auto`…); `None` uses the device
    /// language.
    pub language: Option<String>,
}

impl QueuedRecording {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<(Self, String)> {
        let status: String = row.get("status")?;
        let path: String = row.get("path")?;
        Ok((
            Self {
                id: row.get("id")?,
                path: PathBuf::from(path),
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                duration_ms: row.get("duration_ms")?,
                bytes: row.get("bytes")?,
                status: Status::Pending,
                interrupted: row.get::<_, i64>("interrupted")? != 0,
                attempts: row.get("attempts")?,
                last_error: row.get("last_error")?,
                remote_id: row.get("remote_id")?,
                upload_id: row.get("upload_id")?,
                sha256: row.get("sha256")?,
                next_attempt_at: row.get("next_attempt_at")?,
                synced_at: row.get("synced_at")?,
                purged_at: row.get("purged_at")?,
                meeting_app: row.get("meeting_app")?,
                kind: row.get("kind")?,
                recorded_at_source: row.get("recorded_at_source")?,
                source: row.get("source")?,
                original_name: row.get("original_name")?,
                content_type: row.get("content_type")?,
                title: row.get("title")?,
                agenda_type_id: row.get("agenda_type_id")?,
                details_pending: row.get::<_, i64>("details_pending")? != 0,
                server_title: row.get("server_title")?,
                language: row.get("language")?,
            },
            status,
        ))
    }
}

/// How many recordings are in each state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct QueueCounts {
    pub recording: u32,
    pub pending: u32,
    pub syncing: u32,
    pub synced: u32,
    pub failed: u32,
}

impl QueueCounts {
    /// Recordings that have not yet reached the server.
    pub fn unsynced(&self) -> u32 {
        self.pending + self.syncing + self.failed
    }
}

/// Milliseconds since the Unix epoch, now.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The queue, over a SQLite connection.
pub struct Queue {
    conn: Connection,
}

impl Queue {
    /// Opens (or creates) the queue at the given file.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("falha ao criar {}", dir.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("falha ao abrir a fila em {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    /// In-memory queue, for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)
            .context("falha ao criar o esquema da fila")?;
        migrate(&conn).context("falha ao migrar a fila")?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self { conn })
    }

    /// Registers the start of a recording.
    pub fn begin(&self, id: &str, path: &Path, started_at: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO recordings (id, path, started_at, status) VALUES (?1, ?2, ?3, 'recording')",
                params![id, path.to_string_lossy(), started_at],
            )
            .context("falha ao registrar o início da gravação")?;
        Ok(())
    }

    /// Closes a recording: it starts waiting for sync.
    pub fn finish(
        &self,
        id: &str,
        path: &Path,
        ended_at: i64,
        duration_ms: i64,
        bytes: i64,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET path = ?2, ended_at = ?3, duration_ms = ?4, bytes = ?5, status = 'pending'
             WHERE id = ?1 AND status = 'recording'",
            params![id, path.to_string_lossy(), ended_at, duration_ms, bytes],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está em andamento");
        }
        Ok(())
    }

    /// Marks a closed recording as interrupted (the recording thread failed midway).
    pub fn mark_interrupted(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET interrupted = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Recovers recordings left in `recording` without a live session (`live`): the process
    /// died midway, or the `.part` remained locked on stop. They become `pending` with
    /// `interrupted = 1`. The caller fixes the files (`fix_file`) before writing final path and
    /// size; a row whose `fix_file` fails stays in `recording`, logged, and the others
    /// continue. Returns the recovered recordings.
    pub fn recover_interrupted(
        &self,
        live: &[&str],
        mut fix_file: impl FnMut(&QueuedRecording) -> Result<(PathBuf, i64)>,
    ) -> Result<Vec<QueuedRecording>> {
        let orphans = self.by_status(Status::Recording)?;
        let mut recovered = Vec::with_capacity(orphans.len());
        for orphan in orphans {
            if live.contains(&orphan.id.as_str()) {
                continue;
            }
            let (path, bytes) = match fix_file(&orphan) {
                Ok(fixed) => fixed,
                Err(err) => {
                    log::warn!("recording {} remains in progress: {err:#}", orphan.id);
                    continue;
                }
            };
            self.conn.execute(
                "UPDATE recordings SET path = ?2, bytes = ?3, ended_at = COALESCE(ended_at, ?4),
                 status = 'pending', interrupted = 1 WHERE id = ?1",
                params![orphan.id, path.to_string_lossy(), bytes, now_ms()],
            )?;
            recovered.push(self.get(&orphan.id)?.context("gravação sumiu da fila")?);
        }
        Ok(recovered)
    }

    /// Claims the next recording to sync (the oldest `pending`) and marks it `syncing`. A
    /// recording with `details_pending` is excluded until [`DETAILS_WAIT_MS`] after its end.
    pub fn claim_next(&mut self) -> Result<Option<QueuedRecording>> {
        let tx = self.conn.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM recordings WHERE status = 'pending'
                   AND (details_pending = 0 OR COALESCE(ended_at, started_at) <= ?1)
                 ORDER BY started_at LIMIT 1",
                params![now_ms().saturating_sub(DETAILS_WAIT_MS)],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            return Ok(None);
        };
        tx.execute(
            "UPDATE recordings SET status = 'syncing', attempts = attempts + 1 WHERE id = ?1",
            params![id],
        )?;
        tx.commit()?;
        self.get(&id)
    }

    /// Returns the recording claimed by [`Queue::claim_next`] whose sync was interrupted to
    /// `pending`, undoing `attempts + 1`: interruption is not failure.
    pub fn release_claim(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET status = 'pending', attempts = MAX(attempts - 1, 0)
             WHERE id = ?1 AND status = 'syncing'",
            params![id],
        )?;
        Ok(())
    }

    /// Returns failures with fewer than `max_attempts` attempts to `pending`, without waiting
    /// for backoff (the user changed the PAT or requested a retry).
    pub fn retry_failed(&self, max_attempts: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending' WHERE status = 'failed' AND attempts < ?1",
            params![max_attempts],
        )?)
    }

    /// Returns failures whose backoff expired by `now` (Unix ms), with fewer than
    /// `max_attempts` attempts, to `pending`.
    pub fn retry_due(&self, now: i64, max_attempts: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending'
             WHERE status = 'failed' AND attempts < ?1
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)",
            params![max_attempts, now],
        )?)
    }

    /// Marks the recording as synced: the server confirmed `remote_id`.
    pub fn mark_synced(&self, id: &str, remote_id: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET status = 'synced', remote_id = ?2, last_error = NULL,
             next_attempt_at = NULL, synced_at = ?3
             WHERE id = ?1 AND status = 'syncing'",
            params![id, remote_id, now_ms()],
        )?;
        ensure_changed(id, changed)
    }

    /// Marks the sync attempt as failed and schedules the next through [`retry_backoff_ms`];
    /// `retry_due` returns it to the queue when the deadline expires.
    pub fn mark_failed(&self, id: &str, error: &str) -> Result<()> {
        let attempts: Option<i64> = self
            .conn
            .query_row(
                "SELECT attempts FROM recordings WHERE id = ?1 AND status = 'syncing'",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(attempts) = attempts else {
            bail!("gravação {id} não está em sync");
        };
        let next = now_ms().saturating_add(retry_backoff_ms(attempts));
        let changed = self.conn.execute(
            "UPDATE recordings SET status = 'failed', last_error = ?2, next_attempt_at = ?3
             WHERE id = ?1 AND status = 'syncing'",
            params![id, error, next],
        )?;
        ensure_changed(id, changed)
    }

    /// Stores (or clears, with `None`) the ongoing upload and file hash, for resumption.
    pub fn set_upload_state(
        &self,
        id: &str,
        upload_id: Option<&str>,
        sha256: Option<&str>,
    ) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET upload_id = ?2, sha256 = ?3 WHERE id = ?1",
            params![id, upload_id, sha256],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está na fila");
        }
        Ok(())
    }

    /// Stores the title the server gave recording `remote_id`; `true` if any row changed.
    pub fn set_server_title(&self, remote_id: &str, title: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE recordings SET server_title = ?2 WHERE remote_id = ?1 AND server_title IS NOT ?2",
            params![remote_id, title],
        )?;
        Ok(changed > 0)
    }

    /// Registers the meeting app that originated the recording.
    pub fn set_meeting_app(&self, id: &str, meeting_app: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET meeting_app = ?2 WHERE id = ?1",
            params![id, meeting_app],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está na fila");
        }
        Ok(())
    }

    /// Changes the recording kind (a voice note starts as a recording and becomes `note` right
    /// after).
    pub fn set_kind(&self, id: &str, kind: Kind) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET kind = ?2 WHERE id = ?1",
            params![id, kind],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está na fila");
        }
        Ok(())
    }

    /// Changes the recording source (the mobile app records with `source = mobile`).
    pub fn set_source(&self, id: &str, source: Source) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET source = ?2 WHERE id = ?1",
            params![id, source],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está na fila");
        }
        Ok(())
    }

    /// Holds recording sync until the person provides title and type, or skips.
    pub fn set_details_pending(&self, id: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET details_pending = 1 WHERE id = ?1",
            params![id],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está na fila");
        }
        Ok(())
    }

    /// Saves title, agenda type and language (empty values become `None`) and releases sync. To
    /// skip, call with all three set to `None`.
    pub fn save_details(
        &self,
        id: &str,
        title: Option<&str>,
        agenda_type_id: Option<&str>,
        language: Option<&str>,
    ) -> Result<()> {
        self.ensure_editable(id)?;
        self.conn.execute(
            "UPDATE recordings SET title = ?2, agenda_type_id = ?3, language = ?4, details_pending = 0
             WHERE id = ?1",
            params![id, filled(title), filled(agenda_type_id), filled(language)],
        )?;
        Ok(())
    }

    /// Releases recordings waiting for title and type: on the next startup, the sheet holding
    /// sync no longer exists.
    pub fn release_details_pending(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET details_pending = 0 WHERE details_pending = 1",
            [],
        )?)
    }

    /// Registers an imported file, already ready: starts as `pending`, with `source = upload`.
    pub fn begin_import(&self, import: &NewImport<'_>) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO recordings (id, path, started_at, ended_at, duration_ms, bytes, status,
                     recorded_at_source, source, original_name, content_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 'upload', ?8, ?9)",
                params![
                    import.id,
                    import.path.to_string_lossy(),
                    import.recorded_at,
                    import.recorded_at.saturating_add(import.duration_ms),
                    import.duration_ms,
                    import.bytes,
                    import.recorded_at_source,
                    import.original_name,
                    import.content_type,
                ],
            )
            .context("falha ao registrar o arquivo importado")?;
        Ok(())
    }

    /// Removes a recording that has not been uploaded (the voice note without speech) and its
    /// markers from the queue. Returns the removed row so the caller can delete the file.
    pub fn discard(&mut self, id: &str) -> Result<QueuedRecording> {
        let recording = self
            .get(id)?
            .with_context(|| format!("gravação {id} não está na fila"))?;
        if matches!(recording.status, Status::Syncing | Status::Synced) {
            bail!("gravação {id} já foi para o servidor");
        }
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM markers WHERE recording_id = ?1", params![id])?;
        tx.execute("DELETE FROM recordings WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(recording)
    }

    /// Adds a marker at `at_ms` to a recording that has not been uploaded.
    pub fn add_marker(&self, recording_id: &str, at_ms: i64, note: Option<&str>) -> Result<Marker> {
        self.ensure_editable(recording_id)?;
        let marker = Marker {
            client_id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.to_string(),
            at_ms: at_ms.max(0),
            note: checked_note(note)?,
            created_at: now_ms(),
        };
        self.conn.execute(
            "INSERT INTO markers (client_id, recording_id, at_ms, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                marker.client_id,
                marker.recording_id,
                marker.at_ms,
                marker.note,
                marker.created_at
            ],
        )?;
        Ok(marker)
    }

    /// Changes a marker's note (empty clears it) while the recording has not been uploaded.
    pub fn set_marker_note(&self, client_id: &str, note: Option<&str>) -> Result<Marker> {
        let marker = self
            .conn
            .query_row(
                "SELECT * FROM markers WHERE client_id = ?1",
                params![client_id],
                Marker::from_row,
            )
            .optional()?
            .with_context(|| format!("marcador {client_id} não existe"))?;
        self.ensure_editable(&marker.recording_id)?;
        let note = checked_note(note)?;
        self.conn.execute(
            "UPDATE markers SET note = ?2 WHERE client_id = ?1",
            params![client_id, note],
        )?;
        Ok(Marker { note, ..marker })
    }

    /// A recording's markers, in audio order.
    pub fn markers(&self, recording_id: &str) -> Result<Vec<Marker>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM markers WHERE recording_id = ?1 ORDER BY at_ms, created_at")?;
        let rows = stmt.query_map(params![recording_id], Marker::from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Markers only change before upload: after that, editing happens on the web.
    fn ensure_editable(&self, recording_id: &str) -> Result<()> {
        match self.get(recording_id)? {
            None => bail!("gravação {recording_id} não está na fila"),
            Some(rec) if matches!(rec.status, Status::Syncing | Status::Synced) => {
                bail!("a gravação já foi para o servidor: edite os marcadores na web")
            }
            // The resumed upload carries the markers from when it was created.
            Some(rec) if rec.upload_id.is_some() => {
                bail!("o envio desta gravação já começou: edite os marcadores na web")
            }
            Some(_) => Ok(()),
        }
    }

    /// Recordings confirmed by `synced_before` (Unix ms) whose local file still exists.
    pub fn purge_candidates(&self, synced_before: i64) -> Result<Vec<QueuedRecording>> {
        self.query(
            "SELECT * FROM recordings
             WHERE status = 'synced' AND remote_id IS NOT NULL AND purged_at IS NULL
               AND synced_at IS NOT NULL AND synced_at <= ?1
             ORDER BY started_at",
            params![synced_before],
        )
    }

    /// Records that a confirmed recording's local file was deleted.
    pub fn mark_purged(&self, id: &str, at: i64) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET purged_at = ?2
             WHERE id = ?1 AND status = 'synced' AND purged_at IS NULL",
            params![id, at],
        )?;
        if changed == 0 {
            bail!("gravação {id} não está sincronizada ou já foi apagada");
        }
        Ok(())
    }

    /// Returns recordings left in `syncing` when the process died during upload to `pending`.
    pub fn release_stale_syncing(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending' WHERE status = 'syncing'",
            [],
        )?)
    }

    pub fn get(&self, id: &str) -> Result<Option<QueuedRecording>> {
        let row = self
            .conn
            .query_row(
                "SELECT * FROM recordings WHERE id = ?1",
                params![id],
                QueuedRecording::from_row,
            )
            .optional()?;
        row.map(with_status).transpose()
    }

    /// Most recent recordings first.
    pub fn list(&self, limit: u32) -> Result<Vec<QueuedRecording>> {
        self.query(
            "SELECT * FROM recordings ORDER BY started_at DESC LIMIT ?1",
            params![limit],
        )
    }

    pub fn by_status(&self, status: Status) -> Result<Vec<QueuedRecording>> {
        self.query(
            "SELECT * FROM recordings WHERE status = ?1 ORDER BY started_at",
            params![status.as_str()],
        )
    }

    pub fn counts(&self) -> Result<QueueCounts> {
        let mut counts = QueueCounts::default();
        let mut stmt = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM recordings GROUP BY status")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })?;
        for row in rows {
            let (status, n) = row?;
            match Status::parse(&status)? {
                Status::Recording => counts.recording = n,
                Status::Pending => counts.pending = n,
                Status::Syncing => counts.syncing = n,
                Status::Synced => counts.synced = n,
                Status::Failed => counts.failed = n,
            }
        }
        Ok(counts)
    }

    fn query(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<QueuedRecording>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, QueuedRecording::from_row)?;
        rows.map(|row| with_status(row?)).collect()
    }
}

/// The trimmed note; empty becomes `None`, and more than [`MAX_MARKER_NOTE`] characters is an
/// error.
fn checked_note(note: Option<&str>) -> Result<Option<String>> {
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > MAX_MARKER_NOTE) {
        bail!("a nota do marcador passa de {MAX_MARKER_NOTE} caracteres");
    }
    Ok(note.map(str::to_string))
}

fn ensure_changed(id: &str, changed: usize) -> Result<()> {
    if changed == 0 {
        bail!("gravação {id} não está em sync");
    }
    Ok(())
}

/// Adds v2 to v6 columns to an older queue (`CREATE TABLE IF NOT EXISTS` does not change an
/// existing table; the `markers` table is created in `SCHEMA`).
fn migrate(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('recordings')")?;
    let existing = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (column, kind) in ADDED_COLUMNS {
        if !existing.iter().any(|name| name == column) {
            conn.execute_batch(&format!(
                "ALTER TABLE recordings ADD COLUMN {column} {kind}"
            ))?;
        }
    }
    Ok(())
}

/// The trimmed text, or `None` if empty.
fn filled(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn with_status((mut recording, status): (QueuedRecording, String)) -> Result<QueuedRecording> {
    recording.status = Status::parse(&status)?;
    Ok(recording)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin_and_finish(queue: &Queue, id: &str, started_at: i64) {
        queue
            .begin(id, Path::new(&format!("/tmp/{id}.ogg.part")), started_at)
            .unwrap();
        queue
            .finish(
                id,
                Path::new(&format!("/tmp/{id}.ogg")),
                started_at + 1_000,
                1_000,
                3_000,
            )
            .unwrap();
    }

    #[test]
    fn queue_persists_between_opens() {
        let dir = std::env::temp_dir().join(format!("eclume-queue-{}", now_ms()));
        let db = dir.join("queue.sqlite");
        {
            let queue = Queue::open(&db).unwrap();
            begin_and_finish(&queue, "a", 10);
        }
        let queue = Queue::open(&db).unwrap();
        let rec = queue.get("a").unwrap().unwrap();
        assert_eq!(rec.status, Status::Pending);
        assert_eq!(rec.path, PathBuf::from("/tmp/a.ogg"));
        assert_eq!(rec.duration_ms, Some(1_000));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queue_full_sync_cycle() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "velha", 1);
        begin_and_finish(&queue, "nova", 2);

        let first = queue.claim_next().unwrap().unwrap();
        assert_eq!(first.id, "velha");
        assert_eq!(first.status, Status::Syncing);
        assert_eq!(first.attempts, 1);
        queue.mark_synced("velha", "srv-1").unwrap();

        let second = queue.claim_next().unwrap().unwrap();
        assert_eq!(second.id, "nova");
        queue.mark_failed("nova", "rede fora").unwrap();
        let failed = queue.get("nova").unwrap().unwrap();
        assert_eq!(failed.status, Status::Failed);
        assert_eq!(failed.last_error.as_deref(), Some("rede fora"));

        // A failure only returns to the queue through `retry_failed`, up to the attempt limit.
        assert!(queue.claim_next().unwrap().is_none());
        assert_eq!(queue.retry_failed(3).unwrap(), 1);
        assert_eq!(queue.claim_next().unwrap().unwrap().id, "nova");
        queue.mark_failed("nova", "de novo").unwrap();
        assert_eq!(queue.retry_failed(2).unwrap(), 0);
        assert!(queue.claim_next().unwrap().is_none());

        let counts = queue.counts().unwrap();
        assert_eq!(counts.synced, 1);
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.unsynced(), 1);
        assert_eq!(
            queue.get("velha").unwrap().unwrap().remote_id.as_deref(),
            Some("srv-1")
        );
    }

    #[test]
    fn queue_recovers_interrupted_recording() {
        let queue = Queue::open_in_memory().unwrap();
        queue
            .begin("crash", Path::new("/tmp/crash.ogg.part"), 5)
            .unwrap();
        let recovered = queue
            .recover_interrupted(&[], |rec| {
                assert_eq!(rec.status, Status::Recording);
                Ok((rec.path.with_extension(""), 1_234))
            })
            .unwrap();
        assert_eq!(recovered.len(), 1);
        let rec = &recovered[0];
        assert_eq!(rec.status, Status::Pending);
        assert!(rec.interrupted);
        assert_eq!(rec.path, PathBuf::from("/tmp/crash.ogg"));
        assert_eq!(rec.bytes, Some(1_234));
        assert!(queue.by_status(Status::Recording).unwrap().is_empty());
    }

    #[test]
    fn queue_rejects_invalid_transition_and_releases_orphaned_sync() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "x", 1);
        assert!(queue.mark_synced("x", "srv").is_err());
        assert!(queue.finish("x", Path::new("/tmp/x.ogg"), 2, 1, 1).is_err());
        queue.claim_next().unwrap().unwrap();
        assert_eq!(queue.release_stale_syncing().unwrap(), 1);
        assert_eq!(queue.get("x").unwrap().unwrap().status, Status::Pending);
        assert_eq!(queue.list(10).unwrap().len(), 1);
    }

    #[test]
    fn queue_backoff_doubles_up_to_one_hour() {
        assert_eq!(retry_backoff_ms(0), 30_000);
        assert_eq!(retry_backoff_ms(1), 30_000);
        assert_eq!(retry_backoff_ms(2), 60_000);
        assert_eq!(retry_backoff_ms(4), 240_000);
        assert_eq!(retry_backoff_ms(8), 3_600_000);
        assert_eq!(retry_backoff_ms(i64::MAX), 3_600_000);
    }

    #[test]
    fn queue_failure_only_returns_after_backoff_expires() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "r", 1);
        queue.claim_next().unwrap().unwrap();
        let before = now_ms();
        queue.mark_failed("r", "rede fora").unwrap();
        let failed = queue.get("r").unwrap().unwrap();
        let next = failed.next_attempt_at.unwrap();
        assert!(next >= before + 30_000 && next <= now_ms() + 30_000);

        assert_eq!(queue.retry_due(next - 1, i64::MAX).unwrap(), 0);
        assert_eq!(queue.retry_due(next, 2).unwrap(), 1);
        queue.claim_next().unwrap().unwrap();
        queue.mark_failed("r", "de novo").unwrap();
        // Second failure: the wait doubles, and the attempt limit applies.
        let again = queue.get("r").unwrap().unwrap();
        assert!(again.next_attempt_at.unwrap() - now_ms() > 30_000);
        assert_eq!(queue.retry_due(i64::MAX, 2).unwrap(), 0);
        assert_eq!(queue.retry_due(i64::MAX, 3).unwrap(), 1);
        assert!(queue.mark_failed("r", "fora de sync").is_err());
    }

    #[test]
    fn queue_stores_resumption_and_confirmation_state() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "u", 1);
        queue
            .set_upload_state("u", Some("up-1"), Some("ab12"))
            .unwrap();
        let rec = queue.claim_next().unwrap().unwrap();
        assert_eq!(rec.upload_id.as_deref(), Some("up-1"));
        assert_eq!(rec.sha256.as_deref(), Some("ab12"));
        queue.mark_synced("u", "srv-u").unwrap();
        let synced = queue.get("u").unwrap().unwrap();
        assert!(synced.synced_at.is_some());
        assert!(synced.next_attempt_at.is_none());
        queue.set_upload_state("u", None, Some("ab12")).unwrap();
        queue.set_meeting_app("u", "teams").unwrap();
        assert_eq!(
            queue.get("u").unwrap().unwrap().meeting_app.as_deref(),
            Some("teams")
        );
        assert!(queue.set_meeting_app("nao-existe", "zoom").is_err());
        assert!(queue.get("u").unwrap().unwrap().upload_id.is_none());
        assert!(queue.set_upload_state("nao-existe", None, None).is_err());
    }

    #[test]
    fn queue_retention_only_deletes_server_confirmed_recordings() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "ok", 1);
        begin_and_finish(&queue, "falhou", 2);
        begin_and_finish(&queue, "pendente", 3);
        queue.claim_next().unwrap().unwrap();
        queue.mark_synced("ok", "srv-ok").unwrap();
        queue.claim_next().unwrap().unwrap();
        queue.mark_failed("falhou", "x").unwrap();

        assert!(queue.purge_candidates(0).unwrap().is_empty());
        let due = queue.purge_candidates(i64::MAX).unwrap();
        assert_eq!(
            due.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["ok"]
        );
        queue.mark_purged("ok", 42).unwrap();
        assert_eq!(queue.get("ok").unwrap().unwrap().purged_at, Some(42));
        assert!(queue.purge_candidates(i64::MAX).unwrap().is_empty());
        assert!(queue.mark_purged("ok", 43).is_err());
        assert!(queue.mark_purged("pendente", 43).is_err());
    }

    #[test]
    fn queue_migrates_real_v2_queue_with_v4_defaults() {
        let dir = std::env::temp_dir().join(format!("eclume-queue-v2-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("queue.sqlite");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/queue-v2.sqlite"),
            &db,
        )
        .unwrap();

        let queue = Queue::open(&db).unwrap();
        let version: i32 = queue
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let rows = queue.list(10).unwrap();
        assert_eq!(rows.len(), 3);
        for rec in &rows {
            assert_eq!(rec.kind, Kind::Meeting);
            assert_eq!(rec.recorded_at_source, RecordedAtSource::Capture);
            assert_eq!(rec.source, Source::Desktop);
            assert_eq!(rec.original_name, None);
            assert_eq!(rec.content_type, None);
            assert_eq!(rec.title, None);
            assert_eq!(rec.agenda_type_id, None);
            assert!(!rec.details_pending);
        }
        let synced = queue.get("1790000000000-a1b2").unwrap().unwrap();
        assert_eq!(synced.status, Status::Synced);
        assert_eq!(synced.meeting_app.as_deref(), Some("teams"));
        let failed = queue.get("1790100000000-c3d4").unwrap().unwrap();
        assert_eq!(failed.upload_id.as_deref(), Some("up-9"));
        assert!(
            queue
                .get("1790200000000-e5f6")
                .unwrap()
                .unwrap()
                .interrupted
        );

        let marker = queue
            .add_marker("1790200000000-e5f6", 1_500, Some("decisão"))
            .unwrap();
        drop(queue);
        let queue = Queue::open(&db).unwrap();
        assert_eq!(queue.markers("1790200000000-e5f6").unwrap(), [marker]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queue_voice_note_import_and_discard() {
        let mut queue = Queue::open_in_memory().unwrap();
        queue
            .begin("nota", Path::new("/tmp/nota.ogg.part"), 5)
            .unwrap();
        queue.set_kind("nota", Kind::Note).unwrap();
        assert!(queue.set_kind("nao-existe", Kind::Note).is_err());
        queue.add_marker("nota", 10, None).unwrap();
        let discarded = queue.discard("nota").unwrap();
        assert_eq!(discarded.kind, Kind::Note);
        assert!(queue.get("nota").unwrap().is_none());
        assert!(queue.markers("nota").unwrap().is_empty());

        let path = PathBuf::from("/tmp/imp.ogg");
        queue
            .begin_import(&NewImport {
                id: "imp",
                path: &path,
                recorded_at: 1_000,
                recorded_at_source: RecordedAtSource::FileMetadata,
                original_name: "kickoff-guion",
                content_type: None,
                duration_ms: 2_832_000,
                bytes: 9_000,
            })
            .unwrap();
        let imported = queue.get("imp").unwrap().unwrap();
        assert_eq!(imported.status, Status::Pending);
        assert_eq!(imported.source, Source::Upload);
        assert_eq!(imported.kind, Kind::Meeting);
        assert_eq!(imported.recorded_at_source, RecordedAtSource::FileMetadata);
        assert_eq!(imported.original_name.as_deref(), Some("kickoff-guion"));
        assert_eq!(imported.ended_at, Some(2_833_000));
        assert_eq!(imported.path, path);

        let json = serde_json::to_value(&imported).unwrap();
        assert_eq!(json["kind"], "meeting");
        assert_eq!(json["recorded_at_source"], "file_metadata");
        assert_eq!(json["source"], "upload");

        queue.claim_next().unwrap().unwrap();
        assert!(queue.discard("imp").is_err(), "uploads are not discarded");
    }

    #[test]
    fn queue_ordered_markers_with_limited_notes_until_upload() {
        let mut queue = Queue::open_in_memory().unwrap();
        queue.begin("g", Path::new("/tmp/g.ogg.part"), 1).unwrap();
        let late = queue.add_marker("g", 9_000, Some("  ")).unwrap();
        let early = queue.add_marker("g", 2_000, Some(" ação ")).unwrap();
        assert_eq!(late.note, None);
        assert_eq!(early.note.as_deref(), Some("ação"));
        assert_ne!(late.client_id, early.client_id);
        assert_eq!(
            uuid::Uuid::parse_str(&early.client_id)
                .unwrap()
                .get_version_num(),
            4
        );
        assert_eq!(
            queue
                .markers("g")
                .unwrap()
                .iter()
                .map(|m| m.at_ms)
                .collect::<Vec<_>>(),
            [2_000, 9_000]
        );

        let long = "é".repeat(MAX_MARKER_NOTE + 1);
        assert!(queue.add_marker("g", 1, Some(&long)).is_err());
        assert!(queue.set_marker_note(&late.client_id, Some(&long)).is_err());
        let limit = "é".repeat(MAX_MARKER_NOTE);
        let edited = queue
            .set_marker_note(&late.client_id, Some(&limit))
            .unwrap();
        assert_eq!(edited.note.as_deref(), Some(limit.as_str()));
        assert!(queue.set_marker_note("nao-existe", None).is_err());
        assert!(queue.add_marker("nao-existe", 1, None).is_err());

        queue
            .finish("g", Path::new("/tmp/g.ogg"), 2, 10_000, 3)
            .unwrap();
        queue.add_marker("g", 9_500, None).unwrap();
        queue.claim_next().unwrap().unwrap();
        assert!(queue.add_marker("g", 9_900, None).is_err());
        assert!(queue.set_marker_note(&early.client_id, None).is_err());
        assert_eq!(queue.markers("g").unwrap().len(), 3);

        // Failed with the upload already created: resumption would carry the old markers.
        queue
            .set_upload_state("g", Some("up-1"), Some("ab12"))
            .unwrap();
        queue.mark_failed("g", "rede").unwrap();
        assert!(queue.add_marker("g", 9_900, None).is_err());
        queue.set_upload_state("g", None, None).unwrap();
        queue.add_marker("g", 9_900, None).unwrap();
    }

    #[test]
    fn queue_details_hold_sync_until_saved_or_expired() {
        let mut queue = Queue::open_in_memory().unwrap();
        let now = now_ms();
        begin_and_finish(&queue, "folha", now);
        queue.set_source("folha", Source::Mobile).unwrap();
        queue.set_details_pending("folha").unwrap();
        assert!(queue.get("folha").unwrap().unwrap().details_pending);
        assert!(queue.claim_next().unwrap().is_none());

        queue
            .save_details(
                "folha",
                Some("  Visita ao cliente "),
                Some(""),
                Some("auto"),
            )
            .unwrap();
        let rec = queue.claim_next().unwrap().unwrap();
        assert_eq!(rec.id, "folha");
        assert_eq!(rec.source, Source::Mobile);
        assert_eq!(rec.title.as_deref(), Some("Visita ao cliente"));
        assert_eq!(rec.agenda_type_id, None);
        assert_eq!(rec.language.as_deref(), Some("auto"));
        assert!(!rec.details_pending);
        // After leaving for the server, title and type can no longer change here.
        assert!(queue
            .save_details("folha", Some("outro"), None, None)
            .is_err());

        // A sheet left open does not hold sync forever.
        begin_and_finish(&queue, "esquecida", 1);
        queue.set_details_pending("esquecida").unwrap();
        assert_eq!(queue.claim_next().unwrap().unwrap().id, "esquecida");

        // On the next startup, the flag for a sheet that no longer exists is cleared (including
        // the forgotten one).
        begin_and_finish(&queue, "reaberta", now);
        queue.set_details_pending("reaberta").unwrap();
        assert_eq!(queue.release_details_pending().unwrap(), 2);
        assert_eq!(queue.claim_next().unwrap().unwrap().id, "reaberta");
        assert!(queue.set_details_pending("nao-existe").is_err());
    }

    #[test]
    fn queue_migrates_v1_queue_without_losing_rows() {
        let dir = std::env::temp_dir().join(format!("eclume-queue-v1-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("queue.sqlite");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE recordings (
                    id TEXT PRIMARY KEY, path TEXT NOT NULL, started_at INTEGER NOT NULL,
                    ended_at INTEGER, duration_ms INTEGER, bytes INTEGER,
                    status TEXT NOT NULL CHECK (status IN ('recording','pending','syncing','synced','failed')),
                    interrupted INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT, remote_id TEXT);
                 INSERT INTO recordings (id, path, started_at, status) VALUES ('velha', '/tmp/v.ogg', 7, 'pending');
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }
        let mut queue = Queue::open(&db).unwrap();
        let version: i32 = queue
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let rec = queue.claim_next().unwrap().unwrap();
        assert_eq!(rec.id, "velha");
        assert!(rec.upload_id.is_none());
        assert!(rec.server_title.is_none());
        assert!(rec.language.is_none());
        queue.set_upload_state("velha", Some("up"), None).unwrap();
        queue.mark_synced("velha", "srv-velha").unwrap();
        assert!(queue.set_server_title("srv-velha", "Alinhamento").unwrap());
        assert!(!queue.set_server_title("srv-velha", "Alinhamento").unwrap());
        assert!(!queue.set_server_title("srv-outra", "Alinhamento").unwrap());
        drop(queue);
        // Reopening an already migrated queue changes nothing.
        let queue = Queue::open(&db).unwrap();
        let old = queue.get("velha").unwrap().unwrap();
        assert_eq!(old.upload_id.as_deref(), Some("up"));
        assert_eq!(old.server_title.as_deref(), Some("Alinhamento"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
