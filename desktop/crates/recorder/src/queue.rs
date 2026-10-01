//! Fila local e persistente das gravações, em SQLite.
//!
//! Uma linha por gravação, com o ciclo `recording → pending → syncing → synced | failed`.
//! `failed` volta a `pending` por `retry_due` (no prazo do backoff) ou `retry_failed` (já). Uma
//! linha que ficou em `recording` quando o processo morreu é recuperada na abertura seguinte como
//! `pending` com `interrupted = 1`.
//!
//! Esquema v2: `upload_id` e `sha256` guardam o upload em curso para a retomada,
//! `next_attempt_at` agenda a próxima tentativa depois de uma falha, `synced_at` marca a
//! confirmação do servidor, `purged_at` a remoção do arquivo local pela retenção e
//! `meeting_app` o app da reunião que a detecção viu (`teams`, `meet`, `zoom`, `other`).
//!
//! Esquema v3: `kind` separa reunião de nota por voz, `recorded_at_source` diz de onde veio a
//! data de início (captura, metadados do arquivo importado ou a pessoa), `source` separa a
//! gravação do app da importação de arquivo, e `original_name`/`content_type` guardam o nome e o
//! tipo do arquivo importado. A tabela `markers` guarda os marcadores de cada gravação até o
//! upload.
//!
//! Esquema v4: `title` e `agenda_type_id` são o título e o tipo de agenda escolhidos ao parar (no
//! celular, a folha "Gravação salva"), e `details_pending` segura o sync enquanto essa folha está
//! aberta, por no máximo [`DETAILS_WAIT_MS`].
//!
//! Esquema v5: `server_title` é o título que o servidor dá à gravação depois de processada, lido
//! da listagem por `?since=`; a fila mostra o título local, senão ele.
//!
//! Esquema v6: `language` é o idioma da transcrição escolhido para a gravação (no celular, a folha
//! "Gravação salva"; `auto` pede a detecção); sem ele, o upload manda o do aparelho, e sem nenhum
//! vale o da conta. Uma fila v1 a v5 ganha as colunas e a tabela na abertura, sem perder linhas.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::Serialize;

const SCHEMA_VERSION: i32 = 6;

/// Quanto uma gravação com `details_pending` espera o título e o tipo antes de subir sem eles.
pub const DETAILS_WAIT_MS: i64 = 10 * 60 * 1_000;

/// Tamanho máximo da nota de um marcador, em caracteres (o limite do contrato).
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

/// Colunas que a v2 a v6 acrescentaram, com o tipo, para migrar uma fila anterior.
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

/// Um enum guardado como texto na fila, lido, escrito e serializado no vocabulário do contrato.
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
    /// A natureza da gravação (`kind` do contrato).
    Kind {
        /// Reunião ou gravação manual: microfone e áudio do sistema.
        Meeting = "meeting",
        /// Nota por voz: só o microfone, parada por silêncio.
        Note = "note",
    }
}

text_enum! {
    /// De onde veio a data de início (`recorded_at_source` do contrato).
    RecordedAtSource {
        /// O relógio do computador na captura.
        Capture = "capture",
        /// Lida dos metadados do arquivo importado e confirmada.
        FileMetadata = "file_metadata",
        /// Digitada pela pessoa na importação.
        User = "user",
    }
}

text_enum! {
    /// Como o áudio chegou (`source` do contrato).
    Source {
        /// Gravado pelo app desktop.
        Desktop = "desktop",
        /// Gravado pelo app móvel.
        Mobile = "mobile",
        /// Arquivo importado.
        Upload = "upload",
    }
}

/// Um arquivo importado, pronto para entrar na fila.
#[derive(Clone, Debug)]
pub struct NewImport<'a> {
    pub id: &'a str,
    /// O arquivo em `gravacoes/` (convertido para Opus ou a cópia do original).
    pub path: &'a Path,
    /// Início da gravação, em ms Unix.
    pub recorded_at: i64,
    pub recorded_at_source: RecordedAtSource,
    /// Nome do arquivo escolhido, sem extensão.
    pub original_name: &'a str,
    /// Tipo do arquivo em `path`; `None` para Ogg/Opus.
    pub content_type: Option<&'a str>,
    pub duration_ms: i64,
    pub bytes: i64,
}

/// Um marcador de uma gravação: um instante no áudio, com nota opcional.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Marker {
    /// UUID v4, a chave de idempotência do upload.
    pub client_id: String,
    pub recording_id: String,
    /// Posição no áudio, em ms.
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

/// Espera antes da próxima tentativa, depois de `attempts` tentativas: 30 s dobrando a cada
/// falha, até 1 h.
pub fn retry_backoff_ms(attempts: i64) -> i64 {
    const BASE_MS: i64 = 30_000;
    const MAX_MS: i64 = 3_600_000;
    let exponent = u32::try_from(attempts.saturating_sub(1).clamp(0, 16)).unwrap_or(16);
    BASE_MS.saturating_mul(1_i64 << exponent).min(MAX_MS)
}

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
    /// Upload em curso no servidor, para retomar.
    pub upload_id: Option<String>,
    /// SHA-256 do arquivo (hex), calculado uma vez para o upload.
    pub sha256: Option<String>,
    /// Quando a próxima tentativa fica liberada, depois de uma falha.
    pub next_attempt_at: Option<i64>,
    /// Quando o servidor confirmou a gravação.
    pub synced_at: Option<i64>,
    /// Quando a retenção apagou o arquivo local.
    pub purged_at: Option<i64>,
    /// App da reunião detectada, no vocabulário do contrato (`capture.meeting_app`).
    pub meeting_app: Option<String>,
    pub kind: Kind,
    pub recorded_at_source: RecordedAtSource,
    pub source: Source,
    /// Nome do arquivo importado, sem extensão.
    pub original_name: Option<String>,
    /// Tipo do arquivo; `None` é Ogg/Opus.
    pub content_type: Option<String>,
    /// Título escolhido ao parar; `None` deixa o servidor derivar.
    pub title: Option<String>,
    /// Tipo de agenda escolhido ao parar (UUID do servidor).
    pub agenda_type_id: Option<String>,
    /// A pessoa ainda pode dar título e tipo: o sync espera.
    pub details_pending: bool,
    /// O título que o servidor deu à gravação depois de processada.
    pub server_title: Option<String>,
    /// Idioma da transcrição escolhido para a gravação (`pt`, `auto`…); `None` deixa o do aparelho.
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
        migrate(&conn).context("falha ao migrar a fila")?;
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

    /// Marca uma gravação fechada como interrompida (a thread de gravação falhou no meio).
    pub fn mark_interrupted(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET interrupted = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Recupera as gravações que ficaram em `recording` sem sessão viva (`live`): o processo
    /// morreu no meio, ou o `.part` ficou preso ao parar. Passam a `pending` com
    /// `interrupted = 1`. O chamador acerta os arquivos (`fix_file`) antes de gravar caminho e
    /// tamanho finais; uma linha cujo `fix_file` falha fica em `recording`, no log, e as outras
    /// seguem. Devolve as recuperadas.
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
                    log::warn!("gravação {} segue em andamento: {err:#}", orphan.id);
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

    /// Reserva a próxima gravação a sincronizar (a `pending` mais antiga) e a marca `syncing`.
    /// Uma gravação com `details_pending` fica de fora até [`DETAILS_WAIT_MS`] depois do fim.
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

    /// Devolve a `pending` a gravação reivindicada por [`Queue::claim_next`] cujo sync foi
    /// interrompido, desfazendo o `attempts + 1`: a interrupção não é falha.
    pub fn release_claim(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE recordings SET status = 'pending', attempts = MAX(attempts - 1, 0)
             WHERE id = ?1 AND status = 'syncing'",
            params![id],
        )?;
        Ok(())
    }

    /// Devolve a `pending` as falhas com menos de `max_attempts` tentativas, sem esperar o
    /// backoff (o usuário trocou o PAT ou pediu para tentar de novo).
    pub fn retry_failed(&self, max_attempts: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending' WHERE status = 'failed' AND attempts < ?1",
            params![max_attempts],
        )?)
    }

    /// Devolve a `pending` as falhas cujo backoff venceu até `now` (ms Unix), com menos de
    /// `max_attempts` tentativas.
    pub fn retry_due(&self, now: i64, max_attempts: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET status = 'pending'
             WHERE status = 'failed' AND attempts < ?1
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)",
            params![max_attempts, now],
        )?)
    }

    /// Marca a gravação como sincronizada: o servidor confirmou `remote_id`.
    pub fn mark_synced(&self, id: &str, remote_id: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE recordings SET status = 'synced', remote_id = ?2, last_error = NULL,
             next_attempt_at = NULL, synced_at = ?3
             WHERE id = ?1 AND status = 'syncing'",
            params![id, remote_id, now_ms()],
        )?;
        ensure_changed(id, changed)
    }

    /// Marca a tentativa de sync como falha e agenda a próxima por [`retry_backoff_ms`];
    /// `retry_due` a devolve à fila quando o prazo vence.
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

    /// Guarda (ou limpa, com `None`) o upload em curso e o hash do arquivo, para retomar.
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

    /// Guarda o título que o servidor deu à gravação `remote_id`; `true` se mudou alguma linha.
    pub fn set_server_title(&self, remote_id: &str, title: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE recordings SET server_title = ?2 WHERE remote_id = ?1 AND server_title IS NOT ?2",
            params![remote_id, title],
        )?;
        Ok(changed > 0)
    }

    /// Registra o app da reunião que originou a gravação.
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

    /// Muda a natureza da gravação (uma nota nasce como gravação e vira `note` logo depois).
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

    /// Muda a origem da gravação (o app móvel grava com `source = mobile`).
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

    /// Segura o sync da gravação até a pessoa dar título e tipo, ou pular.
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

    /// Grava o título, o tipo de agenda e o idioma (vazios viram `None`) e libera o sync. Pular é
    /// chamar com os três `None`.
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

    /// Libera as gravações que esperavam título e tipo: na abertura seguinte, a folha que segurava
    /// o sync já não existe.
    pub fn release_details_pending(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE recordings SET details_pending = 0 WHERE details_pending = 1",
            [],
        )?)
    }

    /// Registra um arquivo importado, já pronto: nasce `pending`, com `source = upload`.
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

    /// Tira da fila uma gravação que ainda não subiu (a nota sem voz), com os marcadores dela.
    /// Devolve a linha removida, para o chamador apagar o arquivo.
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

    /// Acrescenta um marcador em `at_ms` a uma gravação que ainda não subiu.
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

    /// Troca a nota de um marcador (vazia apaga) enquanto a gravação não subiu.
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

    /// Os marcadores de uma gravação, na ordem do áudio.
    pub fn markers(&self, recording_id: &str) -> Result<Vec<Marker>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM markers WHERE recording_id = ?1 ORDER BY at_ms, created_at")?;
        let rows = stmt.query_map(params![recording_id], Marker::from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Marcadores só mudam antes do upload: depois, a edição é da web.
    fn ensure_editable(&self, recording_id: &str) -> Result<()> {
        match self.get(recording_id)? {
            None => bail!("gravação {recording_id} não está na fila"),
            Some(rec) if matches!(rec.status, Status::Syncing | Status::Synced) => {
                bail!("a gravação já foi para o servidor: edite os marcadores na web")
            }
            // O upload retomado leva os marcadores de quando foi criado.
            Some(rec) if rec.upload_id.is_some() => {
                bail!("o envio desta gravação já começou: edite os marcadores na web")
            }
            Some(_) => Ok(()),
        }
    }

    /// Gravações confirmadas até `synced_before` (ms Unix) cujo arquivo local ainda existe.
    pub fn purge_candidates(&self, synced_before: i64) -> Result<Vec<QueuedRecording>> {
        self.query(
            "SELECT * FROM recordings
             WHERE status = 'synced' AND remote_id IS NOT NULL AND purged_at IS NULL
               AND synced_at IS NOT NULL AND synced_at <= ?1
             ORDER BY started_at",
            params![synced_before],
        )
    }

    /// Registra que o arquivo local de uma gravação confirmada foi apagado.
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

    /// Devolve a `pending` o que ficou em `syncing` quando o processo morreu no meio do upload.
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

/// A nota aparada; vazia vira `None`, e acima de [`MAX_MARKER_NOTE`] caracteres é erro.
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

/// Acrescenta as colunas da v2 a v6 a uma fila anterior (o `CREATE TABLE IF NOT EXISTS` não
/// mexe numa tabela que já existe; a tabela `markers` nasce no `SCHEMA`).
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

/// O texto aparado, ou `None` se vazio.
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

        // Falha só volta à fila por `retry_failed`, e até o limite de tentativas.
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
    fn queue_recupera_gravacao_interrompida() {
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
    fn queue_recusa_transicao_invalida_e_libera_sync_orfao() {
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
    fn queue_backoff_dobra_ate_uma_hora() {
        assert_eq!(retry_backoff_ms(0), 30_000);
        assert_eq!(retry_backoff_ms(1), 30_000);
        assert_eq!(retry_backoff_ms(2), 60_000);
        assert_eq!(retry_backoff_ms(4), 240_000);
        assert_eq!(retry_backoff_ms(8), 3_600_000);
        assert_eq!(retry_backoff_ms(i64::MAX), 3_600_000);
    }

    #[test]
    fn queue_falha_so_volta_quando_o_backoff_vence() {
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
        // Segunda falha: o prazo dobra, e o limite de tentativas vale.
        let again = queue.get("r").unwrap().unwrap();
        assert!(again.next_attempt_at.unwrap() - now_ms() > 30_000);
        assert_eq!(queue.retry_due(i64::MAX, 2).unwrap(), 0);
        assert_eq!(queue.retry_due(i64::MAX, 3).unwrap(), 1);
        assert!(queue.mark_failed("r", "fora de sync").is_err());
    }

    #[test]
    fn queue_guarda_estado_de_retomada_e_confirmacao() {
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
    fn queue_retencao_so_apaga_o_que_o_servidor_confirmou() {
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
    fn queue_migra_fila_v2_real_com_os_padroes_da_v4() {
        let dir = std::env::temp_dir().join(format!("eclume-queue-v2-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("queue.sqlite");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fila-v2.sqlite"),
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
    fn queue_nota_importacao_e_descarte() {
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
        assert!(queue.discard("imp").is_err(), "o que sobe não é descartado");
    }

    #[test]
    fn queue_marcadores_ordenados_com_nota_limitada_ate_o_upload() {
        let mut queue = Queue::open_in_memory().unwrap();
        queue.begin("g", Path::new("/tmp/g.ogg.part"), 1).unwrap();
        let tarde = queue.add_marker("g", 9_000, Some("  ")).unwrap();
        let cedo = queue.add_marker("g", 2_000, Some(" ação ")).unwrap();
        assert_eq!(tarde.note, None);
        assert_eq!(cedo.note.as_deref(), Some("ação"));
        assert_ne!(tarde.client_id, cedo.client_id);
        assert_eq!(
            uuid::Uuid::parse_str(&cedo.client_id)
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

        let longa = "é".repeat(MAX_MARKER_NOTE + 1);
        assert!(queue.add_marker("g", 1, Some(&longa)).is_err());
        assert!(queue
            .set_marker_note(&tarde.client_id, Some(&longa))
            .is_err());
        let limite = "é".repeat(MAX_MARKER_NOTE);
        let editado = queue
            .set_marker_note(&tarde.client_id, Some(&limite))
            .unwrap();
        assert_eq!(editado.note.as_deref(), Some(limite.as_str()));
        assert!(queue.set_marker_note("nao-existe", None).is_err());
        assert!(queue.add_marker("nao-existe", 1, None).is_err());

        queue
            .finish("g", Path::new("/tmp/g.ogg"), 2, 10_000, 3)
            .unwrap();
        queue.add_marker("g", 9_500, None).unwrap();
        queue.claim_next().unwrap().unwrap();
        assert!(queue.add_marker("g", 9_900, None).is_err());
        assert!(queue.set_marker_note(&cedo.client_id, None).is_err());
        assert_eq!(queue.markers("g").unwrap().len(), 3);

        // Falhou com o upload já criado: a retomada levaria os marcadores antigos.
        queue
            .set_upload_state("g", Some("up-1"), Some("ab12"))
            .unwrap();
        queue.mark_failed("g", "rede").unwrap();
        assert!(queue.add_marker("g", 9_900, None).is_err());
        queue.set_upload_state("g", None, None).unwrap();
        queue.add_marker("g", 9_900, None).unwrap();
    }

    #[test]
    fn queue_detalhes_seguram_o_sync_ate_salvar_ou_vencer() {
        let mut queue = Queue::open_in_memory().unwrap();
        let agora = now_ms();
        begin_and_finish(&queue, "folha", agora);
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
        // Depois de sair para o servidor, título e tipo não mudam mais aqui.
        assert!(queue
            .save_details("folha", Some("outro"), None, None)
            .is_err());

        // A folha esquecida aberta não segura o sync para sempre.
        begin_and_finish(&queue, "esquecida", 1);
        queue.set_details_pending("esquecida").unwrap();
        assert_eq!(queue.claim_next().unwrap().unwrap().id, "esquecida");

        // Na abertura seguinte, o flag de uma folha que já não existe cai (o da esquecida também).
        begin_and_finish(&queue, "reaberta", agora);
        queue.set_details_pending("reaberta").unwrap();
        assert_eq!(queue.release_details_pending().unwrap(), 2);
        assert_eq!(queue.claim_next().unwrap().unwrap().id, "reaberta");
        assert!(queue.set_details_pending("nao-existe").is_err());
    }

    #[test]
    fn queue_migra_fila_v1_sem_perder_linhas() {
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
        // Reabrir uma fila já migrada não mexe em nada.
        let queue = Queue::open(&db).unwrap();
        let velha = queue.get("velha").unwrap().unwrap();
        assert_eq!(velha.upload_id.as_deref(), Some("up"));
        assert_eq!(velha.server_title.as_deref(), Some("Alinhamento"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
