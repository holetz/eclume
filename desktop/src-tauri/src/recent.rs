//! The recent recordings panel at the top of the window: the account’s last N recordings, with
//! processing phase, progress and alerts when the person needs to act.
//!
//! Two sources feed the panel. Local queue rows not yet on the server (recording, awaiting
//! upload, uploading, upload failed) come first, followed by the account’s N most recent
//! recordings (`GET /recordings?limit=N&sort=created_desc`). The `eclume-recentes` thread reads
//! them every 5 s while the window is visible and something is in progress. Otherwise, every
//! 60 s, only changes since the last read (`?since=`, shared with outcome notifications and the
//! synced folder, see [`crate::sync::library_since`]) are merged into the page. The full page is
//! read every 10 min, when the loop is nudged (upload complete, settings, window opened) and when
//! the count changes. A failed read doubles the wait up to 60 s. A recording uploaded from this
//! device and present in the page is a single row, from the server.
//!
//! Rust provides codes (phase, stage, reason); the window applies labels from the shared
//! vocabulary (`ui/js/vocabulario.js`).

use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use eclume_recorder::{now_ms, QueuedRecording, Status};
use eclume_sync::api::{self, LibraryRecording};
use eclume_sync::{Client, QueueWait};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// With the window visible and a row in progress: progress advances on screen.
pub const BUSY_INTERVAL: Duration = Duration::from_secs(5);
/// Otherwise, one read per minute keeps the panel up to date when opened.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(60);
/// Maximum wait after failed reads: doubles from the normal interval up to this limit.
pub const ERROR_MAX_INTERVAL: Duration = Duration::from_secs(60);
/// How often the full page is reread at the slow interval (catches what `?since=` misses,
/// such as deleted recordings).
pub const FULL_READ_EVERY_MS: i64 = 10 * 60 * 1000;
/// `?since=` margin below the page’s greatest `updated_at`, as in the synced folder.
const SINCE_MARGIN_SECS: i64 = 120;

/// Recording states known to contract 2.20.0 (`RecordingStatus`).
const KNOWN_STATUS: [&str; 5] = ["uploading", "queued", "processing", "transcribed", "failed"];
/// Step states known to contract 2.20.0 (`PipelineStep.state`).
const KNOWN_STEP_STATES: [&str; 5] = ["pending", "active", "done", "failed", "skipped"];
/// The skipped-summary reason the person can resolve on the web (choose an agenda type).
const ACTIONABLE_NO_SUMMARY: [&str; 1] = ["no_agenda_type"];

/// Where the recording stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// On the device: recording.
    Recording,
    /// On the device: awaiting upload.
    Pending,
    /// On the device: uploading.
    Uploading,
    /// On the device: upload failed.
    UploadFailed,
    /// Uploaded from here, without server information (not read yet, or outside the page).
    Uploaded,
    /// In the server queue.
    Queued,
    /// Transcribing, with job stage and progress.
    Transcribing,
    /// In a pipeline step after transcription (agenda type, fields, summary).
    Processing,
    /// The summary is ready: the row offers Copy summary.
    SummaryReady,
    /// Transcribed, without a summary step.
    Transcribed,
    /// Ready without a summary (the step was skipped, with a reason).
    NoSummary,
    SummaryFailed,
    TranscriptionFailed,
    /// Transcription was cancelled by the owner.
    Cancelled,
    /// A state this app does not know: the server is newer.
    Unknown,
}

impl Phase {
    /// In progress: the loop reads more often while any row is in this state.
    pub fn in_progress(self) -> bool {
        matches!(
            self,
            Self::Recording
                | Self::Pending
                | Self::Uploading
                | Self::Uploaded
                | Self::Queued
                | Self::Transcribing
                | Self::Processing
        )
    }
}

/// Why the person needs to act.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    /// Upload failed: Try now (`sync_now`).
    UploadFailed,
    /// Transcription failed without automatic retry: Open on web.
    TranscriptionFailed,
    /// Summary failed: Open on web to generate it again.
    SummaryFailed,
    /// Ready without a summary for a reason the person can resolve (agenda type): Open on web.
    NoSummary,
    /// A state the app does not know (such as awaiting speakers): Open on web.
    NeedsYou,
}

/// A panel row.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentItem {
    /// Stable row key: the server id, or `local:<id>` before upload.
    pub key: String,
    pub remote_id: Option<String>,
    pub local_id: Option<String>,
    /// The title; empty when none was given (the window shows the date).
    pub title: String,
    /// Local start in ms (device rows).
    pub started_at: Option<i64>,
    /// Server `created_at`.
    pub created_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub phase: Phase,
    /// The current stage: from the job (`asr`…) during transcription, from the pipeline
    /// (`summary`…) afterward, or the step with an unknown state.
    pub stage: Option<String>,
    /// Transcription progress in thousandths (0–1000).
    pub progress: Option<u16>,
    pub attention: Option<Attention>,
    /// The reason in the `PipelineStep.reason` vocabulary.
    pub reason: Option<String>,
    /// Raw text: upload error, job error code or unknown state.
    pub detail: Option<String>,
    /// The wait in the server queue, when read by sync.
    pub wait: Option<QueueWait>,
}

/// What the `recent` command returns.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentView {
    /// How many rows the person requested; `0` hides the panel.
    pub count: u8,
    pub items: Vec<RecentItem>,
    /// How many rows need the person’s attention.
    pub needs_you: usize,
    /// When the server was last read (ms), `None` before the first read.
    pub fetched_at: Option<i64>,
    /// The last read failure; the panel keeps its previous information.
    pub error: Option<String>,
}

/// What a server row’s phase tells us.
#[derive(Debug, PartialEq)]
struct Classified {
    phase: Phase,
    stage: Option<String>,
    progress: Option<u16>,
    attention: Option<Attention>,
    reason: Option<String>,
    detail: Option<String>,
}

impl Classified {
    fn of(phase: Phase) -> Self {
        Self {
            phase,
            stage: None,
            progress: None,
            attention: None,
            reason: None,
            detail: None,
        }
    }
}

/// A server recording’s phase, with precedence alert > in progress > ready: an unknown
/// state in a pipeline with a ready summary still raises an alert.
fn classify(recording: &LibraryRecording) -> Classified {
    if !recording.status.is_empty() && !KNOWN_STATUS.contains(&recording.status.as_str()) {
        return Classified {
            attention: Some(Attention::NeedsYou),
            detail: Some(recording.status.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    if let Some(step) = recording
        .pipeline
        .iter()
        .find(|step| !KNOWN_STEP_STATES.contains(&step.state.as_str()))
    {
        return Classified {
            stage: Some(step.step.clone()),
            attention: Some(Attention::NeedsYou),
            reason: step.reason.clone(),
            detail: Some(step.state.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    let job = recording.job.as_ref();
    let job_state = job.map(|job| job.state.as_str());
    let error = job.and_then(|job| job.error.as_ref());
    if job_state == Some("cancelled") || error.is_some_and(|e| e.code == "cancelled") {
        return Classified::of(Phase::Cancelled);
    }
    if recording.status == "failed" || job_state == Some("failed") {
        let retryable = error.is_some_and(|e| e.retryable);
        return Classified {
            attention: (!retryable).then_some(Attention::TranscriptionFailed),
            detail: error.map(|e| e.code.clone()).filter(|c| !c.is_empty()),
            ..Classified::of(Phase::TranscriptionFailed)
        };
    }
    let summary = recording.summary_step();
    if let Some(step) = summary.filter(|step| step.state == "failed") {
        return Classified {
            attention: Some(Attention::SummaryFailed),
            reason: step.reason.clone(),
            ..Classified::of(Phase::SummaryFailed)
        };
    }
    match job_state {
        Some("queued") => return Classified::of(Phase::Queued),
        Some("running") => {
            return Classified {
                stage: job.and_then(|job| job.stage.clone()),
                progress: job.and_then(|job| job.progress),
                ..Classified::of(Phase::Transcribing)
            }
        }
        _ => {}
    }
    // After transcription: the active step, otherwise the first waiting step.
    let running = recording
        .pipeline
        .iter()
        .find(|step| step.state == "active")
        .or_else(|| {
            recording
                .pipeline
                .iter()
                .find(|step| step.state == "pending")
        });
    if let Some(step) = running {
        return Classified {
            stage: Some(step.step.clone()),
            ..Classified::of(Phase::Processing)
        };
    }
    if let Some(step) = summary {
        match step.state.as_str() {
            "done" => return Classified::of(Phase::SummaryReady),
            "skipped" => {
                let actionable = step
                    .reason
                    .as_deref()
                    .is_some_and(|r| ACTIONABLE_NO_SUMMARY.contains(&r));
                return Classified {
                    attention: actionable.then_some(Attention::NoSummary),
                    reason: step.reason.clone(),
                    ..Classified::of(Phase::NoSummary)
                };
            }
            _ => {}
        }
    }
    match recording.status.as_str() {
        "transcribed" => Classified::of(Phase::Transcribed),
        "processing" => Classified::of(Phase::Processing),
        _ => Classified::of(Phase::Queued),
    }
}

/// The title given when stopping, otherwise the server title or the imported file name.
fn local_title(recording: &QueuedRecording) -> String {
    recording
        .title
        .clone()
        .or_else(|| recording.server_title.clone())
        .or_else(|| recording.original_name.clone())
        .unwrap_or_default()
}

fn local_item(recording: &QueuedRecording) -> RecentItem {
    let (phase, attention) = match recording.status {
        Status::Recording => (Phase::Recording, None),
        Status::Pending => (Phase::Pending, None),
        Status::Syncing => (Phase::Uploading, None),
        Status::Failed => (Phase::UploadFailed, Some(Attention::UploadFailed)),
        Status::Synced => (Phase::Uploaded, None),
    };
    RecentItem {
        key: recording
            .remote_id
            .clone()
            .unwrap_or_else(|| format!("local:{}", recording.id)),
        remote_id: recording.remote_id.clone(),
        local_id: Some(recording.id.clone()),
        title: local_title(recording),
        started_at: Some(recording.started_at),
        created_at: None,
        duration_ms: recording.duration_ms,
        phase,
        stage: None,
        progress: None,
        attention,
        reason: None,
        detail: (recording.status == Status::Failed)
            .then(|| recording.last_error.clone())
            .flatten(),
        wait: None,
    }
}

fn remote_item(
    recording: &LibraryRecording,
    local: Option<&QueuedRecording>,
    wait: Option<&QueueWait>,
) -> RecentItem {
    let classified = classify(recording);
    let title = if recording.title.trim().is_empty() {
        local.map(local_title).unwrap_or_default()
    } else {
        recording.title.clone()
    };
    RecentItem {
        key: recording.id.clone(),
        remote_id: Some(recording.id.clone()),
        local_id: local.map(|rec| rec.id.clone()),
        title,
        started_at: local.map(|rec| rec.started_at),
        created_at: recording.created_at.clone(),
        duration_ms: local.and_then(|rec| rec.duration_ms),
        wait: (classified.phase == Phase::Queued)
            .then(|| wait.cloned())
            .flatten(),
        phase: classified.phase,
        stage: classified.stage,
        progress: classified.progress,
        attention: classified.attention,
        reason: classified.reason,
        detail: classified.detail,
    }
}

/// Combine the local queue (newest first) and the server page into at most `count` rows.
/// Local rows not yet uploaded come first; an upload from here that appears in the page
/// becomes the server row. Without a server read (`remote` `None`), uploaded recordings
/// appear as Uploaded.
pub fn build(
    local: &[QueuedRecording],
    remote: Option<&[LibraryRecording]>,
    waits: &BTreeMap<String, QueueWait>,
    count: u8,
) -> Vec<RecentItem> {
    let by_remote: HashMap<&str, &QueuedRecording> = local
        .iter()
        .filter_map(|rec| rec.remote_id.as_deref().map(|id| (id, rec)))
        .collect();
    let mut items: Vec<RecentItem> = local
        .iter()
        .filter(|rec| rec.status != Status::Synced || remote.is_none())
        .map(local_item)
        .collect();
    for recording in remote.unwrap_or_default() {
        let local = by_remote.get(recording.id.as_str()).copied();
        items.push(remote_item(recording, local, waits.get(&recording.id)));
    }
    items.truncate(usize::from(count));
    items
}

/// Use the fast interval if the window is visible and any row is in progress.
pub fn is_busy(items: &[RecentItem], visible: bool) -> bool {
    visible && items.iter().any(|item| item.phase.in_progress())
}

/// How long the loop waits before the next read.
pub fn interval(items: &[RecentItem], visible: bool) -> Duration {
    if is_busy(items, visible) {
        BUSY_INTERVAL
    } else {
        IDLE_INTERVAL
    }
}

/// Wait after `failures` consecutive failed reads: the normal interval doubles with each
/// failure, up to [`ERROR_MAX_INTERVAL`]. Without failures, use the normal interval.
pub fn error_interval(normal: Duration, failures: u32) -> Duration {
    normal
        .saturating_mul(2u32.saturating_pow(failures.min(8)))
        .min(ERROR_MAX_INTERVAL.max(normal))
}

/// Whether the next read fetches the full page (rather than only changes): when the loop
/// was nudged, at the fast interval (progress advances on screen), with no page or `since`
/// yet, when the count changed or the last full page is old.
pub fn read_full_page(
    cursor: Option<&str>,
    full_at: Option<i64>,
    same_count: bool,
    forced: bool,
    fast: bool,
    now: i64,
) -> bool {
    forced
        || fast
        || !same_count
        || cursor.is_none()
        || full_at.is_none_or(|at| !(0..FULL_READ_EVERY_MS).contains(&(now - at)))
}

/// Merge changed recordings into `page` (newest to oldest, by creation): replace existing
/// recordings by id, add new ones and keep the `count` most recent. A deleted recording
/// only disappears when the full page is read.
pub fn merge_changes(
    page: &[LibraryRecording],
    changed: &[LibraryRecording],
    count: usize,
) -> Vec<LibraryRecording> {
    let mut merged: Vec<LibraryRecording> = page
        .iter()
        .map(|item| {
            changed
                .iter()
                .find(|new| new.id == item.id)
                .unwrap_or(item)
                .clone()
        })
        .collect();
    for new in changed {
        if !merged.iter().any(|item| item.id == new.id) {
            merged.push(new.clone());
        }
    }
    let created = |item: &LibraryRecording| item.created_at.as_deref().and_then(api::instant_ms);
    // Stable: equal creation times (or missing ones) keep their previous order.
    merged.sort_by_key(|item| std::cmp::Reverse(created(item)));
    merged.truncate(count);
    merged
}

/// The last server read.
#[derive(Default)]
struct Snapshot {
    items: Option<Vec<LibraryRecording>>,
    fetched_at: Option<i64>,
    /// When the full page was last read, and with which count.
    full_at: Option<i64>,
    count: u8,
    error: Option<String>,
}

/// What a read returned.
enum Read {
    /// The full page of the `count` most recent recordings.
    Page(Vec<LibraryRecording>),
    /// Only changes since `since`.
    Changes(Vec<LibraryRecording>),
}

/// The channel for nudging the loop, and the last read.
pub struct RecentHandle {
    tx: Mutex<Sender<()>>,
    snapshot: Mutex<Snapshot>,
}

/// Start the `eclume-recentes` thread and register the channel in the app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(RecentHandle {
        tx: Mutex::new(tx),
        snapshot: Mutex::new(Snapshot::default()),
    });
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-recentes".into())
        .spawn(move || {
            let mut wait = Duration::ZERO;
            let mut failures: u32 = 0;
            let mut fast = false;
            // The first iteration (zero wait) reads the full page, like a nudge.
            let mut forced = true;
            loop {
                let woke = rx.recv_timeout(wait);
                if matches!(woke, Err(RecvTimeoutError::Disconnected)) {
                    break;
                }
                // A nudge (rather than the wait ending) requests the full page.
                forced |= woke.is_ok();
                while rx.try_recv().is_ok() {}
                match fetch(&app, forced, fast) {
                    Ok(()) => failures = 0,
                    Err(err) => {
                        failures = failures.saturating_add(1);
                        log::info!("recent: {err:#}");
                    }
                }
                forced = false;
                crate::refresh_ui(&app);
                let visible = app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                let items = view(&app).map(|view| view.items).unwrap_or_default();
                fast = is_busy(&items, visible);
                wait = error_interval(interval(&items, visible), failures);
            }
        });
    if let Err(err) = spawned {
        log::error!("failed to start recent panel: {err}");
    }
}

/// Request a read now (upload complete, settings saved, main window opened).
pub fn nudge(app: &AppHandle) {
    if let Some(handle) = app.try_state::<RecentHandle>() {
        if let Ok(tx) = handle.tx.lock() {
            let _ = tx.send(());
        }
    }
}

/// How many recordings to request: the greater of the two counts, since the window and tray
/// each take their own N rows from the same list.
pub fn fetch_count(window: u8, tray: u8) -> u8 {
    window.max(tray)
}

/// Read recent recordings. Without a device credential, or when both window and tray hide
/// recent recordings, read nothing. At the slow interval (`fast` false, no `forced`), read
/// only changes ([`read_full_page`]) and merge them. Failures go in `error`; keep the snapshot.
fn fetch(app: &AppHandle, forced: bool, fast: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let count = fetch_count(state.recent_count()?, state.tray_recent_count()?);
    let Some(config) = state.uploader_config()? else {
        return Ok(());
    };
    if count == 0 {
        return Ok(());
    }
    let handle = app.state::<RecentHandle>();
    let now = now_ms();
    let (full, cursor) = {
        let snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
        let cursor = snapshot
            .items
            .as_deref()
            .and_then(|items| api::cursor_from(items, SINCE_MARGIN_SECS));
        let full = read_full_page(
            cursor.as_deref(),
            snapshot.full_at,
            snapshot.count == count,
            forced,
            fast,
            now,
        );
        (full, cursor)
    };
    let result = Client::from_config(&config).and_then(|client| match (&cursor, full) {
        (Some(since), false) => {
            crate::sync::library_since(&config, &client, since).map(Read::Changes)
        }
        _ => client.recent(u32::from(count)).map(Read::Page),
    });
    let mut snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    match result {
        Ok(read) => {
            match read {
                Read::Page(items) => {
                    snapshot.items = Some(items);
                    snapshot.full_at = Some(now);
                    snapshot.count = count;
                }
                Read::Changes(changed) => {
                    let page = snapshot.items.take().unwrap_or_default();
                    snapshot.items = Some(merge_changes(&page, &changed, usize::from(count)));
                }
            }
            snapshot.fetched_at = Some(now_ms());
            snapshot.error = None;
            Ok(())
        }
        Err(err) => {
            snapshot.error = Some(format!("{err:#}"));
            Err(err)
        }
    }
}

/// The panel as drawn by the window.
pub fn view(app: &AppHandle) -> Result<RecentView> {
    let state = app.state::<AppState>();
    let count = state.recent_count()?;
    let local = state.recordings(u32::from(count))?;
    let waits = state.view()?.queue_waits;
    let handle = app.state::<RecentHandle>();
    let snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    let items = build(&local, snapshot.items.as_deref(), &waits, count);
    Ok(RecentView {
        count,
        needs_you: items.iter().filter(|item| item.attention.is_some()).count(),
        items,
        fetched_at: snapshot.fetched_at,
        error: snapshot.error.clone(),
    })
}

/// An action in a recording’s tray submenu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayAction {
    /// Copy summary, by remote id.
    CopySummary(String),
    /// Open on web, by remote id.
    OpenWeb(String),
    /// Try now (`sync_now`), by local id, which only makes the menu item unique.
    Retry(String),
}

/// A recording in the tray menu: the final label and its applicable actions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayEntry {
    pub key: String,
    /// Title · State, with `&` already escaped for the native menu.
    pub label: String,
    pub actions: Vec<TrayAction>,
}

/// The Recent section of the tray menu. Progress and wait are deliberately excluded:
/// the menu is rebuilt only when this changes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraySection {
    /// Recent, or Recent · 1 needs you.
    pub header: String,
    pub entries: Vec<TrayEntry>,
}

/// Maximum title characters in the menu, before the ellipsis.
const TRAY_TITLE_MAX: usize = 40;

/// Pipeline step progress, like `ETAPAS` in `vocabulario.js`.
fn stage_progress(stage: &str) -> &'static str {
    match stage {
        "received" => "Enviando",
        "preprocessing" => "Pré-processando",
        "transcription" => "Transcrevendo",
        "speakers" => "Conferindo locutores",
        "agenda_type" => "Detectando o tipo",
        "fields" => "Preenchendo campos",
        "summary" => "Resumindo",
        _ => "Em andamento",
    }
}

/// A row’s state as text, with the labels `recentes.js` takes from the vocabulary: the
/// native menu does not go through the window.
pub fn state_label(item: &RecentItem) -> &'static str {
    match item.phase {
        Phase::Recording => "Gravando",
        Phase::Pending => "Aguardando envio",
        Phase::Uploading => "Enviando",
        Phase::UploadFailed => "Falhou o envio",
        Phase::Uploaded => "Enviada",
        Phase::Queued => "Na fila",
        Phase::Transcribing => "Transcrevendo",
        Phase::Processing => item.stage.as_deref().map_or("Em andamento", stage_progress),
        Phase::SummaryReady => "Resumo pronto",
        Phase::Transcribed => "Pronta",
        Phase::NoSummary => "Pronta sem resumo",
        Phase::SummaryFailed => "O resumo falhou",
        Phase::TranscriptionFailed => "A transcrição falhou",
        Phase::Cancelled => "Cancelada",
        Phase::Unknown
            if item.stage.as_deref() == Some("speakers")
                && item.detail.as_deref() == Some("waiting") =>
        {
            "Aguardando locutores"
        }
        Phase::Unknown => NEEDS_YOU,
    }
}

const NEEDS_YOU: &str = "Precisa de você";

/// "05/10 14:02" from a local `YYYY-MM-DDTHH:MM:SS`.
fn short_date(local: &str) -> Option<String> {
    let day = local.get(8..10)?;
    let month = local.get(5..7)?;
    let time = local.get(11..16)?;
    Some(format!("{day}/{month} {time}"))
}

/// The short row title: add an ellipsis past the limit; without a title, use a short date
/// in this computer’s time zone, as in the panel; without a date, use Recording. `&` becomes
/// `&&` because the native menu reads it as a mnemonic on GTK and Windows.
pub fn tray_title(item: &RecentItem) -> String {
    let title = item.title.trim();
    let text = if title.is_empty() {
        item.started_at
            .and_then(eclume_sync::api::rfc3339_from_ms)
            .or_else(|| item.created_at.clone())
            .and_then(|at| eclume_sync::api::local_start(&at))
            .and_then(|local| short_date(&local))
            .unwrap_or_else(|| "Gravação".to_string())
    } else if title.chars().count() > TRAY_TITLE_MAX {
        let cut: String = title.chars().take(TRAY_TITLE_MAX - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        title.to_string()
    };
    text.replace('&', "&&")
}

fn tray_entry(item: &RecentItem) -> TrayEntry {
    let state = state_label(item);
    let label = if item.attention.is_some() && state != NEEDS_YOU {
        format!("{} · {NEEDS_YOU} ({state})", tray_title(item))
    } else {
        format!("{} · {state}", tray_title(item))
    };
    let mut actions = Vec::new();
    if let Some(remote) = &item.remote_id {
        if item.phase == Phase::SummaryReady {
            actions.push(TrayAction::CopySummary(remote.clone()));
        }
        actions.push(TrayAction::OpenWeb(remote.clone()));
    }
    if item.attention == Some(Attention::UploadFailed) {
        if let Some(local) = &item.local_id {
            actions.push(TrayAction::Retry(local.clone()));
        }
    }
    TrayEntry {
        key: item.key.clone(),
        label,
        actions,
    }
}

/// The tray section from rows already limited to the tray’s N.
pub fn tray_section_of(items: &[RecentItem]) -> TraySection {
    let header = match items.iter().filter(|item| item.attention.is_some()).count() {
        0 => "Recentes".to_string(),
        1 => "Recentes · 1 precisa de você".to_string(),
        n => format!("Recentes · {n} precisam de você"),
    };
    TraySection {
        header,
        entries: items.iter().map(tray_entry).collect(),
    }
}

/// The Recent section of the tray menu, from the same local queue and panel snapshot,
/// without its own API read; `None` when `tray_recent_count` is 0. Before the first read
/// (or before the thread starts), use only the local queue.
pub fn tray_section(app: &AppHandle) -> Result<Option<TraySection>> {
    let state = app.state::<AppState>();
    let count = state.tray_recent_count()?;
    if count == 0 {
        return Ok(None);
    }
    let local = state.recordings(u32::from(count))?;
    let waits = BTreeMap::new();
    let items = match app.try_state::<RecentHandle>() {
        Some(handle) => {
            let snapshot = handle
                .snapshot
                .lock()
                .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
            build(&local, snapshot.items.as_deref(), &waits, count)
        }
        None => build(&local, None, &waits, count),
    };
    Ok(Some(tray_section_of(&items)))
}

/// Copy summary: put the current summary’s Markdown on the clipboard, as the summary-ready
/// notification’s Copy action does.
pub fn copy_summary(app: &AppHandle, recording_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let config = state
        .uploader_config()?
        .context("Entre para copiar o resumo")?;
    let summary = Client::from_config(&config)?
        .current_summary(recording_id)?
        .context("O resumo ainda não está pronto")?;
    app.clipboard()
        .write_text(summary.content_md)
        .map_err(|err| anyhow!("falha ao copiar o resumo: {err}"))
}

/// Open on web: the recording page in eclume web.
pub fn open_recording(app: &AppHandle, recording_id: &str) -> Result<()> {
    let url = crate::sync::recording_url(&app.state::<AppState>().web_url()?, recording_id);
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use eclume_recorder::{Kind, RecordedAtSource, Source};
    use eclume_sync::api::{JobError, JobInfo, PipelineStepInfo};

    fn step(step: &str, state: &str, reason: Option<&str>) -> PipelineStepInfo {
        PipelineStepInfo {
            step: step.into(),
            state: state.into(),
            finished_at: None,
            reason: reason.map(str::to_string),
        }
    }

    fn remote(id: &str, status: &str) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: status.into(),
            recorded_at: None,
            created_at: Some("2026-10-05T12:00:00Z".into()),
            updated_at: None,
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: vec![],
            job: None,
        }
    }

    fn with_job(mut rec: LibraryRecording, job: JobInfo) -> LibraryRecording {
        rec.job = Some(job);
        rec
    }

    fn with_steps(mut rec: LibraryRecording, steps: Vec<PipelineStepInfo>) -> LibraryRecording {
        rec.pipeline = steps;
        rec
    }

    fn job(state: &str) -> JobInfo {
        JobInfo {
            state: state.into(),
            ..JobInfo::default()
        }
    }

    fn local(id: &str, status: Status, started_at: i64, remote: Option<&str>) -> QueuedRecording {
        QueuedRecording {
            id: id.into(),
            path: std::path::PathBuf::from(format!("/tmp/{id}.ogg")),
            started_at,
            ended_at: None,
            duration_ms: Some(60_000),
            bytes: None,
            status,
            interrupted: false,
            attempts: 0,
            last_error: (status == Status::Failed).then(|| "servidor fora do ar".to_string()),
            remote_id: remote.map(str::to_string),
            upload_id: None,
            sha256: None,
            next_attempt_at: None,
            synced_at: None,
            purged_at: None,
            meeting_app: None,
            kind: Kind::Meeting,
            recorded_at_source: RecordedAtSource::Capture,
            source: Source::Desktop,
            original_name: None,
            content_type: None,
            title: None,
            agenda_type_id: None,
            details_pending: false,
            server_title: None,
            language: None,
        }
    }

    #[test]
    fn phase_for_each_server_state() {
        let phase = |rec: &LibraryRecording| classify(rec).phase;
        assert_eq!(
            phase(&with_job(remote("a", "queued"), job("queued"))),
            Phase::Queued
        );
        let transcribing = classify(&with_job(
            remote("b", "processing"),
            JobInfo {
                stage: Some("asr".into()),
                progress: Some(420),
                ..job("running")
            },
        ));
        assert_eq!(
            (
                transcribing.phase,
                transcribing.stage.as_deref(),
                transcribing.progress
            ),
            (Phase::Transcribing, Some("asr"), Some(420))
        );
        let summary = classify(&with_steps(
            with_job(remote("c", "transcribed"), job("succeeded")),
            vec![
                step("transcription", "done", None),
                step("agenda_type", "done", None),
                step("summary", "active", None),
            ],
        ));
        assert_eq!(
            (summary.phase, summary.stage.as_deref()),
            (Phase::Processing, Some("summary"))
        );
        assert_eq!(
            phase(&with_steps(
                remote("d", "transcribed"),
                vec![step("summary", "done", None)]
            )),
            Phase::SummaryReady
        );
        assert_eq!(phase(&remote("e", "transcribed")), Phase::Transcribed);
        assert_eq!(
            phase(&with_job(remote("f", "failed"), job("cancelled"))),
            Phase::Cancelled
        );
    }

    #[test]
    fn alerts_only_where_the_person_can_resolve_them() {
        let alert = |rec: &LibraryRecording| classify(rec).attention;
        let failed = |retryable| {
            with_job(
                remote("a", "failed"),
                JobInfo {
                    error: Some(JobError {
                        code: "engine_error".into(),
                        retryable,
                    }),
                    ..job("failed")
                },
            )
        };
        assert_eq!(alert(&failed(false)), Some(Attention::TranscriptionFailed));
        assert_eq!(
            classify(&failed(false)).detail.as_deref(),
            Some("engine_error")
        );
        // Transient: the server retries.
        assert_eq!(alert(&failed(true)), None);
        assert_eq!(
            alert(&with_steps(
                remote("b", "transcribed"),
                vec![step("summary", "failed", None)]
            )),
            Some(Attention::SummaryFailed)
        );
        let skipped = |reason| {
            with_steps(
                remote("c", "transcribed"),
                vec![step("summary", "skipped", Some(reason))],
            )
        };
        assert_eq!(
            alert(&skipped("no_agenda_type")),
            Some(Attention::NoSummary)
        );
        assert_eq!(classify(&skipped("no_provider")).phase, Phase::NoSummary);
        assert_eq!(alert(&skipped("no_provider")), None);
        assert_eq!(alert(&skipped("cancelled")), None);
    }

    #[test]
    fn unknown_state_needs_you_even_with_summary_ready() {
        let step_info = classify(&with_steps(
            remote("a", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "awaiting_speakers", Some("speakers_required")),
                step("summary", "done", None),
            ],
        ));
        assert_eq!(step_info.phase, Phase::Unknown);
        assert_eq!(step_info.attention, Some(Attention::NeedsYou));
        assert_eq!(step_info.stage.as_deref(), Some("speakers"));
        assert_eq!(step_info.detail.as_deref(), Some("awaiting_speakers"));
        assert_eq!(step_info.reason.as_deref(), Some("speakers_required"));

        let status = classify(&remote("b", "awaiting_speakers"));
        assert_eq!(
            (status.phase, status.attention, status.detail.as_deref()),
            (
                Phase::Unknown,
                Some(Attention::NeedsYou),
                Some("awaiting_speakers")
            )
        );
    }

    #[test]
    fn waiting_speakers_raise_alert_with_step_and_reason() {
        let step_info = classify(&with_steps(
            remote("w", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "waiting", Some("unnamed_speakers")),
                step("summary", "pending", None),
            ],
        ));
        assert_eq!(step_info.phase, Phase::Unknown);
        assert_eq!(step_info.attention, Some(Attention::NeedsYou));
        assert_eq!(step_info.stage.as_deref(), Some("speakers"));
        assert_eq!(step_info.detail.as_deref(), Some("waiting"));
        assert_eq!(step_info.reason.as_deref(), Some("unnamed_speakers"));
    }

    #[test]
    fn merge_local_queue_and_page_without_duplicates_and_limit_to_n() {
        let queue = vec![
            local("l-gravando", Status::Recording, 500, None),
            local("l-falhou", Status::Failed, 400, None),
            local("l-enviada", Status::Synced, 300, Some("r1")),
            local("l-velha", Status::Synced, 100, Some("r-fora")),
        ];
        let page = vec![
            with_job(remote("r1", "queued"), job("queued")),
            with_steps(
                remote("r2", "transcribed"),
                vec![step("summary", "done", None)],
            ),
            remote("r3", "transcribed"),
        ];
        let mut waits = BTreeMap::new();
        waits.insert(
            "r1".to_string(),
            QueueWait {
                reason: "gpu_busy".into(),
                ahead: Some(2),
                account_ahead: None,
                estimated_start_at: None,
                resumes_at: None,
                processor: None,
            },
        );
        let rows = build(&queue, Some(page.as_slice()), &waits, 4);
        assert_eq!(
            rows.iter().map(|l| l.key.as_str()).collect::<Vec<_>>(),
            ["local:l-gravando", "local:l-falhou", "r1", "r2"]
        );
        assert_eq!(rows[1].attention, Some(Attention::UploadFailed));
        assert_eq!(rows[1].detail.as_deref(), Some("servidor fora do ar"));
        // The upload from here is the server row, with the local id and queue wait.
        assert_eq!(rows[2].local_id.as_deref(), Some("l-enviada"));
        assert_eq!(rows[2].wait.as_ref().map(|w| w.ahead), Some(Some(2)));
        assert_eq!(rows[3].phase, Phase::SummaryReady);

        // Without a server read, uploaded recordings appear as Uploaded.
        let without_server = build(&queue, None, &BTreeMap::new(), 5);
        assert_eq!(without_server.len(), 4);
        assert_eq!(without_server[2].phase, Phase::Uploaded);
        assert_eq!(without_server[2].key, "r1");

        assert!(build(&queue, Some(page.as_slice()), &waits, 0).is_empty());
    }

    #[test]
    fn read_requests_the_greater_count() {
        assert_eq!(fetch_count(5, 1), 5);
        assert_eq!(fetch_count(0, 3), 3);
        assert_eq!(fetch_count(0, 0), 0);
        // The window and tray each take their own N rows from the same list.
        let page: Vec<_> = (1..=5)
            .map(|n| remote(&format!("r{n}"), "transcribed"))
            .collect();
        let window = build(&[], Some(page.as_slice()), &BTreeMap::new(), 5);
        let tray = build(&[], Some(page.as_slice()), &BTreeMap::new(), 1);
        assert_eq!(window.len(), 5);
        assert_eq!(tray, window[..1]);
    }

    fn entry(item: RecentItem) -> TrayEntry {
        tray_section_of(&[item]).entries.remove(0)
    }

    #[test]
    fn tray_labels_each_phase_and_offers_applicable_actions() {
        let ready = build(
            &[],
            Some(
                &[with_steps(
                    remote("r1", "transcribed"),
                    vec![step("summary", "done", None)],
                )][..],
            ),
            &BTreeMap::new(),
            1,
        );
        assert_eq!(
            entry(ready[0].clone()),
            TrayEntry {
                key: "r1".into(),
                label: "Reunião r1 · Resumo pronto".into(),
                actions: vec![
                    TrayAction::CopySummary("r1".into()),
                    TrayAction::OpenWeb("r1".into())
                ],
            }
        );

        let failed = build(
            &[local("l1", Status::Failed, 10, None)],
            None,
            &BTreeMap::new(),
            1,
        );
        let mut failed = failed[0].clone();
        failed.title = "Daily".into();
        assert_eq!(
            entry(failed),
            TrayEntry {
                key: "local:l1".into(),
                label: "Daily · Precisa de você (Falhou o envio)".into(),
                actions: vec![TrayAction::Retry("l1".into())],
            }
        );

        let mut recording = build(
            &[local("l2", Status::Recording, 10, None)],
            None,
            &BTreeMap::new(),
            1,
        )[0]
        .clone();
        recording.title = "Reunião".into();
        let recording = entry(recording);
        assert_eq!(recording.label, "Reunião · Gravando");
        assert!(recording.actions.is_empty());

        let speakers = with_steps(
            remote("r2", "transcribed"),
            vec![step("speakers", "waiting", Some("unnamed_speakers"))],
        );
        let speakers = build(&[], Some(&[speakers][..]), &BTreeMap::new(), 1);
        assert_eq!(
            entry(speakers[0].clone()).label,
            "Reunião r2 · Precisa de você (Aguardando locutores)"
        );
        let new = build(
            &[],
            Some(&[remote("r3", "estado_novo")][..]),
            &BTreeMap::new(),
            1,
        );
        assert_eq!(entry(new[0].clone()).label, "Reunião r3 · Precisa de você");

        let summary = with_steps(
            with_job(remote("r4", "transcribed"), job("succeeded")),
            vec![step("summary", "active", None)],
        );
        let summary = build(&[], Some(&[summary][..]), &BTreeMap::new(), 1);
        assert_eq!(entry(summary[0].clone()).label, "Reunião r4 · Resumindo");
        assert_eq!(
            entry(summary[0].clone()).actions,
            [TrayAction::OpenWeb("r4".into())]
        );
    }

    #[test]
    fn tray_counts_alerts_in_header_and_ignores_progress() {
        let queue = vec![
            local("a", Status::Failed, 3, None),
            local("b", Status::Failed, 2, None),
            local("c", Status::Pending, 1, None),
        ];
        let rows = build(&queue, None, &BTreeMap::new(), 3);
        assert_eq!(
            tray_section_of(&rows).header,
            "Recentes · 2 precisam de você"
        );
        assert_eq!(
            tray_section_of(&rows[1..]).header,
            "Recentes · 1 precisa de você"
        );
        assert_eq!(tray_section_of(&rows[2..]).header, "Recentes");
        assert!(tray_section_of(&[]).entries.is_empty());

        // Progress advances without changing the section: it does not rebuild the menu.
        let in_progress = |progress| {
            with_job(
                remote("r", "processing"),
                JobInfo {
                    stage: Some("asr".into()),
                    progress: Some(progress),
                    ..job("running")
                },
            )
        };
        let before = build(&[], Some(&[in_progress(100)][..]), &BTreeMap::new(), 1);
        let after = build(&[], Some(&[in_progress(900)][..]), &BTreeMap::new(), 1);
        assert_ne!(before, after);
        assert_eq!(tray_section_of(&before), tray_section_of(&after));
    }

    #[test]
    fn tray_title_is_short_escapes_ampersand_and_falls_back_to_date() {
        let mut item = build(
            &[],
            Some(&[remote("r", "transcribed")][..]),
            &BTreeMap::new(),
            1,
        )[0]
        .clone();
        item.title = "P&D · revisão".into();
        assert_eq!(tray_title(&item), "P&&D · revisão");
        item.title = "a".repeat(60);
        let short = tray_title(&item);
        assert_eq!(short.chars().count(), TRAY_TITLE_MAX);
        assert!(short.ends_with('…'));
        item.title = "  ".into();
        // Without a title, use the short date in local time, as in the panel ("dd/mm hh:mm").
        let date = tray_title(&item);
        assert_eq!(date.len(), "05/10 12:00".len());
        assert_eq!(&date[2..3], "/");
        item.created_at = None;
        item.started_at = None;
        assert_eq!(tray_title(&item), "Gravação");
        assert_eq!(
            short_date("2026-10-05T14:02:09").as_deref(),
            Some("05/10 14:02")
        );
        assert_eq!(short_date("curto"), None);
    }

    #[test]
    fn read_more_often_only_with_window_visible_and_work_in_progress() {
        let queue = vec![local("l", Status::Pending, 1, None)];
        let in_progress = build(&queue, Some(&[][..]), &BTreeMap::new(), 5);
        assert_eq!(interval(&in_progress, true), BUSY_INTERVAL);
        assert_eq!(interval(&in_progress, false), IDLE_INTERVAL);
        let ready = build(
            &[],
            Some(
                &[with_steps(
                    remote("r", "transcribed"),
                    vec![step("summary", "done", None)],
                )][..],
            ),
            &BTreeMap::new(),
            5,
        );
        assert_eq!(interval(&ready, true), IDLE_INTERVAL);
    }

    #[test]
    fn failed_read_doubles_wait_up_to_one_minute_otherwise_normal_interval() {
        let secs = Duration::from_secs;
        assert_eq!(error_interval(BUSY_INTERVAL, 0), secs(5));
        assert_eq!(error_interval(BUSY_INTERVAL, 1), secs(10));
        assert_eq!(error_interval(BUSY_INTERVAL, 2), secs(20));
        assert_eq!(error_interval(BUSY_INTERVAL, 3), secs(40));
        assert_eq!(error_interval(BUSY_INTERVAL, 4), secs(60));
        assert_eq!(error_interval(BUSY_INTERVAL, 1_000), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, 0), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, 5), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, u32::MAX), secs(60));
    }

    #[test]
    fn full_page_only_at_fast_interval_on_nudge_and_every_ten_minutes() {
        let since = Some("2026-10-05T12:00:00Z");
        let now = 100 * 60 * 1000;
        let recent = Some(now - 60 * 1000);
        // Slow interval, same page, `since` and count: only changes.
        assert!(!read_full_page(since, recent, true, false, false, now));
        // Nudge, fast interval, changed count, no `since` or no previous full page.
        assert!(read_full_page(since, recent, true, true, false, now));
        assert!(read_full_page(since, recent, true, false, true, now));
        assert!(read_full_page(since, recent, false, false, false, now));
        assert!(read_full_page(None, recent, true, false, false, now));
        assert!(read_full_page(since, None, true, false, false, now));
        // A full page from 10 min ago is old; a clock that went backward is also invalid.
        assert!(read_full_page(
            since,
            Some(now - FULL_READ_EVERY_MS),
            true,
            false,
            false,
            now
        ));
        assert!(!read_full_page(
            since,
            Some(now - FULL_READ_EVERY_MS + 1),
            true,
            false,
            false,
            now
        ));
        assert!(read_full_page(
            since,
            Some(now + 1),
            true,
            false,
            false,
            now
        ));
    }

    #[test]
    fn merge_replaces_by_id_adds_new_and_keeps_most_recent() {
        let at = |id: &str, status: &str, created: &str| {
            let mut rec = remote(id, status);
            rec.created_at = Some(created.into());
            rec
        };
        let page = vec![
            at("c", "processing", "2026-10-05T12:03:00Z"),
            at("b", "transcribed", "2026-10-05T12:02:00Z"),
            at("a", "transcribed", "2026-10-05T12:01:00Z"),
        ];
        let changed = vec![
            // Replace "c", which finished.
            at("c", "transcribed", "2026-10-05T12:03:00Z"),
            // New, the most recent.
            at("d", "queued", "2026-10-05T12:04:00Z"),
            // Older than the full page: falls outside the limit.
            at("z", "transcribed", "2026-10-05T11:00:00Z"),
        ];
        let merged = merge_changes(&page, &changed, 3);
        let seen: Vec<(&str, &str)> = merged
            .iter()
            .map(|rec| (rec.id.as_str(), rec.status.as_str()))
            .collect();
        assert_eq!(
            seen,
            [("d", "queued"), ("c", "transcribed"), ("b", "transcribed")]
        );
        // Without changes, the page stays as it was.
        assert_eq!(merge_changes(&page, &[], 3), page);
        // Compare dates as dates, not text ("…:05Z" comes after "…:05.5Z").
        let fine = vec![
            at("x", "queued", "2026-10-05T12:00:05Z"),
            at("y", "queued", "2026-10-05T12:00:05.500000Z"),
        ];
        let merged = merge_changes(&[], &fine, 2);
        assert_eq!(merged[0].id, "y");
    }
}
