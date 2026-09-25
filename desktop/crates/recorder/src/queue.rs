//! Fila local e persistente das gravações, em SQLite.
//!
//! Uma linha por gravação, com o ciclo `recording → pending → syncing → synced | failed`.
//! `failed` volta a `syncing` numa nova tentativa. Uma linha que ficou em `recording` quando o
//! processo morreu é recuperada na abertura seguinte como `pending` com `interrupted = 1`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

const SCHEMA_VERSION: i32 = 1;

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
    remote_id   TEXT
);
CREATE INDEX IF NOT EXISTS recordings_status ON recordings (status, started_at);
";

/// Estado de uma gravação na fila.
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

/// Uma gravação na fila.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct QueuedRecording {
    pub id: String,
    pub path: PathBuf,
    /// Início, em milissegundos desde a época Unix.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    pub status: Status,
    /// A gravação foi cortada por um encerramento inesperado.
    pub interrupted: bool,
    pub attempts: i64,
    pub last_error: Option<String>,
    /// Identificador da gravação no servidor, depois do sync.
    pub remote_id: Option<String>,
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
            },
            status,
        ))
    }
}

/// Quantas gravações há em cada estado.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct QueueCounts {
    pub recording: u32,
    pub pending: u32,
    pub syncing: u32,
    pub synced: u32,
    pub failed: u32,
}

impl QueueCounts {
    /// Gravações que ainda não chegaram ao servidor.
    pub fn unsynced(&self) -> u32 {
        self.pending + self.syncing + self.failed
    }
}

/// Milissegundos desde a época Unix, agora.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A fila, sobre uma conexão SQLite.
pub struct Queue {
    conn: Connection,
}

impl Queue {
    /// Abre (ou cria) a fila no arquivo dado.
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

    /// Fila em memória, para testes.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)
            .context("falha ao criar o esquema da fila")?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self { conn })
    }

    /// Registra o início de uma gravação.
    pub fn begin(&self, id: &str, path: &Path, started_at: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO recordings (id, path, started_at, status) VALUES (?1, ?2, ?3, 'recording')",
                params![id, path.to_string_lossy(), started_at],
            )
            .context("falha ao registrar o início da gravação")?;
        Ok(())
    }

    /// Fecha uma gravação: ela passa a esperar o sync.
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

    /// Recupera as gravações que ficaram em `recording` (o processo morreu no meio): passam a
    /// `pending` com `interrupted = 1`. Devolve as recuperadas, para o chamador acertar os
    /// arquivos (`fix_file`) antes de gravar caminho e tamanho finais.
    pub fn recover_interrupted(
        &self,
        mut fix_file: impl FnMut(&QueuedRecording) -> Result<(PathBuf, i64)>,
    ) -> Result<Vec<QueuedRecording>> {
        let orphans = self.by_status(Status::Recording)?;
        let mut recovered = Vec::with_capacity(orphans.len());
        for orphan in orphans {
            let (path, bytes) = fix_file(&orphan)?;
            self.conn.execute(
                "UPDATE recordings SET path = ?2, bytes = ?3, ended_at = COALESCE(ended_at, ?4),
                 status = 'pending', interrupted = 1 WHERE id = ?1",
                params![orphan.id, path.to_string_lossy(), bytes, now_ms()],
            )?;
            recovered.push(self.get(&orphan.id)?.context("gravação sumiu da fila")?);
        }
        Ok(recovered)
    }

    /// Reserva a próxima gravação a sincronizar (a mais antiga `pending`, ou `failed` com menos
    /// de `max_attempts` tentativas) e a marca `syncing`.
    pub fn claim_next(&mut self, max_attempts: i64) -> Result<Option<QueuedRecording>> {
        let tx = self.conn.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM recordings
                 WHERE status = 'pending' OR (status = 'failed' AND attempts < ?1)
                 ORDER BY started_at LIMIT 1",
                params![max_attempts],
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

    /// Marca a gravação como sincronizada.
    pub fn mark_synced(&self, id: &str, remote_id: &str) -> Result<()> {
        self.transition(
            id,
            "UPDATE recordings SET status = 'synced', remote_id = ?2, last_error = NULL
             WHERE id = ?1 AND status = 'syncing'",
            remote_id,
        )
    }

    /// Marca a tentativa de sync como falha; ela volta a ser elegível em `claim_next`.
    pub fn mark_failed(&self, id: &str, error: &str) -> Result<()> {
        self.transition(
            id,
            "UPDATE recordings SET status = 'failed', last_error = ?2
             WHERE id = ?1 AND status = 'syncing'",
            error,
        )
    }

    /// Devolve a `pending` o que ficou em `syncing` quando o processo morreu no meio do upload.
    pub fn release_stale_syncing(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending' WHERE status = 'syncing'",
            [],
        )?)
    }

    fn transition(&self, id: &str, sql: &str, value: &str) -> Result<()> {
        if self.conn.execute(sql, params![id, value])? == 0 {
            bail!("gravação {id} não está em sync");
        }
        Ok(())
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

    /// As gravações mais recentes primeiro.
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
    fn queue_persiste_entre_aberturas() {
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
    fn queue_ciclo_completo_de_sync() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "velha", 1);
        begin_and_finish(&queue, "nova", 2);

        let first = queue.claim_next(3).unwrap().unwrap();
        assert_eq!(first.id, "velha");
        assert_eq!(first.status, Status::Syncing);
        assert_eq!(first.attempts, 1);
        queue.mark_synced("velha", "srv-1").unwrap();

        let second = queue.claim_next(3).unwrap().unwrap();
        assert_eq!(second.id, "nova");
        queue.mark_failed("nova", "rede fora").unwrap();
        let failed = queue.get("nova").unwrap().unwrap();
        assert_eq!(failed.status, Status::Failed);
        assert_eq!(failed.last_error.as_deref(), Some("rede fora"));

        // Falha volta a ser elegível até o limite de tentativas.
        assert_eq!(queue.claim_next(3).unwrap().unwrap().id, "nova");
        queue.mark_failed("nova", "de novo").unwrap();
        assert!(queue.claim_next(2).unwrap().is_none());

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
    fn queue_recupera_gravacao_interrompida() {
        let queue = Queue::open_in_memory().unwrap();
        queue
            .begin("crash", Path::new("/tmp/crash.ogg.part"), 5)
            .unwrap();
        let recovered = queue
            .recover_interrupted(|rec| {
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
    fn queue_recusa_transicao_invalida_e_libera_sync_orfao() {
        let mut queue = Queue::open_in_memory().unwrap();
        begin_and_finish(&queue, "x", 1);
        assert!(queue.mark_synced("x", "srv").is_err());
        assert!(queue.finish("x", Path::new("/tmp/x.ogg"), 2, 1, 1).is_err());
        queue.claim_next(3).unwrap().unwrap();
        assert_eq!(queue.release_stale_syncing().unwrap(), 1);
        assert_eq!(queue.get("x").unwrap().unwrap().status, Status::Pending);
        assert_eq!(queue.list(10).unwrap().len(), 1);
    }
}
