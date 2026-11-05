//! The synced folder: a loop that mirrors the user’s library (Markdown summaries and JSONL
//! transcripts, one subfolder per collection) into a local folder. Runs in its own thread
//! so a large library does not delay recording uploads.
//!
//! Each cycle reads only changes since the last one (manifest `?since=`, shared with outcome
//! notifications and recent recordings, see [`crate::sync::library_since`]) and rereads pending
//! recordings by id. Every 6 h, and on Sync now, a sweep checks the entire library and removes
//! recordings deleted from the server.
//! The contract is in docs/standards/code/desktop-pasta-sincronizada.md.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_mirror::{
    Applied, Mirror, MirrorItem, MirrorMarker, Segment, Speaker, Summary, Transcript,
};
use eclume_recorder::now_ms;
use eclume_sync::api::{self, CollectionInfo, LibraryRecording};
use eclume_sync::{Client, LibrarySummary, MissingScope, UploaderConfig};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Interval between cycles.
const INTERVAL: Duration = Duration::from_secs(60);
/// The sweep checks the entire library and removes recordings deleted from the server.
const SWEEP_EVERY_MS: i64 = 6 * 60 * 60 * 1000;

static LAST_SWEEP: AtomicI64 = AtomicI64::new(0);

/// What the mirror reads from the server. The real `Client` in production, a fake in tests.
pub trait Source {
    fn collections(&self) -> Result<Vec<CollectionInfo>>;
    fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>>;
    /// One recording by id (`None`: deleted), to reread a pending item without listing the library.
    fn recording(&self, recording_id: &str) -> Result<Option<LibraryRecording>>;
    fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>>;
    fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>>;
    /// Recording markers, for the `.md` notes section.
    fn markers(&self, recording_id: &str) -> Result<Vec<api::Marker>>;
    /// Recording start in local time (`YYYY-MM-DDTHH:MM:SS`), used for the file’s month and name.
    /// Defaults to this computer’s time zone; tests use a fixed one.
    fn local_start(&self, recorded_at: &str) -> Option<String> {
        api::local_start(recorded_at)
    }
}

impl Source for Client {
    fn collections(&self) -> Result<Vec<CollectionInfo>> {
        Client::collections(self)
    }
    fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>> {
        Client::library(self, since)
    }
    fn recording(&self, recording_id: &str) -> Result<Option<LibraryRecording>> {
        Client::recording(self, recording_id)
    }
    fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>> {
        Client::current_summary(self, recording_id)
    }
    fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>> {
        Client::transcript(self, recording_id)
    }
    fn markers(&self, recording_id: &str) -> Result<Vec<api::Marker>> {
        Client::markers(self, recording_id)
    }
}

/// The `Client` with `?since=` reads shared with outcome notifications and recent recordings:
/// incremental reads use [`crate::sync::library_since`]; full library and other reads go direct.
struct SharedSource<'a> {
    config: &'a UploaderConfig,
    client: &'a Client,
}

impl Source for SharedSource<'_> {
    fn collections(&self) -> Result<Vec<CollectionInfo>> {
        Source::collections(self.client)
    }
    fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>> {
        match since {
            Some(since) => crate::sync::library_since(self.config, self.client, since),
            None => Source::library(self.client, None),
        }
    }
    fn recording(&self, recording_id: &str) -> Result<Option<LibraryRecording>> {
        Source::recording(self.client, recording_id)
    }
    fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>> {
        Source::current_summary(self.client, recording_id)
    }
    fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>> {
        Source::transcript(self.client, recording_id)
    }
    fn markers(&self, recording_id: &str) -> Result<Vec<api::Marker>> {
        Source::markers(self.client, recording_id)
    }
}

/// The result of a cycle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Report {
    /// Recordings read in this cycle (changed ones, or all on the first pass).
    pub recordings: usize,
    pub written: usize,
    pub unchanged: usize,
    pub removed: usize,
    /// Recordings that failed to read: the cursor does not advance and the next cycle retries them.
    pub failed: usize,
    /// The server refused transcript reads (403 `insufficient_scope`): summaries were synced
    /// and transcripts wait for the server to allow the scope.
    pub transcripts_denied: bool,
}

/// Build what the mirror writes from the server response.
pub fn to_item(
    recording: &LibraryRecording,
    local_start: Option<String>,
    collections: &HashMap<String, String>,
    summary: Option<LibrarySummary>,
    transcript: Option<api::Transcript>,
    markers: Vec<api::Marker>,
) -> MirrorItem {
    let title = if recording.title.trim().is_empty() {
        transcript
            .as_ref()
            .map(|t| t.title.clone())
            .unwrap_or_default()
    } else {
        recording.title.clone()
    };
    let mut names: Vec<String> = recording
        .collection_ids
        .iter()
        .filter_map(|id| collections.get(id).cloned())
        .collect();
    names.sort();
    names.dedup();
    let agenda_type = summary
        .as_ref()
        .and_then(|s| s.agenda_type.clone())
        .or_else(|| recording.agenda_type.as_ref().map(|a| a.name.clone()))
        .filter(|name| !name.is_empty());
    MirrorItem {
        recording_id: recording.id.clone(),
        title,
        recorded_at: recording.recorded_at.clone(),
        local_start,
        collections: names,
        agenda_type,
        markers: markers
            .into_iter()
            .filter_map(|marker| {
                let note = marker.note?;
                (!note.trim().is_empty()).then_some(MirrorMarker {
                    at_ms: marker.at_ms,
                    note,
                })
            })
            .collect(),
        summary: summary.map(|s| Summary {
            version: s.version,
            markdown: s.content_md,
            transcript_revision: s.transcript_revision,
        }),
        transcript: transcript.map(|t| Transcript {
            id: t.id,
            language: t.language,
            duration_ms: t.duration_ms,
            revision: t.revision,
            speakers: t
                .speakers
                .into_iter()
                .map(|s| Speaker {
                    id: s.id,
                    label: s.label,
                })
                .collect(),
            segments: t
                .segments
                .into_iter()
                .map(|s| Segment {
                    speaker_id: s.speaker_id,
                    start_ms: s.start_ms,
                    end_ms: s.end_ms,
                    text: s.text,
                })
                .collect(),
        }),
    }
}

/// `since` cursor margin, in seconds: covers a transaction committed after another with a
/// greater `updated_at` (server `now()` is the transaction start).
const CURSOR_MARGIN_SECS: i64 = 120;

/// Collection names by id, with one spelling per name: "Clientes" and "clientes" become the
/// same folder on Windows and macOS, so all use the first spelling (sorted by name and id).
fn collection_names(mut collections: Vec<CollectionInfo>) -> HashMap<String, String> {
    collections.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
    let mut canonical: HashMap<String, String> = HashMap::new();
    let mut names = HashMap::new();
    for collection in collections {
        let spelled = canonical
            .entry(collection.name.to_lowercase())
            .or_insert_with(|| collection.name.clone())
            .clone();
        names.insert(collection.id, spelled);
    }
    names
}

/// One cycle: read changes (or everything on the first pass), write, and during a sweep remove
/// recordings deleted from the server. Always save the manifest at the end, even after an error:
/// files already written must not be left untracked.
pub fn sync_library(
    source: &dyn Source,
    mirror: &mut Mirror,
    transcripts: bool,
    sweep: bool,
) -> Result<Report> {
    let names = collection_names(source.collections()?);
    // Files from an older folder and naming layout, or written with the previous transcript
    // setting: reread everything, and let the manifest move and delete leftovers.
    let since = if mirror.needs_rebuild(transcripts) {
        None
    } else {
        mirror.since().map(str::to_string)
    };
    let changed = source.library(since.as_deref())?;
    let cursor = api::cursor_from(&changed, CURSOR_MARGIN_SECS);
    let mut pending = mirror.pending().clone();

    // First pass: the listing already contains the entire library. Later sweeps request it all
    // to find deletions, recordings missing from the manifest and pending items; outside sweeps,
    // only pending items are reread, by id.
    let mut todo = changed;
    let mut present: Option<Vec<String>> = None;
    if since.is_none() {
        present = Some(todo.iter().map(|r| r.id.clone()).collect());
    } else if sweep {
        let all = source.library(None)?;
        present = Some(all.iter().map(|r| r.id.clone()).collect());
        for recording in all {
            // Recordings missing from the manifest, missing transcripts (server previously lacked
            // the scope) and pending items.
            let missing = pending.contains(&recording.id)
                || match mirror.entry(&recording.id) {
                    None => true,
                    Some(entry) => {
                        transcripts
                            && recording.transcript_id.is_some()
                            && entry.transcript_revision.is_none()
                    }
                };
            if missing && !todo.iter().any(|r| r.id == recording.id) {
                todo.push(recording);
            }
        }
    } else {
        // Without a sweep, pending items return by id: the full library is read only every 6 h.
        for id in pending.clone() {
            if todo.iter().any(|r| r.id == id) {
                continue;
            }
            match source.recording(&id) {
                Ok(Some(recording)) => todo.push(recording),
                // Deleted on the server: nothing left to retry; the sweep removes the file.
                Ok(None) => {
                    pending.remove(&id);
                }
                // Server unavailable: remains pending and the next cycle retries.
                Err(err) => log::info!("synced folder: pending {id}: {err:#}"),
            }
        }
    }

    let mut report = Report::default();
    // Without the scope, the first refusal applies to the whole cycle: skip further requests.
    let mut transcripts_on = transcripts;
    for recording in &todo {
        report.recordings += 1;
        // A recording that already had `.jsonl` and is now refused stays as it is: degrade by
        // skipping updates, without deleting.
        let had_transcript = mirror
            .entry(&recording.id)
            .is_some_and(|entry| entry.transcript_revision.is_some());
        let read = |transcripts_on: &mut bool, denied: &mut bool| -> Result<Option<MirrorItem>> {
            let summary = if recording.transcript_id.is_some() {
                source.current_summary(&recording.id)?
            } else {
                None
            };
            // Only summaries have `.md`; without one, reading markers would be a wasted call.
            let markers = if summary.is_some() {
                source.markers(&recording.id)?
            } else {
                Vec::new()
            };
            let transcript = if *transcripts_on && recording.transcript_id.is_some() {
                match source.transcript(&recording.id) {
                    Ok(transcript) => transcript,
                    Err(err) if err.downcast_ref::<MissingScope>().is_some() => {
                        log::warn!("synced folder: missing transcript scope: {err:#}");
                        *transcripts_on = false;
                        *denied = true;
                        None
                    }
                    Err(err) => return Err(err),
                }
            } else {
                None
            };
            if *denied && had_transcript {
                return Ok(None);
            }
            let local_start = recording
                .recorded_at
                .as_deref()
                .and_then(|at| source.local_start(at));
            Ok(Some(to_item(
                recording,
                local_start,
                &names,
                summary,
                transcript,
                markers,
            )))
        };
        let outcome = match read(&mut transcripts_on, &mut report.transcripts_denied) {
            Ok(Some(item)) => mirror.apply(&item),
            Ok(None) => Ok(Applied::default()),
            Err(err) => Err(err),
        };
        match outcome {
            Ok(applied) => {
                pending.remove(&recording.id);
                report.written += applied.written;
                report.unchanged += applied.unchanged;
                report.removed += applied.removed;
            }
            Err(err) => {
                log::warn!("synced folder: recording {}: {err:#}", recording.id);
                pending.insert(recording.id.clone());
                report.failed += 1;
            }
        }
    }
    let mut fatal = None;
    if let Some(ids) = present {
        let keep = ids.into_iter().collect();
        match mirror.retain_only(&keep) {
            Ok(applied) => report.removed += applied.removed,
            Err(err) => fatal = Some(err),
        }
    }
    // The cursor advances even with failures: failed recordings remain in `pending` and only
    // those are retried next cycle, rather than the entire library.
    if let Some(cursor) = cursor {
        mirror.set_since(Some(cursor));
    } else if since.is_none() {
        // Empty library: the next cycle is already incremental.
        mirror.set_since(Some("1970-01-01T00:00:00Z".to_string()));
    }
    mirror.set_pending(pending);
    mirror.mark_layout_current();
    mirror.set_transcripts(transcripts);
    if let Err(err) = mirror.write_agents(transcripts) {
        // A folder with the file’s name, or a locked file: `AGENTS.md` must not cause the loss
        // of records for files already written.
        log::warn!("synced folder: AGENTS.md: {err:#}");
    }
    mirror.save()?;
    match fatal {
        Some(err) => Err(err),
        None => Ok(report),
    }
}

/// What the tab shows besides Synced: nothing if all succeeded, or what was left out.
pub fn status_note(report: &Report) -> Option<String> {
    let mut notes = Vec::new();
    if report.transcripts_denied {
        notes.push(
            "Resumos sincronizados, mas o servidor ainda não permite que o app leia transcrições \
             (precisa do contrato 2.8.0): atualize o servidor"
                .to_string(),
        );
    }
    if report.failed > 0 {
        notes.push(format!(
            "{} gravações não puderam ser lidas; nova tentativa no próximo ciclo",
            report.failed
        ));
    }
    (!notes.is_empty()).then(|| notes.join(" · "))
}

/// The channel for nudging the loop; the message says whether to sweep the entire library.
pub struct MirrorHandle(Mutex<Sender<bool>>);

/// Start the synced folder thread and register the channel in the app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<bool>();
    app.manage(MirrorHandle(Mutex::new(tx)));
    let app = app.clone();
    let mut backoff = crate::supervise::Backoff::default();
    let spawned = std::thread::Builder::new()
        .name("eclume-mirror".into())
        .spawn(move || loop {
            let forced = match rx.recv_timeout(INTERVAL) {
                Ok(sweep) => sweep,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            // Several consecutive nudges count as a single cycle.
            let forced = forced | rx.try_iter().any(|sweep| sweep);
            let due = now_ms() - LAST_SWEEP.load(Ordering::Relaxed) >= SWEEP_EVERY_MS;
            crate::supervise::pass(&mut backoff, "synced folder", || {
                if let Err(err) = tick(&app, forced || due) {
                    log::error!("synced folder failed: {err:#}");
                }
            });
            crate::refresh_ui(&app);
        });
    if let Err(err) = spawned {
        log::error!("failed to start synced folder: {err}");
    }
}

/// Request a cycle now (`sweep`: also check the entire library).
pub fn nudge(app: &AppHandle, sweep: bool) {
    if let Some(handle) = app.try_state::<MirrorHandle>() {
        if let Ok(tx) = handle.0.lock() {
            let _ = tx.send(sweep);
        }
    }
}

fn tick(app: &AppHandle, sweep: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let config = state.mirror_config()?;
    if !config.enabled {
        return Ok(());
    }
    let dir = config
        .dir
        .clone()
        .ok_or_else(|| anyhow!("pasta dos resumos não escolhida"))?;
    let Some(uploader) = state.uploader_config()? else {
        state.update_mirror(|status| {
            status.running = false;
            status.last_error = Some("Entre na conta para sincronizar a pasta".into());
        })?;
        return Ok(());
    };
    let running = state.mirror_running();
    crate::refresh_ui(app);
    let result = Client::from_config(&uploader).and_then(|client| {
        let mut mirror = Mirror::open(&dir)?;
        let source = SharedSource {
            config: &uploader,
            client: &client,
        };
        sync_library(&source, &mut mirror, config.transcripts, sweep)
    });
    drop(running);
    if result.is_ok() && sweep {
        LAST_SWEEP.store(now_ms(), Ordering::Relaxed);
    }
    state.update_mirror(|status| match &result {
        Ok(report) => {
            status.last_sync_ms = Some(now_ms());
            status.last_error = status_note(report);
            status.last = Some(*report);
        }
        Err(err) => status.last_error = Some(format!("{err:#}")),
    })?;
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    #[derive(Default)]
    struct Fake {
        collections: Vec<CollectionInfo>,
        recordings: RefCell<Vec<LibraryRecording>>,
        summaries: RefCell<BTreeMap<String, LibrarySummary>>,
        transcripts: RefCell<BTreeMap<String, api::Transcript>>,
        broken_transcript: RefCell<Vec<String>>,
        /// The server refuses `transcripts:read` (403 `insufficient_scope`).
        denied_transcripts: RefCell<bool>,
        transcript_calls: RefCell<usize>,
        markers: RefCell<BTreeMap<String, Vec<api::Marker>>>,
        /// Time zone of the test “computer”, in hours west of UTC (0 = UTC).
        west_hours: RefCell<i32>,
        calls: RefCell<Vec<String>>,
    }

    impl Source for Fake {
        fn collections(&self) -> Result<Vec<CollectionInfo>> {
            Ok(self.collections.clone())
        }
        fn library(&self, since: Option<&str>) -> Result<Vec<LibraryRecording>> {
            self.calls
                .borrow_mut()
                .push(format!("library since={since:?}"));
            Ok(self
                .recordings
                .borrow()
                .iter()
                .filter(|r| since.is_none_or(|s| r.updated_at.as_deref() >= Some(s)))
                .cloned()
                .collect())
        }
        fn recording(&self, id: &str) -> Result<Option<LibraryRecording>> {
            self.calls.borrow_mut().push(format!("recording {id}"));
            Ok(self
                .recordings
                .borrow()
                .iter()
                .find(|r| r.id == id)
                .cloned())
        }
        fn current_summary(&self, id: &str) -> Result<Option<LibrarySummary>> {
            Ok(self.summaries.borrow().get(id).cloned())
        }
        fn local_start(&self, recorded_at: &str) -> Option<String> {
            api::start_at_offset(recorded_at, -*self.west_hours.borrow() * 3600)
        }
        fn markers(&self, id: &str) -> Result<Vec<api::Marker>> {
            Ok(self.markers.borrow().get(id).cloned().unwrap_or_default())
        }
        fn transcript(&self, id: &str) -> Result<Option<api::Transcript>> {
            *self.transcript_calls.borrow_mut() += 1;
            if *self.denied_transcripts.borrow() {
                return Err(anyhow::Error::new(eclume_sync::MissingScope::new(
                    "403 (insufficient_scope)",
                )));
            }
            if self.broken_transcript.borrow().iter().any(|b| b == id) {
                return Err(anyhow!("500"));
            }
            Ok(self.transcripts.borrow().get(id).cloned())
        }
    }

    fn recording(
        id: &str,
        colecoes: &[&str],
        atualizado: &str,
        com_transcricao: bool,
    ) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: "done".into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            created_at: None,
            updated_at: Some(atualizado.into()),
            collection_ids: colecoes.iter().map(|c| c.to_string()).collect(),
            transcript_id: com_transcricao.then(|| format!("t-{id}")),
            agenda_type: None,
            pipeline: vec![],
            job: None,
        }
    }

    fn summary(version: u64) -> LibrarySummary {
        LibrarySummary {
            version,
            agenda_type: Some("Reunião de equipe".into()),
            content_md: format!("# Ata v{version}"),
            transcript_revision: Some(1),
        }
    }

    fn transcript(id: &str) -> api::Transcript {
        api::Transcript {
            id: format!("t-{id}"),
            recording_id: id.into(),
            title: String::new(),
            language: Some("pt".into()),
            recorded_at: None,
            duration_ms: Some(1000),
            revision: 1,
            speakers: vec![api::TranscriptSpeaker {
                id: "S1".into(),
                label: "Ana".into(),
            }],
            segments: vec![api::TranscriptSegment {
                speaker_id: Some("S1".into()),
                start_ms: 0,
                end_ms: 900,
                text: "oi".into(),
            }],
        }
    }

    fn fake() -> Fake {
        let fake = Fake {
            collections: vec![
                CollectionInfo {
                    id: "c1".into(),
                    name: "Clientes".into(),
                },
                CollectionInfo {
                    id: "c2".into(),
                    name: "Interno".into(),
                },
            ],
            ..Fake::default()
        };
        *fake.recordings.borrow_mut() = vec![
            recording("aaaaaaaa-1", &["c1", "c2"], "2026-09-19T10:00:00Z", true),
            recording("bbbbbbbb-2", &[], "2026-09-19T11:00:00Z", true),
            recording("cccccccc-3", &["c1"], "2026-09-19T12:00:00Z", false),
        ];
        for id in ["aaaaaaaa-1", "bbbbbbbb-2"] {
            fake.summaries.borrow_mut().insert(id.into(), summary(1));
            fake.transcripts
                .borrow_mut()
                .insert(id.into(), transcript(id));
        }
        fake
    }

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("eclume-mirror-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn listed(root: &std::path::Path) -> Vec<String> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.retain(|name| !name.starts_with('.') && name != "AGENTS.md");
        out.sort();
        out
    }

    #[test]
    fn first_pass_mirrors_library_and_second_does_not_rewrite() {
        let dir = tmp("primeira");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        let first = sync_library(&fake, &mut mirror, true, false).unwrap();
        // aaaaaaaa: md and jsonl in both collections (4); bbbbbbbb: sem-colecao (2);
        // cccccccc: no transcript, nothing to write.
        assert_eq!((first.recordings, first.written, first.failed), (3, 6, 0));
        assert_eq!(
            listed(&dir),
            [
                "Clientes/2026-09/2026-09-18_1400_aaaaaaaa.jsonl",
                "Clientes/2026-09/2026-09-18_1400_aaaaaaaa.md",
                "Interno/2026-09/2026-09-18_1400_aaaaaaaa.jsonl",
                "Interno/2026-09/2026-09-18_1400_aaaaaaaa.md",
                "sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.jsonl",
                "sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md",
            ]
        );
        assert!(dir.join("AGENTS.md").exists());
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));

        // The second cycle reads from the cursor (inclusive: only the last) and rewrites nothing.
        let second = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((second.recordings, second.written), (1, 0));
        assert_eq!(
            fake.calls.borrow().last().unwrap(),
            "library since=Some(\"2026-09-19T11:58:00Z\")"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn regenerated_summary_arrives_via_since_and_rewrites_only_md() {
        let dir = tmp("refeito");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        // The server moves `updated_at` when the summary changes (contract 2.8.0).
        fake.summaries
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), summary(2));
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // The cursor is inclusive: the last recording returns again, with nothing to write.
        assert_eq!(
            (report.recordings, report.written, report.unchanged),
            (2, 1, 1)
        );
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md"))
                .unwrap();
        assert!(md.contains("summary_version: 2") && md.contains("# Ata v2"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn summary_from_earlier_transcript_revision_is_flagged_in_md() {
        let dir = tmp("desatualizado");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        let path = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md");
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("summary_stale"));
        // The summary was based on revision 0 and the transcript is already at 1.
        let mut old_summary = summary(2);
        old_summary.transcript_revision = Some(0);
        fake.summaries
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), old_summary);
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        sync_library(&fake, &mut mirror, true, false).unwrap();
        let md = std::fs::read_to_string(&path).unwrap();
        assert!(md.contains("summary_stale: true\n"));
        assert!(md.contains("> [!warning] Resumo de uma versão anterior da transcrição"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn marker_note_is_included_in_md_and_edit_rewrites_only_md() {
        let dir = tmp("notas");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        let note = |at_ms, text: &str| api::Marker {
            at_ms,
            note: Some(text.into()),
        };
        fake.markers.borrow_mut().insert(
            "bbbbbbbb-2".into(),
            vec![
                note(61_000, "decisão: aprovar"),
                api::Marker {
                    at_ms: 90_000,
                    note: None,
                },
            ],
        );
        sync_library(&fake, &mut mirror, true, false).unwrap();
        let path = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md");
        let md = std::fs::read_to_string(&path).unwrap();
        assert!(md.ends_with("## Notas dos marcadores\n\n- [00:01:01] decisão: aprovar\n"));
        // The edited note moves the recording’s `updated_at` (server) and the `.md` is rewritten.
        fake.markers
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), vec![note(61_000, "decisão: adiar")]);
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(report.written, 1);
        let md = std::fs::read_to_string(&path).unwrap();
        assert!(md.contains("decisão: adiar") && !md.contains("aprovar"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sweep_removes_server_deletions_but_incremental_does_not() {
        let dir = tmp("varredura");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        fake.recordings.borrow_mut().remove(1);

        let incremental = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(incremental.removed, 0);
        assert!(dir.join("sem-colecao").is_dir());

        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!(sweep.removed, 2);
        assert!(!dir.join("sem-colecao").exists());
        assert!(dir.join("Clientes").is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sweep_fetches_recordings_missing_from_manifest() {
        let dir = tmp("faltante");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        // An old recording (before the cursor) that the manifest has never seen.
        let mut old_recording = recording("dddddddd-4", &["c2"], "2026-09-01T00:00:00Z", true);
        old_recording.title = "Antiga".into();
        fake.summaries
            .borrow_mut()
            .insert("dddddddd-4".into(), summary(1));
        fake.transcripts
            .borrow_mut()
            .insert("dddddddd-4".into(), transcript("dddddddd-4"));
        fake.recordings.borrow_mut().push(old_recording);
        assert_eq!(
            sync_library(&fake, &mut mirror, true, false)
                .unwrap()
                .written,
            0
        );
        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!(sweep.written, 2);
        assert!(dir
            .join("Interno/2026-09/2026-09-18_1400_dddddddd.md")
            .exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_recording_stays_pending_without_full_library_reread() {
        let dir = tmp("falha");
        let fake = fake();
        fake.broken_transcript
            .borrow_mut()
            .push("aaaaaaaa-1".into());
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((report.failed, report.written), (1, 2));
        // The cursor advances and the failed item stays pending: retry it, rather than everything.
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));
        assert!(mirror.pending().contains("aaaaaaaa-1"));
        assert!(status_note(&report).unwrap().contains("1 gravações"));

        // Still broken: another cycle retries only the pending item, without rereading the library.
        fake.calls.borrow_mut().clear();
        let still = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((still.failed, still.recordings), (1, 2));
        assert_eq!(
            fake.calls.borrow().first().unwrap(),
            "library since=Some(\"2026-09-19T11:58:00Z\")"
        );
        // The pending item returns by id, never through the full listing.
        assert!(fake
            .calls
            .borrow()
            .contains(&"recording aaaaaaaa-1".to_string()));
        assert!(!fake
            .calls
            .borrow()
            .iter()
            .any(|call| call == "library since=None"));

        // Fixed: the pending item is added and the queue empties.
        fake.broken_transcript.borrow_mut().clear();
        let again = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((again.failed, again.written), (0, 4));
        assert!(mirror.pending().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn toggling_transcripts_rebuilds_folder_in_both_directions() {
        let dir = tmp("liga-desliga");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );

        // Disabled: even without server changes, remove `.jsonl` files and their `.md` links.
        sync_library(&fake, &mut mirror, false, false).unwrap();
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md"))
                .unwrap();
        assert!(!md.contains("transcript:"));
        assert!(!std::fs::read_to_string(dir.join("AGENTS.md"))
            .unwrap()
            .contains("jsonl"));

        // Enabled again: restore them immediately, without waiting for the 6 h sweep.
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn collections_differing_only_in_case_use_one_spelling() {
        let names = collection_names(vec![
            CollectionInfo {
                id: "2".into(),
                name: "clientes".into(),
            },
            CollectionInfo {
                id: "1".into(),
                name: "Clientes".into(),
            },
            CollectionInfo {
                id: "3".into(),
                name: "Interno".into(),
            },
        ]);
        assert_eq!(names["1"], "Clientes");
        assert_eq!(names["2"], "Clientes");
        assert_eq!(names["3"], "Interno");
    }

    #[test]
    fn existing_jsonl_is_preserved_without_scope() {
        let dir = tmp("escopo-preserva");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        let jsonl = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.jsonl");
        assert!(jsonl.exists());

        // The summary changes, but the server starts refusing transcripts: keep the `.jsonl` and
        // do not rewrite the `.md` (with its link) without a transcript.
        *fake.denied_transcripts.borrow_mut() = true;
        fake.summaries
            .borrow_mut()
            .insert("bbbbbbbb-2".into(), summary(2));
        fake.recordings.borrow_mut()[1].updated_at = Some("2026-09-20T09:00:00Z".into());
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert!(report.transcripts_denied);
        assert!(jsonl.exists());
        let md = std::fs::read_to_string(jsonl.with_extension("md")).unwrap();
        assert!(md.contains("transcript:") && md.contains("summary_version: 1"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manifest_is_saved_even_when_agents_md_is_locked() {
        let dir = tmp("agents-travado");
        let fake = fake();
        // A folder in place of the file: writing `AGENTS.md` fails every cycle.
        std::fs::create_dir_all(dir.join("AGENTS.md")).unwrap();
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(report.failed, 0);
        let reopened = Mirror::open(&dir).unwrap();
        assert_eq!(reopened.known_ids().len(), 2);
        assert!(reopened.since().is_some());
        // The next cycle is incremental: the `AGENTS.md` error does not force a full reread.
        assert!(!reopened.needs_rebuild(true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn server_without_transcript_scope_syncs_summaries_without_repeated_requests() {
        let dir = tmp("sem-escopo");
        let fake = fake();
        *fake.denied_transcripts.borrow_mut() = true;
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // Write summaries for aaaaaaaa (2 collections) and bbbbbbbb (1); no `.jsonl`; no failures.
        assert_eq!(
            (report.written, report.failed, report.transcripts_denied),
            (3, 0, true)
        );
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        // The first refusal applies to the whole cycle: one call, rather than one per recording.
        assert_eq!(*fake.transcript_calls.borrow(), 1);
        // The cursor advances (no full reread every minute) and the tab explains what is missing.
        assert_eq!(mirror.since(), Some("2026-09-19T11:58:00Z"));
        let note = status_note(&report).unwrap();
        assert!(note.contains("transcrições") && note.contains("contrato 2.8.0"));
        assert!(!note.contains("não puderam ser lidas"));

        // The server is updated: the sweep fills in the missing transcripts.
        *fake.denied_transcripts.borrow_mut() = false;
        let incremental = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!(incremental.written, 0);
        let sweep = sync_library(&fake, &mut mirror, true, true).unwrap();
        assert_eq!((sweep.transcripts_denied, sweep.failed), (false, 0));
        // Three missing `.jsonl` files, and three `.md` files gaining the `transcript` property.
        assert_eq!(sweep.written, 6);
        assert_eq!(
            listed(&dir)
                .iter()
                .filter(|f| f.ends_with(".jsonl"))
                .count(),
            3
        );
        assert_eq!(status_note(&sweep), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tab_note_combines_denial_and_failures() {
        assert_eq!(status_note(&Report::default()), None);
        let only_failures = Report {
            failed: 2,
            ..Report::default()
        };
        assert!(status_note(&only_failures)
            .unwrap()
            .starts_with("2 gravações não puderam"));
        let both = Report {
            failed: 1,
            transcripts_denied: true,
            ..Report::default()
        };
        let note = status_note(&both).unwrap();
        assert!(note.contains("contrato 2.8.0") && note.contains(" · 1 gravações"));
    }

    #[test]
    fn folder_and_name_follow_computer_local_time() {
        let dir = tmp("hora-local");
        let fake = fake();
        *fake.west_hours.borrow_mut() = 3;
        // 02:30 UTC on October 1 is 23:30 on September 30 on the computer (UTC-3).
        fake.recordings.borrow_mut()[1].recorded_at = Some("2026-10-01T02:30:00Z".into());
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();
        assert!(dir
            .join("sem-colecao/2026-09/2026-09-30_2330_bbbbbbbb.md")
            .exists());
        assert!(dir
            .join("Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md")
            .exists());
        // The front matter’s `recorded_at` stays in UTC.
        let md =
            std::fs::read_to_string(dir.join("sem-colecao/2026-09/2026-09-30_2330_bbbbbbbb.md"))
                .unwrap();
        assert!(md.contains("recorded_at: \"2026-10-01T02:30:00Z\""));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn previously_synced_old_layout_is_migrated_without_duplicates() {
        let dir = tmp("migracao");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        sync_library(&fake, &mut mirror, true, false).unwrap();

        // Revert the folder to the old layout: title in the file name, directly in the collection,
        // and no layout version in the manifest.
        let new_path = dir.join("sem-colecao/2026-09/2026-09-18_1400_bbbbbbbb.md");
        let old_relative = "sem-colecao/2026-09-18 Reunião bbbbbbbb-2 - bbbbbbbb.md";
        std::fs::rename(&new_path, dir.join(old_relative)).unwrap();
        let manifest = dir.join(".eclume-sync.json");
        let mut json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("layout");
        json["recordings"]["bbbbbbbb-2"]["files"] = serde_json::json!([old_relative]);
        std::fs::write(&manifest, serde_json::to_vec(&json).unwrap()).unwrap();

        let mut mirror = Mirror::open(&dir).unwrap();
        assert!(mirror.needs_rebuild(true));
        let report = sync_library(&fake, &mut mirror, true, false).unwrap();
        // Everything was reread (not just changes since the cursor) and the old file is gone.
        assert_eq!(report.recordings, 3);
        assert!(!dir.join(old_relative).exists());
        assert!(new_path.exists());
        assert!(!mirror.needs_rebuild(true));
        // The next cycle is incremental again.
        let next = sync_library(&fake, &mut mirror, true, false).unwrap();
        assert_eq!((next.recordings, next.written), (1, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_transcripts_only_markdown_and_agents_change() {
        let dir = tmp("sem-jsonl");
        let fake = fake();
        let mut mirror = Mirror::open(&dir).unwrap();
        let report = sync_library(&fake, &mut mirror, false, false).unwrap();
        assert_eq!(report.written, 3);
        assert!(listed(&dir).iter().all(|f| f.ends_with(".md")));
        let agents = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(!agents.contains("jsonl"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unknown_collection_is_ignored_and_title_falls_back_to_transcript() {
        let mut rec = recording("eeeeeeee-5", &["c1", "sumiu"], "2026-09-19T10:00:00Z", true);
        rec.title = "  ".into();
        let names = HashMap::from([("c1".to_string(), "Clientes".to_string())]);
        let mut t = transcript("eeeeeeee-5");
        t.title = "Título da transcrição".into();
        let item = to_item(&rec, None, &names, Some(summary(1)), Some(t), Vec::new());
        assert_eq!(item.collections, ["Clientes"]);
        assert_eq!(item.title, "Título da transcrição");
        assert_eq!(item.agenda_type.as_deref(), Some("Reunião de equipe"));
    }
}
