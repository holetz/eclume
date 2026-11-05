//! Sync loop: every 30 s, or when nudged (recording ended, settings saved, Sync now), return
//! failed recordings whose backoff expired to the queue, upload `pending` recordings through
//! `HttpUploader` and apply retention. Local files are removed only after server confirmation.
//! Then, at most once per minute (the `?since=` read is shared with recent recordings and the
//! synced folder, see [`library_since`]), read changed recordings in the account and notify
//! processing outcomes (summary ready, summary failed, ready without summary, transcription
//! failed). Store the server title and queue wait for recordings uploaded from here. With a
//! pinned CA, learn the next root announced by the descriptor every 6 h (rotation). Upload or
//! read failures check whether the CA changed, switching to the next one if it is being served.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_recorder::{now_ms, sync_pending, Queue, QueuedRecording, Status};
use eclume_sync::api::LibraryRecording;
use eclume_sync::{Client, Ended, HttpUploader, Outcome, UploaderConfig, Watermark};
use tauri::{AppHandle, Manager};

use crate::i18n::{self, Locale, Msg};
use crate::state::AppState;

const INTERVAL: Duration = Duration::from_secs(30);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Minimum interval between server outcome reads.
const OUTCOMES_EVERY_MS: i64 = 60 * 1000;
/// Outcome notification watermark ([`Watermark`]) in the data directory. The name comes from
/// the old summary-ready notification; the old format (id → time) cannot load as a mark and resets.
const NOTIFIED_FILE: &str = "resumos-avisados.json";

static LAST_OUTCOMES_CHECK: AtomicI64 = AtomicI64::new(0);
/// Shared `?since=` read lifetime: just under a minute, so the next minute’s iteration
/// reads again instead of reusing an old read.
const SHARED_READ_TTL_MS: i64 = 55 * 1000;
/// Interval between next-CA reads from the descriptor, and retry interval after failure.
const NEXT_CA_EVERY_MS: i64 = 6 * 60 * 60 * 1000;
const NEXT_CA_RETRY_MS: i64 = 10 * 60 * 1000;

static LAST_NEXT_CA_CHECK: AtomicI64 = AtomicI64::new(0);

/// The account’s last `?since=` read, from whoever read first in the minute.
struct SharedRead {
    /// Owner: address and device credential, so switching accounts does not inherit another read.
    owner: u64,
    since: String,
    at_ms: i64,
    items: Vec<LibraryRecording>,
}

static SHARED_READ: Mutex<Option<SharedRead>> = Mutex::new(None);

fn owner_of(config: &UploaderConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.api_url.hash(&mut hasher);
    config.pat.hash(&mut hasher);
    hasher.finish()
}

/// What the cached read answers for `owner` requesting `?since=wanted` at `now`: its recordings
/// with `updated_at >= wanted`, if the owner matches, it is still fresh and its `since` is equal
/// or older (covers everything requested). `None`: a server read is needed.
fn shared_answer(
    cached: Option<&SharedRead>,
    owner: u64,
    wanted: &str,
    now: i64,
) -> Option<Vec<LibraryRecording>> {
    let cached = cached?;
    let age = now - cached.at_ms;
    if cached.owner != owner
        || !(0..SHARED_READ_TTL_MS).contains(&age)
        || !eclume_sync::api::since_covers(&cached.since, wanted)
    {
        return None;
    }
    Some(
        cached
            .items
            .iter()
            .filter(|item| item.updated_since(wanted))
            .cloned()
            .collect(),
    )
}

/// `GET /recordings?since=`, one read per minute for those that need it: outcome notifications,
/// recent recordings and the synced folder each request their own `since`, but one read covers
/// the others when its `since` is equal or older. A request not covered reads from the server
/// and leaves its (older) read for the others.
pub fn library_since(
    config: &UploaderConfig,
    client: &Client,
    since: &str,
) -> Result<Vec<LibraryRecording>> {
    let owner = owner_of(config);
    let now = now_ms();
    if let Ok(cached) = SHARED_READ.lock() {
        if let Some(items) = shared_answer(cached.as_ref(), owner, since, now) {
            return Ok(items);
        }
    }
    let items = client.library(Some(since))?;
    if let Ok(mut cached) = SHARED_READ.lock() {
        *cached = Some(SharedRead {
            owner,
            since: since.to_string(),
            at_ms: now,
            items: items.clone(),
        });
    }
    Ok(items)
}

/// Without a device credential, recordings wait for the next sign-in.
fn sign_in_to_send(pending: u32, locale: Locale) -> String {
    let msg = if pending == 1 {
        Msg::new(|t| t.notice_sign_in_one)
    } else {
        Msg::new(|t| t.notice_sign_in_other)
    };
    msg.arg("count", pending).text(locale)
}

/// The channel for nudging the loop.
pub struct SyncHandle(Mutex<Sender<()>>);

/// Start the sync thread and register the channel in the app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(SyncHandle(Mutex::new(tx)));
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-sync".into())
        .spawn(move || {
            // Wake every `INTERVAL` or on a nudge; exit when the app closes the channel.
            let mut backoff = crate::supervise::Backoff::default();
            while let Ok(()) | Err(RecvTimeoutError::Timeout) = rx.recv_timeout(INTERVAL) {
                // Several consecutive nudges count as a single pass.
                while rx.try_recv().is_ok() {}
                crate::supervise::pass(&mut backoff, "sync", || {
                    if let Err(err) = run_once(&app) {
                        log::error!("sync failed: {err:#}");
                    }
                });
                crate::refresh_ui(&app);
            }
        });
    if let Err(err) = spawned {
        log::error!("failed to start sync: {err}");
    }
}

/// Request a sync pass now.
pub fn nudge(app: &AppHandle) {
    if let Some(handle) = app.try_state::<SyncHandle>() {
        if let Ok(tx) = handle.0.lock() {
            let _ = tx.send(());
        }
    }
}

/// Sync now: return failures to the queue without waiting for backoff.
pub fn sync_now(app: &AppHandle) -> Result<()> {
    lock(app.state::<AppState>().queue())?.retry_failed(i64::MAX)?;
    nudge(app);
    Ok(())
}

fn lock(queue: &Mutex<Queue>) -> Result<std::sync::MutexGuard<'_, Queue>> {
    queue
        .lock()
        .map_err(|_| anyhow!(Msg::new(|t| t.err_queue_poisoned)))
}

fn run_once(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let locale = state.locale()?;
    let pending = {
        let queue = lock(state.queue())?;
        queue.retry_due(now_ms(), i64::MAX)?;
        queue.counts()?.pending
    };
    if pending > 0 {
        match state.uploader_config()? {
            None if state.pinned_ca_changed()? => {}
            None => state.set_sync_notice(Some(sign_in_to_send(pending, locale)))?,
            Some(config) => {
                let uploader = HttpUploader::new(&config, state.shared_queue())
                    .map(|uploader| uploader.with_language(state.language().ok().flatten()));
                let notice = match uploader {
                    Ok(uploader) => {
                        let syncing = state.syncing();
                        crate::refresh_ui(app);
                        let report = sync_pending(state.queue(), &uploader);
                        drop(syncing);
                        let report = report?;
                        log::info!("sync: {report:?}");
                        // The recent panel replaces the local row with the server row.
                        crate::recent::nudge(app);
                        (report.failed > 0)
                            .then(|| last_failure(state.queue()))
                            .transpose()?
                            .flatten()
                    }
                    Err(err) => Some(i18n::render(&err, locale)),
                };
                let failed = notice.is_some();
                state.set_sync_notice(notice.map(|err| {
                    Msg::new(|t| t.notice_sync_failed)
                        .arg("error", err)
                        .text(locale)
                }))?;
                if failed {
                    check_pinned_ca(&state)?;
                }
            }
        }
    }
    // Read retention before locking the queue: lock order is always state → queue.
    let retention_days = state.retention_days()?;
    apply_retention(&*lock(state.queue())?, retention_days, now_ms())?;
    if let Err(err) = check_outcomes(app, &state) {
        log::info!("outcomes: {err:#}");
        check_pinned_ca(&state)?;
    }
    learn_next_ca(&state)
}

/// Read account recordings changed since the watermark: notify each new outcome (if enabled),
/// store the server title of recordings uploaded from here and read the queue wait for uploads
/// in the last 24 h without an outcome. Without a mark (first launch or an old-format file),
/// notify nothing before now: the update does not trigger a burst.
fn check_outcomes(app: &AppHandle, state: &AppState) -> Result<()> {
    let now = now_ms();
    if now - LAST_OUTCOMES_CHECK.load(Ordering::Relaxed) < OUTCOMES_EVERY_MS {
        return Ok(());
    }
    LAST_OUTCOMES_CHECK.store(now, Ordering::Relaxed);
    let Some(config) = state.uploader_config()? else {
        return Ok(());
    };
    let client = Client::from_config(&config)?;
    let path = state.data_dir().join(NOTIFIED_FILE);
    let mut mark = load_mark(&path).unwrap_or_else(|| Watermark::starting_ms(now));
    let items = library_since(&config, &client, &mark.since)?;
    let ended = mark.take(&items);
    let mut changed = false;
    {
        let queue = lock(state.queue())?;
        for item in items.iter().filter(|item| !item.title.trim().is_empty()) {
            changed |= queue.set_server_title(&item.id, &item.title)?;
        }
    }
    if state.notify_summary()? && !ended.is_empty() {
        announce(app, &client, &state.web_url()?, &ended);
    }
    save_mark(&path, &mark)?;

    let synced = lock(state.queue())?.by_status(Status::Synced)?;
    let mut waits = BTreeMap::new();
    for remote_id in wait_candidates(&synced, &mark, now) {
        match client.queue_wait(&remote_id) {
            Ok(Some(wait)) => {
                waits.insert(remote_id, wait);
            }
            Ok(None) => {}
            // Server unavailable: retry on the next iteration.
            Err(err) => {
                log::info!("wait for {remote_id}: {err:#}");
                break;
            }
        }
    }
    if state.set_queue_waits(waits)? || changed {
        crate::refresh_ui(app);
    }
    Ok(())
}

/// One notification per outcome, or a grouped one above [`crate::notify::GROUP_ABOVE`].
/// Summary ready reads Markdown for Copy; without it, the notification only offers Open.
fn announce(app: &AppHandle, client: &Client, web_url: &str, ended: &[Ended]) {
    if ended.len() > crate::notify::GROUP_ABOVE {
        let library = format!("{}/", web_url.trim_end_matches('/'));
        crate::notify::outcomes_grouped(app, ended.len(), library);
        return;
    }
    for item in ended {
        let markdown = (item.outcome == Outcome::SummaryReady)
            .then(|| match client.current_summary(&item.recording_id) {
                Ok(summary) => summary.map(|summary| summary.content_md),
                Err(err) => {
                    log::info!("summary for {}: {err:#}", item.recording_id);
                    None
                }
            })
            .flatten();
        let url = recording_url(web_url, &item.recording_id);
        crate::notify::outcome(app, item, markdown, url);
    }
}

/// Recordings uploaded from here in the last 24 h without an outcome: read their queue wait.
fn wait_candidates(synced: &[QueuedRecording], mark: &Watermark, now: i64) -> Vec<String> {
    synced
        .iter()
        .filter(|rec| rec.synced_at.is_some_and(|at| now - at < DAY_MS))
        .filter_map(|rec| rec.remote_id.clone())
        .filter(|id| !mark.notified.contains_key(id))
        .collect()
}

/// The recording page in eclume web.
pub(crate) fn recording_url(web_url: &str, remote_id: &str) -> String {
    format!("{}/gravacoes/{remote_id}", web_url.trim_end_matches('/'))
}

/// `None` if the file is missing, unreadable or in the old format: restart from the mark.
fn load_mark(path: &Path) -> Option<Watermark> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_mark(path: &Path, mark: &Watermark) -> Result<()> {
    std::fs::write(path, serde_json::to_vec(mark)?)?;
    Ok(())
}

/// After a failure, check whether the pinned CA is still the server’s CA. If the served CA is
/// the announced next one, pin it and continue syncing; if it changed to another CA, stop sync
/// and return the window to first run (the server certificate changed).
fn check_pinned_ca(state: &AppState) -> Result<()> {
    let Some((web_url, pinned)) = state.pinned_ca()? else {
        return Ok(());
    };
    match crate::account::ca_changed(&crate::account::RealNet, &web_url, &pinned) {
        Ok(true) => state.mark_ca_changed(),
        Ok(false) => Ok(()),
        Err(err) => {
            log::info!("could not check server CA: {err:#}");
            Ok(())
        }
    }
}

/// Learn the next CA announced by the descriptor over the connection pinned to the current CA
/// ([`learn_next`]), at most every [`NEXT_CA_EVERY_MS`]; retry failures in [`NEXT_CA_RETRY_MS`].
///
/// [`learn_next`]: crate::account::learn_next
fn learn_next_ca(state: &AppState) -> Result<()> {
    let now = now_ms();
    if now - LAST_NEXT_CA_CHECK.load(Ordering::Relaxed) < NEXT_CA_EVERY_MS {
        return Ok(());
    }
    let Some((web_url, pinned)) = state.pinned_ca()? else {
        return Ok(());
    };
    if state.pinned_ca_changed()? {
        return Ok(());
    }
    match crate::account::learn_next(&crate::account::RealNet, &web_url, &pinned) {
        Ok(learned) => {
            if learned {
                log::info!("next server CA saved");
            }
            LAST_NEXT_CA_CHECK.store(now, Ordering::Relaxed);
        }
        Err(err) => {
            log::info!("could not read next server CA: {err:#}");
            LAST_NEXT_CA_CHECK.store(now - NEXT_CA_EVERY_MS + NEXT_CA_RETRY_MS, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// The most recent failure’s error, for the window.
fn last_failure(queue: &Mutex<Queue>) -> Result<Option<String>> {
    Ok(lock(queue)?
        .by_status(Status::Failed)?
        .into_iter()
        .last()
        .and_then(|rec| rec.last_error))
}

/// Delete local files of recordings confirmed more than `retention_days` days ago (`None`:
/// never). Keep the row in the queue with `purged_at`. Return the number deleted.
pub fn apply_retention(queue: &Queue, retention_days: Option<u32>, now: i64) -> Result<usize> {
    let Some(days) = retention_days else {
        return Ok(0);
    };
    let cutoff = now - i64::from(days) * DAY_MS;
    let mut purged = 0;
    for recording in queue.purge_candidates(cutoff)? {
        match std::fs::remove_file(&recording.path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                log::warn!("failed to delete {}: {err}", recording.path.display());
                continue;
            }
        }
        queue.mark_purged(&recording.id, now)?;
        purged += 1;
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn synced(queue: &mut Queue, id: &str, path: &Path) {
        std::fs::write(path, b"ogg").unwrap();
        queue.begin(id, &path.with_extension("part"), 1).unwrap();
        queue.finish(id, path, 2, 1, 3).unwrap();
        queue.claim_next().unwrap().unwrap();
        queue.mark_synced(id, &format!("srv-{id}")).unwrap();
    }

    #[test]
    fn retention_deletes_only_confirmed_recordings_after_deadline() {
        let dir = std::env::temp_dir().join(format!("eclume-retencao-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        let confirmed = dir.join("a.ogg");
        synced(&mut queue, "a", &confirmed);
        let pending = dir.join("b.ogg");
        std::fs::write(&pending, b"ogg").unwrap();
        queue.begin("b", &dir.join("b.part"), 3).unwrap();
        queue.finish("b", &pending, 4, 1, 3).unwrap();

        let now = now_ms();
        assert_eq!(
            apply_retention(&queue, None, now + 365 * DAY_MS).unwrap(),
            0
        );
        assert_eq!(apply_retention(&queue, Some(7), now).unwrap(), 0);
        assert!(confirmed.exists());
        assert_eq!(
            apply_retention(&queue, Some(7), now + 8 * DAY_MS).unwrap(),
            1
        );
        assert!(!confirmed.exists());
        assert!(
            pending.exists(),
            "unconfirmed recording is never removed from disk"
        );
        assert!(queue.get("a").unwrap().unwrap().purged_at.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn wait_only_for_uploads_in_last_24_hours_without_outcome_and_save_mark() {
        let dir = std::env::temp_dir().join(format!("eclume-desfechos-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        synced(&mut queue, "a", &dir.join("a.ogg"));
        synced(&mut queue, "b", &dir.join("b.ogg"));
        let recs = queue.by_status(Status::Synced).unwrap();
        let now = now_ms();

        let mut mark = Watermark::starting_ms(now);
        let mut ids = wait_candidates(&recs, &mark, now);
        ids.sort();
        assert_eq!(ids, ["srv-a", "srv-b"]);
        mark.notified.insert("srv-a".into(), mark.mark.clone());
        assert_eq!(wait_candidates(&recs, &mark, now), ["srv-b"]);
        assert!(wait_candidates(&recs, &mark, now + DAY_MS).is_empty());

        assert!(queue.set_server_title("srv-a", "Alinhamento").unwrap());
        assert_eq!(
            queue.get("a").unwrap().unwrap().server_title.as_deref(),
            Some("Alinhamento")
        );

        let path = dir.join(NOTIFIED_FILE);
        assert_eq!(load_mark(&path), None, "no file on first launch");
        save_mark(&path, &mark).unwrap();
        assert_eq!(load_mark(&path), Some(mark));
        // The old format (id → time) restarts from the mark: nothing retroactive.
        std::fs::write(&path, br#"{"srv-a": 1727780000000}"#).unwrap();
        assert_eq!(load_mark(&path), None);
        assert_eq!(
            recording_url("https://192.0.2.10:8443/", "srv-a"),
            "https://192.0.2.10:8443/gravacoes/srv-a"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recordings_without_device_credential_wait_for_sign_in() {
        assert_eq!(
            sign_in_to_send(1, Locale::En),
            "Sign in to send 1 recording"
        );
        assert_eq!(
            sign_in_to_send(2, Locale::En),
            "Sign in to send 2 recordings"
        );
        assert_eq!(
            sign_in_to_send(1, Locale::PtBr),
            "Entre para enviar 1 gravação"
        );
        assert_eq!(
            sign_in_to_send(2, Locale::PtBr),
            "Entre para enviar 2 gravações"
        );
    }

    #[test]
    fn zero_retention_deletes_immediately_and_tolerates_missing_file() {
        let dir = std::env::temp_dir().join(format!("eclume-retencao0-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut queue = Queue::open_in_memory().unwrap();
        let path = dir.join("c.ogg");
        synced(&mut queue, "c", &path);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(apply_retention(&queue, Some(0), now_ms() + 1).unwrap(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn changed(id: &str, updated_at: &str) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: String::new(),
            status: String::new(),
            recorded_at: None,
            created_at: None,
            updated_at: Some(updated_at.into()),
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: vec![],
            job: None,
        }
    }

    fn shared(owner: u64, since: &str, at_ms: i64) -> SharedRead {
        SharedRead {
            owner,
            since: since.into(),
            at_ms,
            items: vec![
                changed("a", "2026-10-01T10:00:00Z"),
                changed("b", "2026-10-01T10:05:00Z"),
            ],
        }
    }

    fn ids(items: Vec<LibraryRecording>) -> Vec<String> {
        items.into_iter().map(|item| item.id).collect()
    }

    #[test]
    fn shared_read_answers_requests_with_same_or_newer_since() {
        let cached = shared(1, "2026-10-01T09:58:00Z", 1_000_000);
        let now = 1_000_000 + 30_000;
        // Older than or equal to the request: usable, filtering by the requested `updated_at`.
        assert_eq!(
            ids(shared_answer(Some(&cached), 1, "2026-10-01T09:58:00Z", now).unwrap()),
            ["a", "b"]
        );
        assert_eq!(
            ids(shared_answer(Some(&cached), 1, "2026-10-01T10:03:00Z", now).unwrap()),
            ["b"]
        );
        // A `since` older than the cached read is not covered.
        assert!(shared_answer(Some(&cached), 1, "2026-10-01T09:00:00Z", now).is_none());
        // Another account never inherits the read.
        assert!(shared_answer(Some(&cached), 2, "2026-10-01T10:03:00Z", now).is_none());
        assert!(shared_answer(None, 1, "2026-10-01T10:03:00Z", now).is_none());
    }

    #[test]
    fn shared_read_is_valid_for_less_than_one_minute() {
        let cached = shared(1, "2026-10-01T09:58:00Z", 1_000_000);
        let since = "2026-10-01T10:00:00Z";
        assert!(
            shared_answer(Some(&cached), 1, since, 1_000_000 + SHARED_READ_TTL_MS - 1).is_some()
        );
        assert!(shared_answer(Some(&cached), 1, since, 1_000_000 + SHARED_READ_TTL_MS).is_none());
        // The clock went backward: do not trust the age.
        assert!(shared_answer(Some(&cached), 1, since, 999_999).is_none());
    }
}
