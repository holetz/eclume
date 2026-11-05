//! The phone's sync: `eclume-recorder`'s `sync_pending` with `eclume-sync`'s `HttpUploader` through
//! the pinned CA, with the per-part progress measured in the transport, the retention and the
//! authenticated reads the app makes outside the upload (agenda types and server steps).
//!
//! Error strings stay pt-BR: they reach the UI. The `movel.json` keys are the server's published
//! format and keep their names through `#[serde(rename)]`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use eclume_recorder::{
    now_ms, sync_pending, Queue, QueuedRecording, SyncInterrupted, SyncReport, Uploader,
};
use eclume_sync::api::{cursor_from, LibraryPage, LibraryRecording};
use eclume_sync::protocol::{api_error, RetryPolicy};
use eclume_sync::transport::{HttpRequest, HttpResponse, Transport};
use eclume_sync::{Client, HttpUploader};
use serde::{Deserialize, Serialize};

use crate::config::{AgendaType, Server};
use crate::network::Progress;

/// How many attempts a recording gets before it stays stopped in `failed`.
pub const MAX_ATTEMPTS: i64 = 10;
const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

/// The progress of the running sync, read by the UI while the sync thread writes.
#[derive(Debug)]
pub struct Meter {
    i: AtomicU32,
    n: AtomicU32,
    sent: AtomicU64,
    total: AtomicU64,
    start: Mutex<Instant>,
    credential_refused: AtomicBool,
    /// Eclume's network dropped (or the system stopped the sync work): the [`Counter`] lets no more
    /// sync request out until the next pass prepared on the network.
    interrupted: AtomicBool,
}

impl Default for Meter {
    fn default() -> Self {
        Self {
            i: AtomicU32::new(0),
            n: AtomicU32::new(0),
            sent: AtomicU64::new(0),
            total: AtomicU64::new(0),
            start: Mutex::new(Instant::now()),
            credential_refused: AtomicBool::new(false),
            interrupted: AtomicBool::new(false),
        }
    }
}

impl Meter {
    fn begin(&self, n: u32) {
        self.i.store(0, Ordering::Release);
        self.n.store(n, Ordering::Release);
        self.credential_refused.store(false, Ordering::Release);
    }

    fn next(&self, bytes: u64) {
        let i = self.i.fetch_add(1, Ordering::AcqRel) + 1;
        // A recording that joined the queue during the sync raises the total.
        self.n.fetch_max(i, Ordering::AcqRel);
        self.sent.store(0, Ordering::Release);
        self.total.store(bytes, Ordering::Release);
        if let Ok(mut start) = self.start.lock() {
            *start = Instant::now();
        }
    }

    fn sent(&self, bytes: u64) {
        self.sent.fetch_add(bytes, Ordering::AcqRel);
    }

    /// Interrupts the running sync: its next request returns [`SyncInterrupted`] without touching
    /// the network.
    pub fn interrupt(&self) {
        self.interrupted.store(true, Ordering::Release);
    }

    /// Releases the sync again; the core calls it when preparing a pass on eclume's network.
    pub fn resume(&self) {
        self.interrupted.store(false, Ordering::Release);
    }

    pub fn interrupted(&self) -> bool {
        self.interrupted.load(Ordering::Acquire)
    }

    /// The server answered 401 to an authenticated call during the sync.
    pub fn credential_refused(&self) -> bool {
        self.credential_refused.load(Ordering::Acquire)
    }

    pub fn progress(&self) -> Progress {
        let sent = self.sent.load(Ordering::Acquire);
        let total = self.total.load(Ordering::Acquire);
        let seconds = self
            .start
            .lock()
            .map_or(0.0, |start| start.elapsed().as_secs_f64());
        Progress {
            i: self.i.load(Ordering::Acquire),
            n: self.n.load(Ordering::Acquire),
            pct: (sent.min(total) * 100)
                .checked_div(total)
                .map_or(0, |pct| u8::try_from(pct).unwrap_or(100)),
            bytes_s: if seconds > 0.5 {
                (sent as f64 / seconds) as u64
            } else {
                0
            },
        }
    }
}

/// A transport that counts the bytes of the uploaded parts (successful `PUT`), notes a 401 from the
/// API origin and, with the meter interrupted, returns [`SyncInterrupted`] without sending: no sync
/// request leaves after the app knows eclume's network dropped.
pub struct Counter {
    inner: Arc<dyn Transport>,
    meter: Arc<Meter>,
    origin: String,
}

impl Counter {
    pub fn new(inner: Arc<dyn Transport>, meter: Arc<Meter>, server: &Server) -> Self {
        Self {
            inner,
            meter,
            origin: server.url.trim_end_matches('/').to_string(),
        }
    }
}

impl Transport for Counter {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        if self.meter.interrupted() {
            return Err(SyncInterrupted.into());
        }
        let part = (request.method == "PUT").then_some(request.body.len() as u64);
        let from_api = request.url.starts_with(&self.origin);
        let response = self.inner.send(request)?;
        if from_api && response.status == 401 {
            self.meter.credential_refused.store(true, Ordering::Release);
        }
        if let (Some(bytes), true) = (part, response.is_success()) {
            self.meter.sent(bytes);
        }
        Ok(response)
    }
}

/// Tells the meter about each recording that starts uploading.
struct WithProgress<'a> {
    inner: &'a dyn Uploader,
    meter: &'a Meter,
}

impl Uploader for WithProgress<'_> {
    fn upload(&self, recording: &QueuedRecording) -> Result<String> {
        self.meter.next(
            recording
                .bytes
                .and_then(|b| u64::try_from(b).ok())
                .unwrap_or(0),
        );
        self.inner.upload(recording)
    }
}

/// The phone's real uploader: the client over the pinned transport with the [`Counter`].
pub fn uploader(
    transport: Arc<dyn Transport>,
    meter: Arc<Meter>,
    server: &Server,
    token: &str,
    queue: Arc<Mutex<Queue>>,
    client_version: &str,
    device_name: &str,
) -> Result<HttpUploader> {
    let counter = Arc::new(Counter::new(transport, meter, server));
    let client = Client::new(counter, &server.url, token, RetryPolicy::default())?;
    Ok(HttpUploader::from_client(client, queue, client_version).with_device_name(device_name))
}

/// One sync pass: returns to the queue the failures whose deadline passed and uploads the pending
/// ones, one by one, with the progress in the meter.
pub fn synchronize(
    queue: &Mutex<Queue>,
    uploader: &dyn Uploader,
    meter: &Meter,
) -> Result<SyncReport> {
    let n = {
        let queue = lock(queue)?;
        queue.retry_due(now_ms(), MAX_ATTEMPTS)?;
        queue.counts()?.pending
    };
    meter.begin(n);
    sync_pending(
        queue,
        &WithProgress {
            inner: uploader,
            meter,
        },
    )
}

/// The retention: deletes from the phone the files the server confirmed more than `days` ago.
/// Returns how many went.
pub fn retain(queue: &Mutex<Queue>, now_ms: i64, days: u32) -> Result<usize> {
    delete_synced_before(queue, now_ms - i64::from(days) * DAY_MS).map(|(n, _)| n)
}

/// "Excluir sincronizadas": deletes right away every file the server confirmed. Returns how many
/// and how many bytes went.
pub fn delete_synced(queue: &Mutex<Queue>) -> Result<(usize, u64)> {
    delete_synced_before(queue, i64::MAX)
}

/// How many bytes the already synced recordings take on the phone.
pub fn synced_bytes(queue: &Mutex<Queue>) -> Result<u64> {
    Ok(lock(queue)?
        .purge_candidates(i64::MAX)?
        .iter()
        .filter_map(|rec| rec.bytes.and_then(|b| u64::try_from(b).ok()))
        .sum())
}

fn delete_synced_before(queue: &Mutex<Queue>, until: i64) -> Result<(usize, u64)> {
    let queue = lock(queue)?;
    let mut deleted = 0;
    let mut bytes = 0;
    for rec in queue.purge_candidates(until)? {
        delete_file(&rec.path)?;
        queue.mark_purged(&rec.id, now_ms())?;
        deleted += 1;
        bytes += rec.bytes.and_then(|b| u64::try_from(b).ok()).unwrap_or(0);
    }
    Ok((deleted, bytes))
}

/// Deletes a local file; a file that no longer exists is not an error.
pub fn delete_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("falha ao apagar {}", path.display())),
    }
}

fn lock(queue: &Mutex<Queue>) -> Result<std::sync::MutexGuard<'_, Queue>> {
    queue
        .lock()
        .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
}

/// The error context of an authenticated read the server refused with 401.
#[derive(Debug)]
pub struct CredentialRefused;

impl std::fmt::Display for CredentialRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("o servidor recusou a credencial deste aparelho")
    }
}

/// Whether the error came from a 401 on an authenticated read (the credential was revoked).
pub fn refused_credential(err: &anyhow::Error) -> bool {
    err.downcast_ref::<CredentialRefused>().is_some()
}

/// An authenticated API read (`GET /api/v1<path>`).
fn get_json<T: serde::de::DeserializeOwned>(
    transport: &dyn Transport,
    server: &Server,
    token: &str,
    path: &str,
    what: &str,
) -> Result<T> {
    let url = format!("{}/api/v1{path}", server.url.trim_end_matches('/'));
    let response = transport
        .send(HttpRequest::new("GET", url).header("Authorization", format!("Bearer {token}")))?;
    if response.status == 401 {
        return Err(api_error(what, &response).context(CredentialRefused));
    }
    if !response.is_success() {
        return Err(api_error(what, &response));
    }
    serde_json::from_slice(&response.body).with_context(|| format!("{what}: resposta inválida"))
}

#[derive(Deserialize)]
struct TypePage {
    items: Vec<ApiType>,
}

#[derive(Deserialize)]
struct ApiType {
    id: String,
    name: String,
}

/// The user's agenda types, for the saved-recording sheet's cache.
pub fn fetch_agenda_types(
    transport: &dyn Transport,
    server: &Server,
    token: &str,
) -> Result<Vec<AgendaType>> {
    let page: TypePage = get_json(
        transport,
        server,
        token,
        "/agenda-types?limit=100",
        "falha ao ler os tipos de agenda",
    )?;
    Ok(page
        .items
        .into_iter()
        .map(|t| AgendaType {
            id: t.id,
            name: t.name,
        })
        .collect())
}

/// The transcription language in force for the account: `GET /me/transcription` (contract 2.20.0).
pub fn fetch_account_language(
    transport: &dyn Transport,
    server: &Server,
    token: &str,
) -> Result<String> {
    let preference: eclume_sync::api::TranscriptionPreference = get_json(
        transport,
        server,
        token,
        "/me/transcription",
        "falha ao ler o idioma da conta",
    )?;
    Ok(preference.effective().to_string())
}

/// One processing step on the server (`PipelineStep`), with the reason code of a skipped step
/// (`reason`) and the error of a failed one; a server without those fields gives `None`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub step: String,
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error: Option<StepError>,
}

/// The error of a failed step (`PipelineStep.error`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepError {
    pub code: String,
    pub message: String,
}

/// Why the transcription waits in the queue (`Job.queue`, contract 2.16.0); the sentence comes
/// from `fraseDaEspera` in the UI vocabulary. Older server: `None`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wait {
    pub reason: String,
    #[serde(default)]
    pub ahead: Option<u32>,
    #[serde(default)]
    pub account_ahead: Option<u32>,
    #[serde(default)]
    pub estimated_start_at: Option<String>,
    #[serde(default)]
    pub resumes_at: Option<String>,
    #[serde(default)]
    pub processor: Option<Processor>,
}

/// Whether the transcription processor is up (`ProcessorStatus`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Processor {
    pub online: bool,
    #[serde(default)]
    pub offline_since: Option<String>,
}

/// What the detail reads from the recording on the server: the steps, the queue wait and the
/// title.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OnServer {
    pub steps: Vec<Step>,
    pub wait: Option<Wait>,
    /// The title the server gave the recording (empty becomes `None`).
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct ApiJob {
    #[serde(default)]
    queue: Option<Wait>,
}

#[derive(Deserialize)]
struct ApiRecording {
    #[serde(default)]
    title: String,
    #[serde(default)]
    pipeline: Vec<Step>,
    #[serde(default)]
    job: Option<ApiJob>,
}

/// The steps and queue wait of the recording on the server (`GET /recordings/{id}`).
pub fn fetch_steps(
    transport: &dyn Transport,
    server: &Server,
    token: &str,
    remote_id: &str,
) -> Result<OnServer> {
    let recording: ApiRecording = get_json(
        transport,
        server,
        token,
        &format!("/recordings/{remote_id}"),
        "falha ao ler a gravação no servidor",
    )?;
    Ok(OnServer {
        steps: recording.pipeline,
        wait: recording.job.and_then(|job| job.queue),
        title: Some(recording.title).filter(|title| !title.trim().is_empty()),
    })
}

/// Slack on the next `?since=` (as on desktop): covers a transaction that commits late.
const TITLES_SLACK_S: i64 = 60;

/// The titles read from the server: `(server id, title)` and the next `since`, if the read brought
/// anything.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Titles {
    pub pairs: Vec<(String, String)>,
    pub next: Option<String>,
}

/// The titles of the account's recordings that changed since `since` (`GET /recordings?since=`,
/// every page).
pub fn fetch_titles(
    transport: &dyn Transport,
    server: &Server,
    token: &str,
    since: &str,
) -> Result<Titles> {
    let mut items: Vec<LibraryRecording> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut path = format!("/recordings?limit=200&since={}", encode(since));
        if let Some(cursor) = &cursor {
            path.push_str(&format!("&cursor={}", encode(cursor)));
        }
        let page: LibraryPage = get_json(
            transport,
            server,
            token,
            &path,
            "falha ao ler as gravações no servidor",
        )?;
        items.extend(page.items);
        match page.next_cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => break,
        }
    }
    let next = cursor_from(&items, TITLES_SLACK_S);
    let pairs = items
        .into_iter()
        .filter(|item| !item.title.trim().is_empty())
        .map(|item| (item.id, item.title))
        .collect();
    Ok(Titles { pairs, next })
}

/// Percent-encoding of a query value (only the unreserved characters pass).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The server's `movel.json` (holetz/eclume#41, docs/standards/code/mobile-distribuicao.md).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(rename = "versao")]
    pub version: String,
    #[serde(default, rename = "notas")]
    pub notes: Option<String>,
    pub apk: ManifestApk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestApk {
    #[serde(rename = "arquivo")]
    pub file: String,
    /// Absolute path on the server (`/downloads/movel/<version>/<file>`) or a full URL.
    pub url: String,
    #[serde(rename = "tamanho")]
    pub size: u64,
    pub sha256: String,
}

/// Where the server publishes the mobile app's manifest.
pub const MANIFEST_PATH: &str = "/downloads/movel.json";

fn address(server: &Server, path: &str) -> String {
    if path.starts_with("https://") {
        path.to_string()
    } else {
        format!("{}{path}", server.url.trim_end_matches('/'))
    }
}

/// Reads the (public) `movel.json` through the pinned CA; `None` when the server has not published
/// one yet.
pub fn fetch_manifest(transport: &dyn Transport, server: &Server) -> Result<Option<Manifest>> {
    let response = transport.send(HttpRequest::new("GET", address(server, MANIFEST_PATH)))?;
    if response.status == 404 {
        return Ok(None);
    }
    if !response.is_success() {
        return Err(api_error("falha ao ler o movel.json", &response));
    }
    Ok(Some(
        serde_json::from_slice(&response.body).context("movel.json inválido")?,
    ))
}

fn parts(version: &str) -> Option<(u64, u64, u64)> {
    let mut it = version.trim().trim_start_matches('v').split('.');
    let part = |p: Option<&str>| p.and_then(|t| t.parse::<u64>().ok());
    let triple = (part(it.next())?, part(it.next())?, part(it.next())?);
    it.next().is_none().then_some(triple)
}

/// Whether `candidate` is newer than `current` (X.Y.Z); versions outside the format never are.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((parts(candidate), parts(current)), (Some(c), Some(a)) if c > a)
}

/// Downloads the manifest's APK through the pinned CA into `dest`, checking size and SHA-256. An
/// APK that does not match is deleted and becomes an error.
pub fn download_apk(
    transport: &dyn Transport,
    server: &Server,
    manifest: &Manifest,
    dest: &Path,
) -> Result<std::path::PathBuf> {
    let response = transport.send(HttpRequest::new("GET", address(server, &manifest.apk.url)))?;
    if !response.is_success() {
        return Err(api_error("falha ao baixar a atualização", &response));
    }
    let hash = eclume_sync::pin::sha256_hex(&response.body);
    if response.body.len() as u64 != manifest.apk.size || hash != manifest.apk.sha256 {
        anyhow::bail!("O APK baixado não confere com o movel.json; nada foi instalado");
    }
    std::fs::create_dir_all(dest).with_context(|| format!("falha ao criar {}", dest.display()))?;
    let path = dest.join(format!("eclume-{}.apk", manifest.version));
    std::fs::write(&path, &response.body)
        .with_context(|| format!("falha ao gravar {}", path.display()))?;
    Ok(path)
}
