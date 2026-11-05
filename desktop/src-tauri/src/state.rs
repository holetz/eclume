//! App state: the current recording (and who started it), the queue, configuration, account
//! (device credential or legacy PAT), and meeting detection.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use eclume_detect::{default_policy, Action, AppKey, AutoRecorder, Policy, Recording};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig, StartOptions, StopReason};
use eclume_recorder::{AudioSource, Mixer, SilenceDetector, SourceState};
use eclume_recorder::{
    Kind, Marker, MeetingEvent, NewImport, Queue, QueueCounts, QueuedRecording, RecordedAtSource,
    METER_BARS,
};
use eclume_sync::transport::TrustMode;
use eclume_sync::{Client, PatSource, PatStore, QueueWait, RetryPolicy, UploaderConfig};
use serde::{Deserialize, Serialize};

use crate::account::{self, Login, Net, PreparedServer, SignedIn};
use crate::capture::{AudioChoice, OpenedSources};
use crate::config::{self, Account, Config, Connection, PendingUpdate};
use crate::i18n::{self, Locale};
use crate::shortcuts::{Registration, Registrations, ShortcutAction, ShortcutMode, Shortcuts};

/// Version of this build.
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Version sent in `capture.client_version` and `User-Agent`.
pub const CLIENT_VERSION: &str = concat!("eclume-desktop/", env!("CARGO_PKG_VERSION"));

/// What the tray shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppStatus {
    Idle,
    Recording,
    /// Uploading recordings to the server.
    Syncing,
}

impl AppStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "Ocioso",
            Self::Recording => "Gravando",
            Self::Syncing => "Sincronizando",
        }
    }
}

/// Request to record while another recording is in progress.
#[derive(Debug)]
pub struct Busy;

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Já há uma gravação em andamento")
    }
}

impl std::error::Error for Busy {}

/// What "New voice note" did.
#[derive(Debug)]
pub enum NoteToggle {
    Started,
    /// Stopped the current voice note, which was queued.
    Stopped(Box<QueuedRecording>),
}

/// How long the microphone can be unavailable before the notice: Bluetooth profile switching
/// usually takes 1 to 3 s.
const MIC_LOST_AFTER: Duration = Duration::from_secs(5);
/// Window notice while the microphone is unavailable.
const MIC_LOST_NOTICE: &str = "gravando sem microfone: tentando reconectar";

/// Microphone transition in the current recording, observed by [`AppState::watch_sources`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MicChange {
    /// Unavailable for longer than [`MIC_LOST_AFTER`].
    Lost,
    /// Back after a [`MicChange::Lost`].
    Back,
}

/// Recording that ended on its own and was closed by the reaper.
#[derive(Debug)]
pub enum Reaped {
    /// Recording stopped on its own: audio sources disconnected ([`StopReason::SourcesEnded`]) or
    /// the recording failed ([`StopReason::Failed`]).
    Stopped {
        recording: QueuedRecording,
        reason: StopReason,
    },
    /// Voice note stopped on silence and was queued.
    NoteSaved(QueuedRecording),
    /// Voice note had no speech: removed from the queue and disk.
    NoteDiscarded,
}

/// Meter for the current voice note, for the window.
#[derive(Clone, Debug, Serialize)]
pub struct NoteMeter {
    pub position_ms: i64,
    /// Latest levels, from 0 to 1, oldest to newest.
    pub levels: [f32; METER_BARS],
    /// Remaining silence before stopping, while the person is quiet.
    pub stops_in_ms: Option<u64>,
}

/// Who started the current recording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Origin {
    /// Started by detection (`auto` policy or answer to the prompt).
    pub auto: bool,
    /// Meeting app, when started by detection.
    pub app: Option<AppKey>,
}

impl Origin {
    pub const MANUAL: Self = Self {
        auto: false,
        app: None,
    };

    pub fn detected(app: AppKey) -> Self {
        Self {
            auto: true,
            app: Some(app),
        }
    }
}

/// Meeting app as shown in the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MeetingView {
    pub app: AppKey,
    pub label: &'static str,
}

impl From<AppKey> for MeetingView {
    fn from(app: AppKey) -> Self {
        Self {
            app,
            label: app.label(),
        }
    }
}

/// State snapshot consumed by the UI and tray.
#[derive(Clone, Debug, Serialize)]
pub struct StatusView {
    pub locale: Locale,
    pub locale_choice: Option<String>,
    pub status: AppStatus,
    pub recording_id: Option<String>,
    pub recording_started_at: Option<i64>,
    /// Meeting or voice note, for the current recording.
    pub recording_kind: Option<Kind>,
    /// Silence that ends a voice note, in seconds; `None` means "Never".
    pub note_silence_s: Option<u32>,
    /// `system`, `light` or `dark`: the window applies it without opening settings.
    pub theme: String,
    /// Current recording was started by detection.
    pub recording_auto: bool,
    /// Meeting app for the current recording.
    pub recording_app: Option<MeetingView>,
    /// Meeting detected now (after debounce).
    pub meeting: Option<MeetingView>,
    /// "Record this meeting?" prompt awaiting an answer.
    pub pending_ask: Option<MeetingView>,
    /// Markers for the current recording.
    pub marker_count: u32,
    /// Last marker in the current recording, whose note the window allows editing.
    pub last_marker: Option<Marker>,
    pub counts: QueueCounts,
    pub web_url: String,
    /// Notice from the last action (missing source, recording error).
    pub notice: Option<String>,
    /// What blocks sync (missing PAT) or its last error.
    pub sync_notice: Option<String>,
    /// Why transcription is waiting on the server, by remote id, for recordings uploaded less
    /// than 24 h ago whose job is queued (`Job.queue`).
    pub queue_waits: BTreeMap<String, QueueWait>,
    /// "Updated to X", until the person dismisses the notice.
    pub updated: Option<PendingUpdate>,
    /// First run, legacy PAT, or account.
    pub connection: Connection,
    pub account: Option<Account>,
    /// Microphone in the current recording has been unavailable for over 5 s (reconnecting).
    pub mic_lost: bool,
}

/// "Test connection": who the server recognizes and when the last upload occurred.
#[derive(Clone, Debug, Serialize)]
pub struct ConnectionTest {
    pub email: String,
    /// When the server confirmed the last recording from this computer (ms since the epoch).
    pub last_upload_at: Option<i64>,
}

/// App policy as shown in settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AppPolicyView {
    pub app: AppKey,
    pub label: &'static str,
    pub policy: Policy,
    /// Factory policy, for "Restore defaults".
    pub default_policy: Policy,
}

/// Recordings still stored on this computer, for the Storage tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageInfo {
    pub dir: PathBuf,
    pub recordings: u32,
    pub bytes: u64,
}

/// Global shortcut as shown in the Audio tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShortcutView {
    pub action: ShortcutAction,
    pub label: &'static str,
    pub keys: String,
    /// `None` before the first registration (the app registers on open).
    pub registration: Option<Registration>,
    /// "In use by another app" or "Unavailable in this session".
    pub problem: Option<&'static str>,
}

/// What settings shows. The PAT never returns to the window: only its source does.
#[derive(Clone, Debug, Serialize)]
pub struct SettingsView {
    pub web_url: String,
    pub api_url: Option<String>,
    pub ca_path: Option<PathBuf>,
    pub detection_enabled: bool,
    pub apps: Vec<AppPolicyView>,
    pub retention_days: Option<u32>,
    pub pat_source: Option<PatSource>,
    pub connection: Connection,
    pub account: Option<Account>,
    pub shortcuts: Vec<ShortcutView>,
    /// Global, portal, or system (with CLI commands).
    pub shortcut_mode: ShortcutMode,
    /// Selected microphone; `None` means system default and `"none"` means none.
    pub mic: Option<String>,
    /// `"follow"`, an output id, or `"none"`.
    pub system_source: String,
    /// Transcription language; `None` means server default.
    pub language: Option<String>,
    /// `system`, `light` or `dark`.
    pub theme: String,
    /// Notify when the automatic summary is ready.
    pub notify_summary: bool,
    /// Start with the computer.
    pub autostart: bool,
    /// Number of recent recordings in the top panel; `0` hides it.
    pub recent_count: u8,
    /// Number of recent recordings in the tray menu; `0` hides the section.
    pub tray_recent_count: u8,
    /// Synced folder is enabled.
    pub mirror_enabled: bool,
    /// Synced folder root; `None` until the person chooses one.
    pub mirror_dir: Option<PathBuf>,
    /// Also mirror transcripts.
    pub mirror_transcripts: bool,
    /// Silence that ends a voice note, in seconds; `None` means "Never".
    pub note_silence_s: Option<u32>,
}

/// What settings sends on save.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SettingsInput {
    pub web_url: String,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub ca_path: Option<String>,
    pub detection_enabled: bool,
    #[serde(default)]
    pub policies: BTreeMap<AppKey, Policy>,
    pub retention_days: Option<u32>,
    /// New PAT; empty or missing keeps the stored one.
    #[serde(default)]
    pub pat: Option<String>,
    /// Forget the stored PAT.
    #[serde(default)]
    pub clear_pat: bool,
    /// New shortcuts; missing keeps the current ones.
    #[serde(default)]
    pub shortcuts: Option<Shortcuts>,
    /// Microphone by name, `""` for system default and `"none"` for none; missing keeps the
    /// current one.
    #[serde(default)]
    pub mic: Option<String>,
    /// `"follow"` (or `""`), an output id, or `"none"`; missing keeps the current one.
    #[serde(default)]
    pub system_source: Option<String>,
    /// `pt`, `es`, `en`, or `""` for server default; missing keeps the current one.
    #[serde(default)]
    pub language: Option<String>,
    /// `system`, `light` or `dark`; missing keeps the current one.
    #[serde(default)]
    pub theme: Option<String>,
    /// Missing keeps the current value.
    #[serde(default)]
    pub notify_summary: Option<bool>,
    /// Start with the computer; missing keeps the current value.
    #[serde(default)]
    pub autostart: Option<bool>,
    /// Recent recordings at the top (0 to 10); missing keeps the current value.
    #[serde(default)]
    pub recent_count: Option<u8>,
    /// Recent recordings in the tray menu (0 to 10); missing keeps the current value.
    #[serde(default)]
    pub tray_recent_count: Option<u8>,
    /// Enable or disable the synced folder; missing keeps the current value.
    #[serde(default)]
    pub mirror_enabled: Option<bool>,
    /// Synced folder root, `""` to clear; missing keeps the current one.
    #[serde(default)]
    pub mirror_dir: Option<String>,
    /// Mirror transcripts; missing keeps the current value.
    #[serde(default)]
    pub mirror_transcripts: Option<bool>,
    /// Voice note silence stop in seconds, `0` for "Never"; missing keeps the current value.
    #[serde(default)]
    pub note_silence_s: Option<u32>,
}

/// Synced folder status, for the window tab.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MirrorStatus {
    /// A cycle is running.
    pub running: bool,
    /// When the last cycle succeeded (ms since the epoch); `None` before the first.
    pub last_sync_ms: Option<i64>,
    /// What went wrong in the last cycle, in words.
    pub last_error: Option<String>,
    /// What the last cycle did.
    pub last: Option<crate::mirror_sync::Report>,
}

/// Maximum duration of a source level test.
pub const SOURCE_TEST: Duration = Duration::from_secs(10);

/// Current level test: the meter, without recording. `running` turns off when the test ends
/// or when the window requests a stop.
struct SourceTest {
    levels: Arc<Mutex<[f32; METER_BARS]>>,
    running: Arc<AtomicBool>,
}

/// Recording being stopped (join, driver teardown, and `fsync`, outside the lock).
struct Stopping {
    id: String,
    started_at: i64,
    kind: Kind,
}

struct Inner {
    active: Option<ActiveRecording>,
    /// Recording removed from `active` and still closing: visible state remains "Recording",
    /// starting or stopping again is [`Busy`], and the orphan sweep counts it as live.
    stopping: Option<Stopping>,
    /// Microphone in the current recording has been unavailable for longer than [`MIC_LOST_AFTER`].
    mic_lost: bool,
    /// Who started `active`.
    origin: Option<Origin>,
    /// A start is in progress (opening devices), outside the lock.
    starting: bool,
    syncing: bool,
    config: Config,
    auto: AutoRecorder,
    notice: Option<String>,
    sync_notice: Option<String>,
    queue_waits: BTreeMap<String, QueueWait>,
    /// Synced folder: current cycle and last result.
    mirror: MirrorStatus,
    /// Registration result for each global shortcut.
    shortcut_registrations: Registrations,
    /// How shortcuts reach the app in this session.
    shortcut_mode: ShortcutMode,
    /// Cancellation request for the current import, if any.
    importing: Option<Arc<AtomicBool>>,
    source_test: Option<SourceTest>,
    /// Update to notify on this open (sent once).
    update_to_notify: Option<PendingUpdate>,
    /// Where the credential (PAT or device) is stored, if any; read on open and updated on
    /// sign-in, sign-out, and save, so the 1 s poll and Settings avoid the keyring.
    token_source: Option<PatSource>,
    /// Server selected on first run, waiting for the person to sign in.
    prepared: Option<PreparedServer>,
    /// Server CA no longer matches the pinned one: sync stops and the window returns to first run.
    ca_changed: bool,
}

impl Inner {
    /// Id, start, and kind of the current recording, including while it stops.
    fn current(&self) -> Option<(&str, i64, Kind)> {
        match (&self.active, &self.stopping) {
            (Some(active), _) => Some((active.id(), active.started_at(), active.kind())),
            (None, Some(stopping)) => Some((&stopping.id, stopping.started_at, stopping.kind)),
            (None, None) => None,
        }
    }

    fn recording(&self) -> Recording {
        match self.origin {
            None => Recording::Idle,
            Some(origin) if origin.auto => Recording::Auto,
            Some(_) => Recording::Manual,
        }
    }
}

pub struct AppState {
    queue: Arc<Mutex<Queue>>,
    recorder: RecorderConfig,
    config_path: PathBuf,
    pat: PatStore,
    inner: Mutex<Inner>,
}

/// Reads the source for up to `duration`, or until `running` turns off, publishing to `levels`.
fn run_source_test(
    open: impl FnOnce() -> Result<Box<dyn AudioSource>>,
    duration: Duration,
    levels: &Mutex<[f32; METER_BARS]>,
    running: &AtomicBool,
) -> Result<()> {
    let mut source = open()?;
    let mut mixer = Mixer::new(&[source.sample_rate()])?;
    let mut detector = SilenceDetector::new(None);
    let deadline = std::time::Instant::now() + duration;
    while running.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
        let Some(samples) = source.read(Duration::from_millis(50)) else {
            break;
        };
        mixer.push(0, &samples, source.sample_rate())?;
        detector.push(&mixer.pop_ready());
        if let Ok(mut shown) = levels.lock() {
            *shown = detector.meter();
        }
    }
    Ok(())
}

/// Imported file id: import time and a suffix, like recording ids.
fn import_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}-i{:04x}",
        now.as_millis(),
        (now.subsec_nanos() ^ std::process::id()) & 0xffff
    )
}

/// Empty text (or only whitespace) becomes `None`.
fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// An "in progress" flag (`syncing`, `mirror.running`, `importing`): set when creating the guard
/// and cleared on `Drop`, which acquires state even if poisoned. Only guards set these flags.
pub struct FlagGuard<'a> {
    state: &'a AppState,
    set: fn(&mut Inner, bool),
}

impl<'a> FlagGuard<'a> {
    fn raise(state: &'a AppState, set: fn(&mut Inner, bool)) -> Self {
        set(
            &mut recover_poison(state.inner.lock(), "application state"),
            true,
        );
        Self { state, set }
    }
}

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        (self.set)(
            &mut recover_poison(self.state.inner.lock(), "application state"),
            false,
        );
    }
}

/// A lock poisoned by a panic remains usable: poisoning is logged.
fn recover_poison<'a, T>(
    lock: std::sync::LockResult<MutexGuard<'a, T>>,
    what: &str,
) -> MutexGuard<'a, T> {
    lock.unwrap_or_else(|poisoned| {
        log::error!("{what} poisoned by a panic; continuing with the last value");
        poisoned.into_inner()
    })
}

impl AppState {
    /// Opens the queue in `data_dir`, recovers interrupted recordings, and reads config and PAT
    /// from `config_dir`. A stuck `.part` does not prevent opening: its row remains for the sweep.
    /// Config is only saved when the opened version changes; if unreadable, it is saved alongside
    /// and the window notifies the person.
    pub fn open(data_dir: &Path, config_dir: &Path) -> Result<Self> {
        Self::open_with(data_dir, config_dir, PatStore::new(config_dir))
    }

    /// [`Self::open`] with the given PAT store (tests pass one without the OS keyring). A pinned
    /// CA with extra certificates is rewritten with just one ([`account::repair_pinned`]); the
    /// stored credential may have passed through an interceptor, so it is deleted and the window
    /// asks the person to sign in again.
    fn open_with(data_dir: &Path, config_dir: &Path, pat: PatStore) -> Result<Self> {
        let queue = Queue::open(&data_dir.join("queue.sqlite"))?;
        let recovered = session::recover(&queue)?;
        let config_path = config_dir.join("config.json");
        let (mut config, unreadable) = Config::load_checked(&config_path);
        let previous_version = config.last_version.clone();
        let just_updated = config.open_version(CURRENT_VERSION);
        if config.last_version != previous_version {
            if let Err(err) = config.save(&config_path) {
                log::warn!("failed to record opened version: {err:#}");
            }
        }
        let ca_trimmed = account::repair_pinned(config_dir, &config).unwrap_or_else(|err| {
            log::warn!("failed to check pinned CA: {err:#}");
            false
        });
        if ca_trimmed {
            log::warn!("{}", eclume_sync::pin::CA_TRIMMED);
            if let Err(err) = pat.clear() {
                log::warn!("failed to delete credential: {err:#}");
            }
            config.account = None;
            if let Err(err) = config.save(&config_path) {
                log::warn!("failed to save config without account: {err:#}");
            }
        }
        let state = Self::new(
            queue,
            RecorderConfig::new(data_dir.join("gravacoes")),
            config_path,
            config,
            pat,
        );
        let mut notices = Vec::new();
        if let Some(copy) = unreadable {
            notices.push(format!(
                "A configuração estava ilegível e voltou ao padrão; a cópia está em {}",
                copy.display()
            ));
        }
        if !recovered.is_empty() {
            notices.push(format!(
                "{} gravação(ões) interrompida(s) recuperada(s)",
                recovered.len()
            ));
        }
        let mut inner = state.inner()?;
        inner.update_to_notify = just_updated;
        inner.notice = (!notices.is_empty()).then(|| notices.join(" · "));
        if ca_trimmed {
            // Same state as a changed CA: sync stopped and first run with the notice.
            inner.ca_changed = true;
            inner.sync_notice = Some(eclume_sync::pin::CA_TRIMMED.into());
        }
        drop(inner);
        Ok(state)
    }

    pub fn new(
        queue: Queue,
        recorder: RecorderConfig,
        config_path: PathBuf,
        config: Config,
        pat: PatStore,
    ) -> Self {
        let token_source = pat.load().ok().flatten().map(|(_, source)| source);
        Self {
            queue: Arc::new(Mutex::new(queue)),
            recorder,
            config_path,
            pat,
            inner: Mutex::new(Inner {
                active: None,
                stopping: None,
                mic_lost: false,
                origin: None,
                starting: false,
                syncing: false,
                config,
                auto: AutoRecorder::default(),
                notice: None,
                sync_notice: None,
                queue_waits: BTreeMap::new(),
                mirror: MirrorStatus::default(),
                shortcut_registrations: Registrations::new(),
                shortcut_mode: ShortcutMode::default(),
                importing: None,
                source_test: None,
                update_to_notify: None,
                token_source,
                prepared: None,
                ca_changed: false,
            }),
        }
    }

    fn config_dir(&self) -> &Path {
        self.config_path.parent().unwrap_or(Path::new("."))
    }

    /// App state. Remains accessible after a panic poisons it (with a log notice): `Inner` is
    /// plain data, with no cross-field invariant that a panic could leave unsafe.
    fn inner(&self) -> Result<MutexGuard<'_, Inner>> {
        Ok(recover_poison(self.inner.lock(), "application state"))
    }

    /// Queue. Remains accessible after a panic poisons it: SQLite writes are transactional.
    fn lock_queue(&self) -> Result<MutexGuard<'_, Queue>> {
        Ok(recover_poison(self.queue.lock(), "queue"))
    }

    /// Queue, for the sync loop (`eclume_recorder::sync_pending`).
    pub fn queue(&self) -> &Mutex<Queue> {
        &self.queue
    }

    /// Shared queue, so the uploader can store resume state in it.
    pub fn shared_queue(&self) -> Arc<Mutex<Queue>> {
        Arc::clone(&self.queue)
    }

    pub fn status(&self) -> Result<AppStatus> {
        let inner = self.inner()?;
        Ok(if inner.current().is_some() {
            AppStatus::Recording
        } else if inner.syncing {
            AppStatus::Syncing
        } else {
            AppStatus::Idle
        })
    }

    pub fn view(&self) -> Result<StatusView> {
        let status = self.status()?;
        let inner = self.inner()?;
        let current = inner.current();
        let origin = current.and(inner.origin);
        let queue = self.lock_queue()?;
        let markers = match current {
            Some((id, ..)) => queue.markers(id)?,
            None => Vec::new(),
        };
        Ok(StatusView {
            locale: resolved_locale(&inner.config),
            locale_choice: inner.config.locale.clone(),
            status,
            recording_id: current.map(|(id, ..)| id.to_string()),
            recording_started_at: current.map(|(_, started_at, _)| started_at),
            recording_kind: current.map(|(.., kind)| kind),
            note_silence_s: inner.config.note_silence_s,
            theme: inner.config.theme.clone(),
            recording_auto: origin.is_some_and(|o| o.auto),
            recording_app: origin.and_then(|o| o.app).map(MeetingView::from),
            meeting: inner.auto.meeting().map(MeetingView::from),
            pending_ask: inner.auto.pending_ask().map(MeetingView::from),
            marker_count: u32::try_from(markers.len()).unwrap_or(u32::MAX),
            last_marker: markers.into_iter().max_by_key(|m| m.created_at),
            counts: queue.counts()?,
            web_url: inner
                .config
                .effective_web_url(std::env::var(config::WEB_URL_ENV).ok()),
            notice: inner.notice.clone(),
            sync_notice: inner.sync_notice.clone(),
            queue_waits: inner.queue_waits.clone(),
            updated: inner.config.update_notice(CURRENT_VERSION).cloned(),
            connection: connection(&inner),
            account: inner.config.account.clone(),
            mic_lost: inner.mic_lost,
        })
    }

    pub fn locale(&self) -> Result<Locale> {
        Ok(resolved_locale(&self.inner()?.config))
    }

    pub fn set_locale(&self, choice: Option<String>) -> Result<()> {
        let choice = choice
            .map(|tag| match i18n::normalize(&tag) {
                Some(locale) => Ok(locale.tag().to_string()),
                None => bail!("unsupported locale: {tag}"),
            })
            .transpose()?;
        let mut inner = self.inner()?;
        let mut next = inner.config.clone();
        next.locale = choice;
        next.save(&self.config_path)?;
        inner.config = next;
        Ok(())
    }

    pub fn report_system_locale(&self, tag: &str) -> Result<()> {
        let Some(locale) = i18n::normalize(tag) else {
            return Ok(());
        };
        let mut inner = self.inner()?;
        if inner.config.system_locale.as_deref() != Some(locale.tag()) {
            let mut next = inner.config.clone();
            next.system_locale = Some(locale.tag().to_string());
            next.save(&self.config_path)?;
            inner.config = next;
        }
        Ok(())
    }

    /// Stores the canonical account language, clearing an absent or unsupported preference.
    fn store_account_locale(&self, tag: Option<&str>) -> Result<()> {
        let locale = tag
            .and_then(i18n::normalize)
            .map(|locale| locale.tag().to_string());
        let mut inner = self.inner()?;
        if inner.config.account_locale != locale {
            let mut next = inner.config.clone();
            next.account_locale = locale;
            next.save(&self.config_path)?;
            inner.config = next;
        }
        Ok(())
    }

    /// Refreshes the account preference with the stored credential, if one is available.
    pub fn refresh_account_locale(&self, net: &dyn Net) -> Result<()> {
        let Some(config) = self.uploader_config()? else {
            return Ok(());
        };
        let retry = RetryPolicy {
            retries: 0,
            ..RetryPolicy::default()
        };
        let transport = net.verified(&config.trust)?;
        let me = Client::new(transport, &config.api_url, &config.pat, retry)?.me()?;
        self.store_account_locale(me.user.locale.as_deref())
    }

    /// Starts a manual recording with the sources opened by `open`; the pending prompt for a
    /// detected meeting is dismissed.
    pub fn start_recording(&self, open: impl FnOnce() -> Result<OpenedSources>) -> Result<()> {
        self.start_recording_as(Origin::MANUAL, open)?;
        self.inner()?.auto.on_manual_start();
        Ok(())
    }

    /// Starts recording, tracking who started it and, if from detection, the meeting app.
    pub fn start_recording_as(
        &self,
        origin: Origin,
        open: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<()> {
        self.start(origin, StartOptions::MEETING, open)
    }

    /// "New voice note": starts a voice note (microphone only, configured silence stop) or stops
    /// the current voice note. With another recording in progress, returns [`Busy`].
    pub fn toggle_note(
        &self,
        open_mic: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<NoteToggle> {
        let silence = {
            let inner = self.inner()?;
            match &inner.active {
                Some(active) if active.kind() == Kind::Note => None,
                Some(_) => return Err(Busy.into()),
                None if inner.starting => return Err(Busy.into()),
                None => Some(inner.config.note_silence_s),
            }
        };
        let Some(silence) = silence else {
            return self
                .stop_recording()
                .map(|r| NoteToggle::Stopped(Box::new(r)));
        };
        let options = StartOptions::note(silence.map(|s| Duration::from_secs(u64::from(s))));
        self.start(Origin::MANUAL, options, open_mic)?;
        self.inner()?.auto.on_manual_start();
        Ok(NoteToggle::Started)
    }

    /// Marks the current instant in the recording: audio position, rather than wall time.
    pub fn add_marker(&self, note: Option<String>) -> Result<Marker> {
        let inner = self.inner()?;
        let active = inner
            .active
            .as_ref()
            .ok_or_else(|| anyhow!("nenhuma gravação em andamento"))?;
        let at_ms = active.progress().position_ms();
        self.lock_queue()?
            .add_marker(active.id(), at_ms, note.as_deref())
    }

    /// Changes a marker note while the recording has not been uploaded.
    pub fn set_marker_note(&self, client_id: &str, note: Option<String>) -> Result<Marker> {
        self.lock_queue()?
            .set_marker_note(client_id, note.as_deref())
    }

    /// Current voice note meter; `None` without a voice note.
    pub fn note_meter(&self) -> Result<Option<NoteMeter>> {
        let inner = self.inner()?;
        Ok(inner
            .active
            .as_ref()
            .filter(|active| active.kind() == Kind::Note)
            .map(|active| {
                let progress = active.progress();
                NoteMeter {
                    position_ms: progress.position_ms(),
                    levels: progress.meter(),
                    stops_in_ms: progress.stops_in_ms(),
                }
            }))
    }

    fn start(
        &self,
        origin: Origin,
        options: StartOptions,
        open: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<()> {
        {
            let mut inner = self.inner()?;
            if inner.active.is_some() || inner.stopping.is_some() || inner.starting {
                return Err(Busy.into());
            }
            inner.starting = true;
        }
        // Opening devices can take seconds: release state so the window and tray remain responsive
        // in the meantime.
        let opened = open();
        let mut inner = self.inner()?;
        inner.starting = false;
        let opened = match opened {
            Ok(opened) => opened,
            Err(err) => {
                inner.notice = Some(format!("{err:#}"));
                return Err(err);
            }
        };
        let queue = self.lock_queue()?;
        let active = session::start(&self.recorder, &queue, opened.sources, options)?;
        if let Some(app) = origin.app {
            queue.set_meeting_app(active.id(), app.meeting_app())?;
        }
        drop(queue);
        inner.notice = (!opened.missing.is_empty())
            .then(|| format!("gravando sem {}", opened.missing.join("; ")));
        inner.active = Some(active);
        inner.mic_lost = false;
        inner.origin = Some(origin);
        Ok(())
    }

    /// Stops the current recording and queues it in three stages: under state, removes `active`
    /// and sets `stopping`; without any lock, closes it (thread join, driver teardown, `fsync`,
    /// `rename`); under the queue, hands it over. The window and tray remain responsive;
    /// stopping again in the meantime returns [`Busy`].
    pub fn stop_recording(&self) -> Result<QueuedRecording> {
        let active = {
            let mut inner = self.inner()?;
            let Some(active) = inner.active.take() else {
                if inner.stopping.is_some() {
                    return Err(Busy.into());
                }
                bail!("nenhuma gravação em andamento");
            };
            inner.stopping = Some(Stopping {
                id: active.id().to_string(),
                started_at: active.started_at(),
                kind: active.kind(),
            });
            active
        };
        let result = active
            .close()
            .and_then(|closed| closed.deliver(&*self.lock_queue()?));
        let mut inner = self.inner()?;
        inner.stopping = None;
        inner.mic_lost = false;
        inner.origin = None;
        if let Err(err) = &result {
            inner.notice = Some(format!("falha ao fechar a gravação: {err:#}"));
        }
        result
    }

    /// Starts (manually) or stops, depending on state.
    pub fn toggle_recording(&self, open: impl FnOnce() -> Result<OpenedSources>) -> Result<()> {
        if self.inner()?.current().is_some() {
            self.stop_recording().map(|_| ())
        } else {
            self.start_recording(open)
        }
    }

    /// Closes a recording that ended on its own: disconnected sources, or a voice note stopped
    /// on silence. A voice note without speech is removed from the queue and disk.
    pub fn reap_finished(&self) -> Result<Option<Reaped>> {
        let reason = {
            let inner = self.inner()?;
            match inner.active.as_ref() {
                Some(active) if active.is_finished() => active.progress().stop_reason(),
                _ => return Ok(None),
            }
        };
        let recording = self.stop_recording()?;
        Ok(Some(match reason {
            Some(StopReason::Silence) => Reaped::NoteSaved(recording),
            Some(StopReason::NoSpeech) => {
                self.lock_queue()?.discard(&recording.id)?;
                if let Err(err) = std::fs::remove_file(&recording.path) {
                    log::warn!("failed to delete {}: {err}", recording.path.display());
                }
                log::info!("voice note {} discarded: no speech", recording.id);
                Reaped::NoteDiscarded
            }
            Some(StopReason::SourcesEnded) => {
                self.inner()?.notice = Some("a gravação parou: as fontes de áudio caíram".into());
                Reaped::Stopped {
                    recording,
                    reason: StopReason::SourcesEnded,
                }
            }
            // Without a reason, the recording thread panicked: counts as a failure.
            _ => {
                self.inner()?.notice = Some("a gravação parou: falha ao gravar".into());
                Reaped::Stopped {
                    recording,
                    reason: StopReason::Failed,
                }
            }
        }))
    }

    /// Watches the current recording sources: a microphone unavailable for over [`MIC_LOST_AFTER`]
    /// sets the window notice and a "microphone lost" marker at disconnection; its return clears
    /// the notice and marks "microphone back". Called by the reaper every second.
    pub fn watch_sources(&self) -> Result<Option<MicChange>> {
        let mut inner = self.inner()?;
        let Some(active) = inner.active.as_ref() else {
            return Ok(None);
        };
        let progress = active.progress();
        let lost_since = progress
            .source_states()
            .into_iter()
            .find_map(|state| match state {
                SourceState::Reconnecting { since } => Some(since),
                SourceState::Live => None,
            });
        let position_ms = progress.position_ms();
        let id = active.id().to_string();
        let change = match (lost_since, inner.mic_lost) {
            (Some(since), false) if since.elapsed() >= MIC_LOST_AFTER => {
                let out_ms = i64::try_from(since.elapsed().as_millis()).unwrap_or(i64::MAX);
                let at_ms = position_ms.saturating_sub(out_ms).max(0);
                self.lock_queue()?
                    .add_marker(&id, at_ms, Some("microfone perdido"))?;
                inner.mic_lost = true;
                inner.notice = Some(MIC_LOST_NOTICE.into());
                log::warn!("recording {id}: microphone unavailable for {out_ms} ms");
                MicChange::Lost
            }
            (None, true) => {
                self.lock_queue()?
                    .add_marker(&id, position_ms, Some("microfone de volta"))?;
                inner.mic_lost = false;
                if inner.notice.as_deref() == Some(MIC_LOST_NOTICE) {
                    inner.notice = None;
                }
                log::info!("recording {id}: microphone back");
                MicChange::Back
            }
            _ => return Ok(None),
        };
        Ok(Some(change))
    }

    /// Closes recordings left in `recording` without a live session (`.part` was stuck on stop),
    /// without waiting for the next open. Holds state during the sweep: no recording can start
    /// during it (state → queue order).
    pub fn sweep_orphans(&self) -> Result<usize> {
        let inner = self.inner()?;
        let live: Vec<&str> = inner.current().map(|(id, ..)| id).into_iter().collect();
        let recovered = session::recover_orphans(&*self.lock_queue()?, &live)?;
        Ok(recovered.len())
    }

    /// Detector event, through the automatic recording state machine; the caller runs the action.
    pub fn on_meeting_event(&self, event: &MeetingEvent) -> Result<Action> {
        let mut inner = self.inner()?;
        let recording = inner.recording();
        let Inner { auto, config, .. } = &mut *inner;
        Ok(auto.on_event(event, &config.detection, recording))
    }

    /// Answer to the detected meeting prompt; the caller runs the action.
    pub fn answer_meeting(&self, record: bool) -> Result<Action> {
        let mut inner = self.inner()?;
        let recording = inner.recording();
        Ok(inner.auto.answer(record, recording))
    }

    /// Sets "Syncing" until the guard drops, even if the work panics.
    pub fn syncing(&self) -> FlagGuard<'_> {
        FlagGuard::raise(self, |inner, on| inner.syncing = on)
    }

    /// Sets "synced folder running" until the guard drops, even if the cycle panics.
    pub fn mirror_running(&self) -> FlagGuard<'_> {
        FlagGuard::raise(self, |inner, on| inner.mirror.running = on)
    }

    /// Ends the import reserved by [`AppState::begin_import`] when the guard drops, even if
    /// conversion panics.
    pub fn import_guard(&self) -> FlagGuard<'_> {
        FlagGuard {
            state: self,
            set: |inner, _| inner.importing = None,
        }
    }

    /// What blocks sync, or its last error (`None` when everything worked).
    pub fn set_sync_notice(&self, notice: Option<String>) -> Result<()> {
        self.inner()?.sync_notice = notice;
        Ok(())
    }

    /// Queue waits for uploaded recordings; returns whether they changed.
    pub fn set_queue_waits(&self, waits: BTreeMap<String, QueueWait>) -> Result<bool> {
        let mut inner = self.inner()?;
        let changed = inner.queue_waits != waits;
        inner.queue_waits = waits;
        Ok(changed)
    }

    /// What the uploader needs; `None` without a configured PAT.
    pub fn uploader_config(&self) -> Result<Option<UploaderConfig>> {
        if self.inner()?.ca_changed {
            return Ok(None);
        }
        let Some((pat, _)) = self.pat.load()? else {
            return Ok(None);
        };
        let inner = self.inner()?;
        let api_url = inner.config.effective_api_url(
            std::env::var(config::API_URL_ENV).ok(),
            std::env::var(config::WEB_URL_ENV).ok(),
        );
        // Without a selected server there is nowhere to upload.
        if api_url.is_empty() {
            return Ok(None);
        }
        Ok(Some(UploaderConfig {
            api_url,
            pat,
            trust: account::trust_for(self.config_dir(), inner.config.ca_path.as_deref()),
            client_version: CLIENT_VERSION.to_string(),
        }))
    }

    /// Days to keep the local file after confirmation (`None`: forever).
    pub fn retention_days(&self) -> Result<Option<u32>> {
        Ok(self.inner()?.config.retention_days)
    }

    /// Whether meeting detection is enabled.
    pub fn detection_enabled(&self) -> Result<bool> {
        Ok(self.inner()?.config.detection.enabled)
    }

    /// Microphone and sources selected in the Audio tab.
    pub fn audio_choice(&self) -> Result<AudioChoice> {
        Ok(AudioChoice::from_config(&self.inner()?.config))
    }

    /// Whether sync notifies when the summary of an uploaded recording is ready.
    pub fn notify_summary(&self) -> Result<bool> {
        Ok(self.inner()?.config.notify_summary)
    }

    /// Number of recent recordings in the top panel; `0` hides it.
    pub fn recent_count(&self) -> Result<u8> {
        Ok(self.inner()?.config.recent_count)
    }

    /// Number of recent recordings in the tray menu; `0` hides the section.
    pub fn tray_recent_count(&self) -> Result<u8> {
        Ok(self.inner()?.config.tray_recent_count)
    }

    /// Whether the app should start with the computer.
    pub fn autostart(&self) -> Result<bool> {
        Ok(self.inner()?.config.autostart)
    }

    /// Synced folder status for the window.
    pub fn mirror_status(&self) -> Result<MirrorStatus> {
        Ok(self.inner()?.mirror.clone())
    }

    /// Updates synced folder status.
    pub fn update_mirror(&self, change: impl FnOnce(&mut MirrorStatus)) -> Result<()> {
        change(&mut self.inner()?.mirror);
        Ok(())
    }

    /// Synced folder: whether enabled, where, and whether it includes transcripts.
    pub fn mirror_config(&self) -> Result<config::MirrorConfig> {
        Ok(self.inner()?.config.mirror.clone())
    }

    /// Transcription language requested by uploads; `None` uses the server default.
    pub fn language(&self) -> Result<Option<String>> {
        Ok(self.inner()?.config.language.clone())
    }

    /// "Speak to test" or "Play something to test": opens the source for up to `duration` on a
    /// thread and feeds the silence detector meter, without recording. One test at a time:
    /// any current test stops.
    pub fn start_source_test(
        &self,
        open: impl FnOnce() -> Result<Box<dyn AudioSource>> + Send + 'static,
        duration: Duration,
    ) -> Result<()> {
        let mut inner = self.inner()?;
        if let Some(test) = &inner.source_test {
            test.running.store(false, Ordering::Relaxed);
        }
        let levels = Arc::new(Mutex::new([0.0; METER_BARS]));
        let running = Arc::new(AtomicBool::new(true));
        inner.source_test = Some(SourceTest {
            levels: Arc::clone(&levels),
            running: Arc::clone(&running),
        });
        std::thread::spawn(move || {
            if let Err(err) = run_source_test(open, duration, &levels, &running) {
                log::warn!("level test: {err:#}");
            }
            running.store(false, Ordering::Relaxed);
        });
        Ok(())
    }

    /// "Stop": ends the current level test immediately; does nothing without a test.
    pub fn stop_source_test(&self) -> Result<()> {
        if let Some(test) = self.inner()?.source_test.take() {
            test.running.store(false, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Level test meter; `None` when no test is running.
    pub fn source_test_meter(&self) -> Result<Option<[f32; METER_BARS]>> {
        let inner = self.inner()?;
        Ok(inner
            .source_test
            .as_ref()
            .filter(|t| t.running.load(Ordering::Relaxed))
            .and_then(|t| t.levels.lock().ok().map(|levels| *levels)))
    }

    /// Update to notify on this open; `None` after the first call.
    pub fn take_update_notification(&self) -> Result<Option<PendingUpdate>> {
        Ok(self.inner()?.update_to_notify.take())
    }

    /// Stores version and notes before the updater installs.
    pub fn record_pending_update(&self, version: &str, notes: Option<String>) -> Result<()> {
        let mut inner = self.inner()?;
        inner.config.pending_update = Some(PendingUpdate {
            version: version.to_string(),
            notes: notes.filter(|n| !n.trim().is_empty()),
        });
        inner.config.save(&self.config_path)
    }

    /// Dismisses the "Updated to X" notice.
    pub fn dismiss_update_notice(&self) -> Result<()> {
        let mut inner = self.inner()?;
        inner.config.pending_update = None;
        inner.config.last_version = Some(CURRENT_VERSION.to_string());
        inner.config.save(&self.config_path)
    }

    /// Global shortcuts from config.
    pub fn shortcuts(&self) -> Result<Shortcuts> {
        Ok(self.inner()?.config.shortcuts.clone())
    }

    /// Stores shortcut mode and each registration result, for the Audio tab.
    pub fn set_shortcuts_state(
        &self,
        mode: ShortcutMode,
        registrations: Registrations,
    ) -> Result<()> {
        let mut inner = self.inner()?;
        inner.shortcut_mode = mode;
        inner.shortcut_registrations = registrations;
        Ok(())
    }

    /// Marks the start of an import; only one at a time.
    pub fn begin_import(&self) -> Result<Arc<AtomicBool>> {
        let mut inner = self.inner()?;
        if inner.importing.is_some() {
            bail!("Já há uma importação em andamento");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.importing = Some(Arc::clone(&cancel));
        Ok(cancel)
    }

    /// Requests cancellation of the current import.
    pub fn cancel_import(&self) -> Result<()> {
        if let Some(cancel) = &self.inner()?.importing {
            cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Converts `src` to `gravacoes/` (or copies it) and queues it as pending, with
    /// `source: upload`. `recorded_at` is the start confirmed or entered in the window.
    pub fn import_file(
        &self,
        src: &Path,
        recorded_at: i64,
        recorded_at_source: RecordedAtSource,
        cancel: &AtomicBool,
        progress: impl FnMut(f32),
    ) -> Result<QueuedRecording> {
        let probe = eclume_import::probe(src)?;
        if !probe.has_audio {
            bail!("{} não tem áudio", src.display());
        }
        let id = import_id();
        let converted = eclume_import::convert(src, &self.recorder.dir, &id, cancel, progress)?;
        let original_name = src
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone());
        let duration_ms = converted.duration_ms.or(probe.duration_ms).unwrap_or(0);
        let queue = self.lock_queue()?;
        queue.begin_import(&NewImport {
            id: &id,
            path: &converted.path,
            recorded_at,
            recorded_at_source,
            original_name: &original_name,
            content_type: (!converted.converted).then_some(converted.content_type.as_str()),
            duration_ms: i64::try_from(duration_ms).unwrap_or(i64::MAX),
            bytes: i64::try_from(converted.bytes).unwrap_or(i64::MAX),
        })?;
        queue
            .get(&id)?
            .ok_or_else(|| anyhow!("importação {id} sumiu da fila"))
    }

    /// Recordings folder.
    pub fn data_dir(&self) -> &Path {
        &self.recorder.dir
    }

    /// Number of recordings (and bytes) still in the local folder; `.part` files from a
    /// conversion in progress do not count.
    pub fn storage_info(&self) -> Result<StorageInfo> {
        let mut info = StorageInfo {
            dir: self.recorder.dir.clone(),
            recordings: 0,
            bytes: 0,
        };
        let entries = match std::fs::read_dir(&self.recorder.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(info),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let entry = entry?;
            let meta = entry.metadata()?;
            let partial = entry.path().extension().is_some_and(|e| e == "part");
            if meta.is_file() && !partial {
                info.recordings += 1;
                info.bytes += meta.len();
            }
        }
        Ok(info)
    }

    pub fn recordings(&self, limit: u32) -> Result<Vec<QueuedRecording>> {
        self.lock_queue()?.list(limit)
    }

    /// Effective server; clear error before first run in a build without an embedded server.
    pub fn web_url(&self) -> Result<String> {
        let url = self.view()?.web_url;
        if url.is_empty() {
            bail!("servidor não configurado");
        }
        Ok(url)
    }

    /// TLS trust ([`account::trust_for`]), reading only config, without accessing the keyring like
    /// [`Self::settings`]: the updater runs outside the keyring thread.
    pub fn trust(&self) -> Result<TrustMode> {
        let inner = self.inner()?;
        Ok(account::trust_for(
            self.config_dir(),
            inner.config.ca_path.as_deref(),
        ))
    }

    pub fn settings(&self) -> Result<SettingsView> {
        let inner = self.inner()?;
        let pat_source = inner.token_source;
        let config = &inner.config;
        Ok(SettingsView {
            web_url: config.web_url.clone(),
            api_url: config.api_url.clone(),
            ca_path: config.ca_path.clone(),
            detection_enabled: config.detection.enabled,
            apps: AppKey::ALL
                .into_iter()
                .map(|app| AppPolicyView {
                    app,
                    label: app.label(),
                    policy: config.detection.policy(app),
                    default_policy: default_policy(app),
                })
                .collect(),
            retention_days: config.retention_days,
            pat_source,
            connection: connection(&inner),
            account: config.account.clone(),
            mic: config.mic.clone(),
            system_source: config.system_source.clone(),
            language: config.language.clone(),
            theme: config.theme.clone(),
            notify_summary: config.notify_summary,
            autostart: config.autostart,
            recent_count: config.recent_count,
            tray_recent_count: config.tray_recent_count,
            mirror_enabled: config.mirror.enabled,
            mirror_dir: config.mirror.dir.clone(),
            mirror_transcripts: config.mirror.transcripts,
            note_silence_s: config.note_silence_s,
            shortcut_mode: inner.shortcut_mode.clone(),
            shortcuts: ShortcutAction::ALL
                .into_iter()
                .map(|action| {
                    let registration = inner.shortcut_registrations.get(&action).copied();
                    ShortcutView {
                        action,
                        label: action.label(),
                        keys: config.shortcuts.get(action).to_string(),
                        registration,
                        problem: registration.and_then(Registration::label),
                    }
                })
                .collect(),
        })
    }

    /// Validates and saves configuration and PAT. Returns the detection action (dismiss the
    /// pending prompt when its policy changed).
    pub fn save_settings(&self, input: SettingsInput) -> Result<Action> {
        let mut next = self.inner()?.config.clone();
        next.web_url = input.web_url.trim().to_string();
        next.api_url = non_empty(input.api_url);
        next.ca_path = non_empty(input.ca_path).map(PathBuf::from);
        next.detection.enabled = input.detection_enabled;
        next.detection.policies = input.policies;
        next.retention_days = input.retention_days;
        if let Some(mic) = input.mic {
            next.mic = non_empty(Some(mic));
        }
        if let Some(source) = input.system_source {
            next.system_source =
                non_empty(Some(source)).unwrap_or_else(|| config::SYSTEM_FOLLOW.to_string());
        }
        if let Some(language) = input.language {
            next.language = non_empty(Some(language));
        }
        if let Some(theme) = input.theme {
            next.theme = theme;
        }
        if let Some(notify) = input.notify_summary {
            next.notify_summary = notify;
        }
        if let Some(autostart) = input.autostart {
            next.autostart = autostart;
        }
        if let Some(count) = input.recent_count {
            next.recent_count = count;
        }
        if let Some(count) = input.tray_recent_count {
            next.tray_recent_count = count;
        }
        if let Some(enabled) = input.mirror_enabled {
            next.mirror.enabled = enabled;
        }
        if let Some(dir) = input.mirror_dir {
            next.mirror.dir = non_empty(Some(dir)).map(PathBuf::from);
        }
        if let Some(transcripts) = input.mirror_transcripts {
            next.mirror.transcripts = transcripts;
        }
        if let Some(seconds) = input.note_silence_s {
            next.note_silence_s = (seconds > 0).then_some(seconds);
        }
        if let Some(shortcuts) = input.shortcuts {
            next.shortcuts = Shortcuts {
                record: shortcuts.record.trim().to_string(),
                note: shortcuts.note.trim().to_string(),
                marker: shortcuts.marker.trim().to_string(),
            };
        }
        next.validate()?;
        let moved = {
            let current = &self.inner()?.config;
            current.account.is_some()
                && (next.web_url.trim_end_matches('/') != current.web_url.trim_end_matches('/')
                    || next.ca_path != current.ca_path)
        };
        if moved && !input.clear_pat {
            // The device credential and pinned CA apply to this server, not another.
            bail!("Saia da conta antes de trocar o servidor ou a CA");
        }

        let saved = if input.clear_pat {
            self.pat.clear()?;
            next.account = None;
            Some(None)
        } else if let Some(pat) = non_empty(input.pat) {
            Some(Some(self.save_secret(&pat)?))
        } else {
            None
        };
        next.save(&self.config_path)?;
        let mut inner = self.inner()?;
        if let Some(source) = saved {
            inner.token_source = source;
        }
        let action = inner.auto.on_config_change(&next.detection);
        inner.config = next;
        Ok(action)
    }

    /// Stores the credential in the keyring; without one, warns that it was saved to a file.
    fn save_secret(&self, secret: &str) -> Result<PatSource> {
        let source = self.pat.save(secret)?;
        if source == PatSource::File {
            self.inner()?.notice = Some(
                "chaveiro do sistema indisponível: a credencial ficou num arquivo só seu, no \
                 diretório de configuração"
                    .into(),
            );
        }
        Ok(source)
    }

    /// Pins the selected server CA and stores it for the person to sign in.
    pub fn prepare_server(
        &self,
        net: &dyn Net,
        url: &str,
        ca_sha256: Option<&str>,
    ) -> Result<PreparedServer> {
        let vouched =
            account::vouched_by_installer(crate::config::embedded_server(), url, ca_sha256);
        let server = account::prepare(net, self.config_dir(), url, ca_sha256, vouched)?;
        self.inner()?.prepared = Some(server.clone());
        Ok(server)
    }

    /// The person checked the prepared server fingerprint (`first_use`).
    pub fn confirm_server(&self, url: &str, ca_sha256: Option<&str>) -> Result<()> {
        match self.inner()?.prepared.as_mut() {
            Some(server) => account::confirm(server, url, ca_sha256),
            None => bail!("Escolha o servidor antes de entrar"),
        }
    }

    /// Signs in to the selected server, stores the credential, and starts syncing with it.
    pub fn sign_in(&self, net: &dyn Net, login: Login<'_>) -> Result<()> {
        let server = account::require(self.inner()?.prepared.clone())?;
        let signed = account::sign_in(
            net,
            self.config_dir(),
            &server,
            login,
            &eclume_sync::device_name(),
        )?;
        self.apply_sign_in(signed)?;
        if let Err(err) = self.refresh_account_locale(net) {
            log::warn!("failed to refresh account locale after sign-in: {err:#}");
        }
        Ok(())
    }

    fn apply_sign_in(&self, signed: SignedIn) -> Result<()> {
        let source = self.save_secret(&signed.secret)?;
        let mut next = self.inner()?.config.clone();
        next.web_url = signed.web_url;
        next.api_url = None;
        next.ca_path = signed.ca_path;
        next.account = Some(signed.account);
        next.account_locale = None;
        next.save(&self.config_path)?;
        let mut inner = self.inner()?;
        inner.config = next;
        inner.token_source = Some(source);
        inner.prepared = None;
        inner.ca_changed = false;
        inner.sync_notice = None;
        Ok(())
    }

    /// "Sign out": deletes this computer's credential and returns to first run; the queue stays.
    pub fn sign_out(&self) -> Result<()> {
        self.pat.clear()?;
        let mut next = self.inner()?.config.clone();
        next.account = None;
        next.account_locale = None;
        next.save(&self.config_path)?;
        let mut inner = self.inner()?;
        inner.config = next;
        inner.token_source = None;
        Ok(())
    }

    /// Address and CA pinned on first run; `None` with a manually chosen CA or no CA.
    pub fn pinned_ca(&self) -> Result<Option<(String, PathBuf)>> {
        let inner = self.inner()?;
        let ca_path = inner.config.ca_path.as_deref();
        Ok(account::is_pinned(self.config_dir(), ca_path)
            .then(|| ca_path.map(|path| (inner.config.web_url.clone(), path.to_path_buf())))
            .flatten())
    }

    /// Sync is stopped because the pinned CA changed.
    pub fn pinned_ca_changed(&self) -> Result<bool> {
        Ok(self.inner()?.ca_changed)
    }

    /// Server CA changed: sync stops and the window asks the person to sign in again.
    pub fn mark_ca_changed(&self) -> Result<()> {
        let mut inner = self.inner()?;
        inner.ca_changed = true;
        inner.sync_notice = Some(eclume_sync::pin::CA_CHANGED.into());
        Ok(())
    }

    /// "Test connection": `GET /api/v1/me` with the stored credential.
    pub fn test_connection(&self, net: &dyn Net) -> Result<ConnectionTest> {
        let Some(config) = self.uploader_config()? else {
            bail!("Entre para testar a conexão");
        };
        let retry = RetryPolicy {
            retries: 0,
            ..RetryPolicy::default()
        };
        let transport = net.verified(&config.trust)?;
        let me = Client::new(transport, &config.api_url, &config.pat, retry)?.me()?;
        self.store_account_locale(me.user.locale.as_deref())?;
        let last_upload_at = self
            .lock_queue()?
            .list(500)?
            .into_iter()
            .filter_map(|recording| recording.synced_at)
            .max();
        Ok(ConnectionTest {
            email: me.user.email,
            last_upload_at,
        })
    }
}

/// Resolves the desktop language, using the environment until the window reports its locale.
fn resolved_locale(config: &Config) -> Locale {
    let system = config.system_locale.clone().or_else(i18n::env_locale);
    i18n::resolve(
        config.locale.as_deref(),
        config.account_locale.as_deref(),
        system.as_deref(),
    )
}

/// First run appears without a credential and when the pinned CA changed.
fn connection(inner: &Inner) -> Connection {
    if inner.ca_changed {
        Connection::FirstRun
    } else {
        inner.config.connection(inner.token_source.is_some())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use anyhow::bail;
    use eclume_recorder::source::{ScriptedSource, SineSource};
    use eclume_recorder::Status;

    use super::*;
    use crate::capture::SourceChoice;

    /// Keyring unavailable: PAT goes to a file, as in a session without Secret Service.
    struct NoKeyring;

    impl eclume_sync::pat::SecretBackend for NoKeyring {
        fn get(&self) -> Result<Option<String>> {
            bail!("sem chaveiro")
        }
        fn set(&self, _: &str) -> Result<()> {
            bail!("sem chaveiro")
        }
        fn delete(&self) -> Result<()> {
            Ok(())
        }
    }

    fn state(name: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("eclume-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = AppState::new(
            Queue::open_in_memory().unwrap(),
            RecorderConfig::new(dir.join("gravacoes")),
            dir.join("config.json"),
            Config::default(),
            PatStore::with_backend(dir.join("pat"), Box::new(NoKeyring), None),
        );
        (state, dir)
    }

    fn sine_sources(seconds: u64) -> Result<OpenedSources> {
        Ok(OpenedSources {
            sources: vec![Box::new(SineSource::new(
                48_000,
                440.0,
                0.3,
                Duration::from_secs(seconds),
            ))],
            missing: vec!["áudio do sistema: teste".into()],
        })
    }

    #[test]
    fn locale_choice_is_saved_and_reflected_in_status() {
        let (state, dir) = state("locale-choice");
        state.report_system_locale("en-US").unwrap();
        state.set_locale(Some(" pt_BR ".into())).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.locale, Locale::PtBr);
        assert_eq!(view.locale_choice.as_deref(), Some("pt-BR"));
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        assert_eq!(
            Config::load(&state.config_path).locale.as_deref(),
            Some("pt-BR")
        );

        assert_eq!(
            state.set_locale(Some("fr".into())).unwrap_err().to_string(),
            "unsupported locale: fr"
        );
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        state.set_locale(None).unwrap();
        assert_eq!(state.view().unwrap().locale, Locale::En);
        assert_eq!(state.view().unwrap().locale_choice, None);
        assert_eq!(Config::load(&state.config_path).locale, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn system_locale_is_normalized_and_unsupported_tags_are_ignored() {
        let (state, dir) = state("system-locale");
        state.report_system_locale("pt_BR").unwrap();
        assert_eq!(
            Config::load(&state.config_path).system_locale.as_deref(),
            Some("pt-BR")
        );
        assert_eq!(state.view().unwrap().locale, Locale::PtBr);
        // An unchanged or unsupported report must not attempt another save.
        std::fs::remove_file(&state.config_path).unwrap();
        std::fs::create_dir(&state.config_path).unwrap();
        state.report_system_locale("pt-PT").unwrap();
        state.report_system_locale("fr-FR").unwrap();
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn account_locale_precedes_system_and_follows_desktop_choice() {
        let (state, dir) = state("account-locale");
        state.report_system_locale("en").unwrap();
        state.store_account_locale(Some("pt-PT")).unwrap();
        assert_eq!(
            Config::load(&state.config_path).account_locale.as_deref(),
            Some("pt-BR")
        );
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        assert_eq!(state.view().unwrap().locale, Locale::PtBr);
        state.set_locale(Some("en".into())).unwrap();
        assert_eq!(state.locale().unwrap(), Locale::En);
        state.set_locale(None).unwrap();
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        state.store_account_locale(Some("fr")).unwrap();
        assert_eq!(Config::load(&state.config_path).account_locale, None);
        assert_eq!(state.locale().unwrap(), Locale::En);
        state.store_account_locale(Some("pt")).unwrap();
        state.store_account_locale(None).unwrap();
        assert_eq!(Config::load(&state.config_path).account_locale, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Source whose drop takes 2 s, like a slow driver releasing the device.
    struct SlowDrop(SineSource);

    impl eclume_recorder::AudioSource for SlowDrop {
        fn sample_rate(&self) -> u32 {
            self.0.sample_rate()
        }

        fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
            self.0.read(timeout)
        }
    }

    impl Drop for SlowDrop {
        fn drop(&mut self) {
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    #[test]
    fn microphone_loss_and_return_become_notice_and_markers() {
        use eclume_audio_capture::reconnect::{Opener, Reconnecting};
        use eclume_audio_capture::ring;

        /// Pushes 10 ms of tone every 10 ms until `stop` (or `until`) and closes the ring.
        fn feed(mut writer: ring::RingWriter, until: Duration, stop: Arc<AtomicBool>) {
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                while started.elapsed() < until && !stop.load(Ordering::Acquire) {
                    writer.push_interleaved(160, 1, |i| (i as f32 * 0.1).sin() * 0.3);
                    std::thread::sleep(Duration::from_millis(10));
                }
                writer.close();
            });
        }

        let (state, dir) = state("microfone");
        let stop = Arc::new(AtomicBool::new(false));
        let back = Arc::new(AtomicBool::new(false));
        let (writer, first) = ring::channel(1 << 14, 16_000);
        feed(writer, Duration::from_millis(500), Arc::clone(&stop));
        let mut first = Some(first);
        let opener: Opener = {
            let stop = Arc::clone(&stop);
            let back = Arc::clone(&back);
            Box::new(move || {
                if let Some(first) = first.take() {
                    return Ok(first);
                }
                if !back.load(Ordering::Acquire) {
                    bail!("microfone fora");
                }
                let (writer, again) = ring::channel(1 << 14, 16_000);
                feed(writer, Duration::from_secs(60), Arc::clone(&stop));
                Ok(again)
            })
        };
        let mic = Reconnecting::open(opener).unwrap();
        state
            .start_recording(|| {
                Ok(OpenedSources {
                    sources: vec![Box::new(mic)],
                    missing: Vec::new(),
                })
            })
            .unwrap();

        // Unavailable for less than 5 s: nothing yet.
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(state.watch_sources().unwrap(), None);
        assert!(!state.view().unwrap().mic_lost);
        let started = std::time::Instant::now();
        let mut lost = None;
        while lost.is_none() && started.elapsed() < Duration::from_secs(6) {
            lost = state.watch_sources().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(lost, Some(MicChange::Lost));
        let view = state.view().unwrap();
        assert!(view.mic_lost);
        assert_eq!(view.notice.as_deref(), Some(MIC_LOST_NOTICE));
        let marker = view.last_marker.unwrap();
        assert_eq!(marker.note.as_deref(), Some("microfone perdido"));
        // At disconnection (~0.5 s of audio), rather than at the notice.
        assert!(marker.at_ms < 1_500, "{} ms", marker.at_ms);

        back.store(true, Ordering::Release);
        let started = std::time::Instant::now();
        let mut returned = None;
        while returned.is_none() && started.elapsed() < Duration::from_secs(8) {
            returned = state.watch_sources().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(returned, Some(MicChange::Back));
        let view = state.view().unwrap();
        assert!(!view.mic_lost);
        assert_eq!(view.notice, None);
        assert_eq!(view.marker_count, 2);
        assert_eq!(
            view.last_marker.unwrap().note.as_deref(),
            Some("microfone de volta")
        );
        state.stop_recording().unwrap();
        stop.store(true, Ordering::Release);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_stops_outside_lock() {
        let (state, dir) = state("parada-lenta");
        let state = Arc::new(state);
        state
            .start_recording(|| {
                Ok(OpenedSources {
                    sources: vec![Box::new(SlowDrop(SineSource::new(
                        48_000,
                        440.0,
                        0.3,
                        Duration::from_secs(30),
                    )))],
                    missing: Vec::new(),
                })
            })
            .unwrap();
        let stopping = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || state.stop_recording())
        };
        std::thread::sleep(Duration::from_millis(300));

        let asked = std::time::Instant::now();
        assert_eq!(state.status().unwrap(), AppStatus::Recording);
        assert!(state.view().unwrap().recording_id.is_some());
        assert!(asked.elapsed() < Duration::from_millis(100));
        // Stopping again, or starting, during a stop is "busy".
        assert!(state.stop_recording().unwrap_err().is::<Busy>());
        assert!(state
            .start_recording(|| sine_sources(1))
            .unwrap_err()
            .is::<Busy>());

        let recording = stopping.join().unwrap().unwrap();
        assert_eq!(recording.status, Status::Pending);
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_remains_accessible_after_panic() {
        let (state, dir) = state("envenenado");
        let state = Arc::new(state);
        {
            let state = Arc::clone(&state);
            let _ = std::thread::spawn(move || {
                let _inner = state.inner.lock().unwrap();
                let _queue = state.queue.lock().unwrap();
                panic!("panic while holding locks");
            })
            .join();
        }
        assert!(state.inner.is_poisoned());
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert!(state.view().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn settings_input(state: &AppState) -> SettingsInput {
        let view = state.settings().unwrap();
        SettingsInput {
            web_url: view.web_url,
            api_url: view.api_url,
            ca_path: None,
            detection_enabled: view.detection_enabled,
            policies: BTreeMap::new(),
            retention_days: view.retention_days,
            pat: None,
            clear_pat: false,
            shortcuts: None,
            mic: None,
            system_source: None,
            language: None,
            theme: None,
            notify_summary: None,
            autostart: None,
            recent_count: None,
            tray_recent_count: None,
            mirror_enabled: None,
            mirror_dir: None,
            mirror_transcripts: None,
            note_silence_s: None,
        }
    }

    #[test]
    fn state_toggles_between_idle_recording_and_idle() {
        let (state, dir) = state("alterna");
        assert_eq!(state.status().unwrap(), AppStatus::Idle);

        state.toggle_recording(|| sine_sources(60)).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.status, AppStatus::Recording);
        assert!(view.recording_id.is_some());
        assert!(!view.recording_auto);
        assert_eq!(
            view.notice.as_deref(),
            Some("gravando sem áudio do sistema: teste")
        );
        assert!(state.start_recording(|| sine_sources(1)).is_err());

        state.toggle_recording(|| sine_sources(1)).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.status, AppStatus::Idle);
        assert_eq!(view.counts.pending, 1);
        assert_eq!(state.recordings(10).unwrap()[0].status, Status::Pending);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Waits for the reaper to close the recording that ended on its own.
    fn reap(state: &AppState) -> Reaped {
        for _ in 0..4_000 {
            if let Some(reaped) = state.reap_finished().unwrap() {
                return reaped;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("recording did not end on its own");
    }

    /// Synthetic microphone: speech for `speech_ms`, then silence, until `total_ms`.
    fn mic(speech_ms: u64, total_ms: u64) -> Result<OpenedSources> {
        let chunks = (0..total_ms / 10).map(move |i| {
            let t = i * 10;
            Some(
                (0..160u64)
                    .map(|n| {
                        if t < speech_ms && t % 300 < 200 {
                            0.3 * (2.0 * std::f32::consts::PI * 220.0 * (t * 16 + n) as f32
                                / 16_000.0)
                                .sin()
                        } else {
                            0.0
                        }
                    })
                    .collect(),
            )
        });
        Ok(OpenedSources {
            sources: vec![Box::new(ScriptedSource::new(16_000, chunks))],
            missing: Vec::new(),
        })
    }

    #[test]
    fn state_closes_recording_whose_sources_ended() {
        let (state, dir) = state("colhe");
        state.start_recording(|| sine_sources(0)).unwrap();
        assert!(matches!(
            reap(&state),
            Reaped::Stopped {
                reason: StopReason::SourcesEnded,
                ..
            }
        ));
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(state.view().unwrap().counts.pending, 1);
        assert!(state.reap_finished().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_sweeps_orphan_without_touching_live_recording() {
        let (state, dir) = state("varredura");
        state.start_recording(|| sine_sources(30)).unwrap();
        let orphan = dir.join("gravacoes").join("orfa.ogg.part");
        std::fs::write(&orphan, b"OggS").unwrap();
        state
            .lock_queue()
            .unwrap()
            .begin("orfa", &orphan, 1)
            .unwrap();

        assert_eq!(state.sweep_orphans().unwrap(), 1);
        assert_eq!(state.status().unwrap(), AppStatus::Recording);
        let row = state.lock_queue().unwrap().get("orfa").unwrap().unwrap();
        assert!(row.interrupted);
        assert_eq!(state.sweep_orphans().unwrap(), 0);
        state.stop_recording().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_opens_with_stuck_part() {
        let dir = std::env::temp_dir().join(format!("eclume-state-preso-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("presa.ogg.part");
        std::fs::write(&part, b"OggS").unwrap();
        // Renaming a file to a directory fails: simulates the stuck `.part`.
        std::fs::create_dir(dir.join("presa.ogg")).unwrap();
        Queue::open(&dir.join("queue.sqlite"))
            .unwrap()
            .begin("presa", &part, 1)
            .unwrap();

        let state = AppState::open(&dir, &dir).unwrap();
        let row = state.lock_queue().unwrap().get("presa").unwrap().unwrap();
        assert_eq!(row.status, eclume_recorder::queue::Status::Recording);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_open_saves_config_only_when_version_changes() {
        let dir = std::env::temp_dir().join(format!("eclume-state-versao-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config_path = dir.join("config.json");
        drop(AppState::open(&dir, &dir).unwrap());
        let first = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(50));

        drop(AppState::open(&dir, &dir).unwrap());
        let second = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        assert_eq!(first, second);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_opens_with_unreadable_config_and_notifies_window() {
        let dir =
            std::env::temp_dir().join(format!("eclume-state-ilegivel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), "{ quebrado").unwrap();

        let state = AppState::open(&dir, &dir).unwrap();
        let notice = state.view().unwrap().notice.unwrap();
        assert!(
            notice
                .starts_with("A configuração estava ilegível e voltou ao padrão; a cópia está em"),
            "{notice}"
        );
        let copies = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("config.json.ilegivel-")
            })
            .count();
        assert_eq!(copies, 1);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_note_stops_on_silence_and_is_queued_as_note() {
        let (state, dir) = state("nota");
        state.inner().unwrap().config = Config {
            note_silence_s: Some(2),
            ..Config::default()
        };
        assert!(matches!(
            state.toggle_note(|| mic(1_000, 60_000)).unwrap(),
            NoteToggle::Started
        ));
        let view = state.view().unwrap();
        assert_eq!(view.recording_kind, Some(Kind::Note));
        assert_eq!(view.note_silence_s, Some(2));
        assert!(state.note_meter().unwrap().is_some());

        let Reaped::NoteSaved(recording) = reap(&state) else {
            panic!("voice note should stop on silence");
        };
        assert_eq!(recording.kind, Kind::Note);
        assert!(recording.path.exists());
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert!(state.note_meter().unwrap().is_none());
        assert_eq!(state.recordings(10).unwrap()[0].kind, Kind::Note);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_note_without_speech_is_removed_from_queue_and_disk() {
        let (state, dir) = state("nota-muda");
        state.toggle_note(|| mic(0, 60_000)).unwrap();
        let path = state.recorder.dir.clone();
        assert!(matches!(reap(&state), Reaped::NoteDiscarded));
        assert!(state.recordings(10).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(path).unwrap().count(), 0);
        assert_eq!(state.view().unwrap().notice, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn new_voice_note_again_stops_current_note_and_never_discards() {
        let (state, dir) = state("nota-manual");
        state.toggle_note(|| mic(0, 600_000)).unwrap();
        let NoteToggle::Stopped(recording) = state.toggle_note(|| mic(0, 1)).unwrap() else {
            panic!("the second New voice note should stop the first");
        };
        assert_eq!(recording.kind, Kind::Note);
        assert_eq!(state.recordings(10).unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn markers_at_audio_position_with_editable_note() {
        let (state, dir) = state("marcadores");
        assert!(
            state.add_marker(None).is_err(),
            "no marker without a recording"
        );
        state.start_recording(|| sine_sources(60)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let first = state.add_marker(None).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let second = state
            .add_marker(Some("decisão do orçamento".into()))
            .unwrap();
        assert!(first.at_ms > 0);
        assert!(
            second.at_ms > first.at_ms,
            "{} ≤ {}",
            second.at_ms,
            first.at_ms
        );

        let view = state.view().unwrap();
        assert_eq!(view.marker_count, 2);
        assert_eq!(view.last_marker.as_ref(), Some(&second));
        let edited = state
            .set_marker_note(&first.client_id, Some("ação".into()))
            .unwrap();
        assert_eq!(edited.note.as_deref(), Some("ação"));

        let recording = state.stop_recording().unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.marker_count, 0);
        assert!(view.last_marker.is_none());
        let saved = state
            .queue()
            .lock()
            .unwrap()
            .markers(&recording.id)
            .unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].note.as_deref(), Some("ação"));
        // Until uploaded, the note can still change.
        state.set_marker_note(&second.client_id, None).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn new_voice_note_during_meeting_is_busy() {
        let (state, dir) = state("nota-ocupado");
        state.start_recording(|| sine_sources(60)).unwrap();
        let err = state.toggle_note(|| mic(0, 1)).unwrap_err();
        assert!(err.is::<Busy>());
        assert_eq!(err.to_string(), "Já há uma gravação em andamento");
        assert_eq!(state.view().unwrap().recording_kind, Some(Kind::Meeting));
        assert!(state.note_meter().unwrap().is_none());
        state.stop_recording().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_records_notice_without_sources() {
        let (state, _dir) = state("sem-fontes");
        assert!(state.start_recording(|| bail!("nenhuma fonte")).is_err());
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(
            state.view().unwrap().notice.as_deref(),
            Some("nenhuma fonte")
        );
        assert!(state.stop_recording().is_err());
    }

    #[test]
    fn detected_recording_stores_app_and_stops_when_meeting_ends() {
        let (state, dir) = state("auto");
        let started = MeetingEvent::Started {
            app: "teams".into(),
        };
        // Default policy: ask.
        assert_eq!(
            state.on_meeting_event(&started).unwrap(),
            Action::Ask(AppKey::Teams)
        );
        let view = state.view().unwrap();
        assert_eq!(view.pending_ask.map(|a| a.app), Some(AppKey::Teams));
        assert_eq!(view.meeting.map(|m| m.label), Some("Microsoft Teams"));

        assert_eq!(
            state.answer_meeting(true).unwrap(),
            Action::Start(AppKey::Teams)
        );
        state
            .start_recording_as(Origin::detected(AppKey::Teams), || sine_sources(60))
            .unwrap();
        let view = state.view().unwrap();
        assert!(view.recording_auto);
        assert_eq!(view.recording_app.map(|a| a.app), Some(AppKey::Teams));
        assert!(view.pending_ask.is_none());

        assert_eq!(
            state.on_meeting_event(&MeetingEvent::Ended).unwrap(),
            Action::Stop
        );
        let recording = state.stop_recording().unwrap();
        assert_eq!(recording.meeting_app.as_deref(), Some("teams"));
        assert!(!state.view().unwrap().recording_auto);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manual_recording_dismisses_prompt_and_keeps_going_after_meeting() {
        let (state, dir) = state("manual");
        state
            .on_meeting_event(&MeetingEvent::Started { app: "zoom".into() })
            .unwrap();
        state.start_recording(|| sine_sources(60)).unwrap();
        assert!(state.view().unwrap().pending_ask.is_none());
        assert_eq!(
            state.on_meeting_event(&MeetingEvent::Ended).unwrap(),
            Action::None
        );
        let recording = state.stop_recording().unwrap();
        assert_eq!(recording.meeting_app, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_save_config_and_pat_and_validate() {
        let (state, dir) = state("config");
        assert!(state.uploader_config().unwrap().is_none());
        assert_eq!(state.settings().unwrap().pat_source, None);

        let mut input = settings_input(&state);
        input.web_url = "https://eclume.exemplo:8443".into();
        input.api_url = Some("  ".into());
        input.retention_days = Some(0);
        input.policies.insert(AppKey::Zoom, Policy::Auto);
        input.pat = Some("eclp_segredo".into());
        assert_eq!(state.save_settings(input).unwrap(), Action::None);

        let saved = Config::load(&dir.join("config.json"));
        assert_eq!(saved.web_url, "https://eclume.exemplo:8443");
        assert_eq!(saved.api_url, None);
        assert_eq!(saved.retention_days, Some(0));
        assert_eq!(saved.detection.policy(AppKey::Zoom), Policy::Auto);
        let settings = state.settings().unwrap();
        assert_eq!(settings.pat_source, Some(PatSource::File));
        assert!(!serde_json::to_string(&settings)
            .unwrap()
            .contains("eclp_segredo"));
        assert!(state.view().unwrap().notice.unwrap().contains("chaveiro"));
        let uploader = state.uploader_config().unwrap().unwrap();
        assert_eq!(uploader.pat, "eclp_segredo");
        assert_eq!(uploader.client_version, CLIENT_VERSION);

        let mut bad = settings_input(&state);
        bad.web_url = "sem-esquema".into();
        assert!(state.save_settings(bad).is_err());
        let mut bad_pat = settings_input(&state);
        bad_pat.pat = Some("ghp_x".into());
        assert!(state.save_settings(bad_pat).is_err());

        let mut clear = settings_input(&state);
        clear.clear_pat = true;
        state.save_settings(clear).unwrap();
        assert!(state.uploader_config().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_save_window_and_tray_recent_counts_separately() {
        let (state, dir) = state("recentes-bandeja");
        let view = state.settings().unwrap();
        assert_eq!((view.recent_count, view.tray_recent_count), (5, 1));

        let mut input = settings_input(&state);
        input.web_url = "https://eclume.exemplo:8443".into();
        input.tray_recent_count = Some(3);
        state.save_settings(input).unwrap();
        assert_eq!(state.tray_recent_count().unwrap(), 3);
        assert_eq!(state.recent_count().unwrap(), 5);
        let saved = Config::load(&dir.join("config.json"));
        assert_eq!((saved.recent_count, saved.tray_recent_count), (5, 3));

        let mut bad = settings_input(&state);
        bad.tray_recent_count = Some(11);
        assert!(state.save_settings(bad).is_err());
        assert_eq!(state.tray_recent_count().unwrap(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_change_shortcuts_and_show_registration() {
        let (state, dir) = state("atalhos");
        let view = state.settings().unwrap();
        assert_eq!(view.shortcuts.len(), 3);
        assert_eq!(view.shortcuts[0].keys, Shortcuts::default().record);
        assert_eq!(view.shortcuts[0].registration, None);

        let mut input = settings_input(&state);
        input.shortcuts = Some(Shortcuts {
            marker: " Ctrl+Alt+J ".into(),
            ..Shortcuts::default()
        });
        state.save_settings(input).unwrap();
        assert_eq!(state.shortcuts().unwrap().marker, "Ctrl+Alt+J");
        assert_eq!(
            Config::load(&dir.join("config.json")).shortcuts.marker,
            "Ctrl+Alt+J"
        );

        let mut repeated = settings_input(&state);
        repeated.shortcuts = Some(Shortcuts {
            note: "Ctrl+Alt+J".into(),
            marker: "Ctrl+Alt+J".into(),
            ..Shortcuts::default()
        });
        assert!(state.save_settings(repeated).is_err());
        assert_eq!(state.shortcuts().unwrap().note, Shortcuts::default().note);

        state
            .set_shortcuts_state(
                ShortcutMode::Global,
                Registrations::from([
                    (ShortcutAction::Record, Registration::Registered),
                    (ShortcutAction::Note, Registration::InUse),
                    (ShortcutAction::Marker, Registration::Unavailable),
                ]),
            )
            .unwrap();
        let problems: Vec<_> = state
            .settings()
            .unwrap()
            .shortcuts
            .into_iter()
            .map(|s| s.problem)
            .collect();
        assert_eq!(
            problems,
            [
                None,
                Some("Em uso por outro app"),
                Some("Indisponível nesta sessão")
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/import/tests/fixtures")
            .join(name)
    }

    #[test]
    fn import_converts_and_queues_as_upload() {
        let (state, dir) = state("importa");
        let cancel = state.begin_import().unwrap();
        assert!(state.begin_import().is_err(), "one import at a time");
        let mut steps = Vec::new();
        let recording = state
            .import_file(
                &fixture("tone.mp3"),
                1_789_826_520_000,
                RecordedAtSource::User,
                &cancel,
                |f| steps.push(f),
            )
            .unwrap();
        drop(state.import_guard());
        assert_eq!(steps.last(), Some(&1.0));
        assert_eq!(recording.status, Status::Pending);
        assert_eq!(recording.source, eclume_recorder::Source::Upload);
        assert_eq!(recording.kind, Kind::Meeting);
        assert_eq!(recording.recorded_at_source, RecordedAtSource::User);
        assert_eq!(recording.started_at, 1_789_826_520_000);
        assert_eq!(recording.original_name.as_deref(), Some("tone"));
        assert_eq!(recording.content_type, None);
        assert!(recording.path.starts_with(dir.join("gravacoes")));
        assert!(recording.path.exists());
        assert!(recording.duration_ms.unwrap() > 1_900);

        let avi = state
            .import_file(
                &fixture("tone.avi"),
                0,
                RecordedAtSource::FileMetadata,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert_eq!(avi.content_type.as_deref(), Some("video/x-msvideo"));
        assert_eq!(state.view().unwrap().counts.pending, 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_without_audio_or_cancelled_is_not_queued() {
        let (state, dir) = state("importa-nao");
        let err = state
            .import_file(
                &fixture("no-audio.mp4"),
                0,
                RecordedAtSource::User,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap_err();
        assert!(err.to_string().contains("não tem áudio"), "{err}");

        let cancel = state.begin_import().unwrap();
        state.cancel_import().unwrap();
        let err = state
            .import_file(
                &fixture("tone.wav"),
                0,
                RecordedAtSource::User,
                &cancel,
                |_| {},
            )
            .unwrap_err();
        assert!(err.is::<eclume_import::Cancelled>());
        drop(state.import_guard());
        assert!(state.begin_import().is_ok());
        assert!(state.recordings(10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn storage_counts_recordings_in_local_folder() {
        let (state, dir) = state("armazenamento");
        let empty = state.storage_info().unwrap();
        assert_eq!((empty.recordings, empty.bytes), (0, 0));
        assert_eq!(empty.dir, dir.join("gravacoes"));
        std::fs::create_dir_all(state.data_dir()).unwrap();
        std::fs::write(state.data_dir().join("a.ogg"), [0u8; 100]).unwrap();
        std::fs::write(state.data_dir().join("b.avi"), [0u8; 50]).unwrap();
        std::fs::write(state.data_dir().join("c.ogg.part"), [0u8; 999]).unwrap();
        let info = state.storage_info().unwrap();
        assert_eq!((info.recordings, info.bytes), (2, 150));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_include_factory_policy() {
        let (state, _dir) = state("fabrica");
        let apps = state.settings().unwrap().apps;
        assert_eq!(apps.len(), 8);
        let other = apps.iter().find(|a| a.app == AppKey::Outro).unwrap();
        assert_eq!(other.default_policy, Policy::Ignore);
        let teams = apps.iter().find(|a| a.app == AppKey::Teams).unwrap();
        assert_eq!(teams.default_policy, Policy::Ask);
    }

    #[test]
    fn synced_folder_enables_with_folder_and_missing_keeps_current() {
        let (state, dir) = state("espelho");
        let view = state.settings().unwrap();
        assert!(!view.mirror_enabled && view.mirror_transcripts);
        assert_eq!(view.mirror_dir, None);

        // Config rejects enabling without a folder, and nothing is saved.
        let mut without_folder = settings_input(&state);
        without_folder.mirror_enabled = Some(true);
        assert!(state.save_settings(without_folder).is_err());
        assert!(!state.settings().unwrap().mirror_enabled);

        let folder = dir.join("resumos");
        let mut input = settings_input(&state);
        input.mirror_enabled = Some(true);
        input.mirror_dir = Some(folder.to_string_lossy().into_owned());
        input.mirror_transcripts = Some(false);
        state.save_settings(input).unwrap();
        let mirror = state.mirror_config().unwrap();
        assert!(mirror.enabled && !mirror.transcripts);
        assert_eq!(mirror.dir.as_deref(), Some(folder.as_path()));
        assert_eq!(Config::load(&dir.join("config.json")).mirror, mirror);

        // Missing keeps the current value; "" clears the folder (rejected by config when enabled).
        state.save_settings(settings_input(&state)).unwrap();
        assert_eq!(state.mirror_config().unwrap(), mirror);
        let mut clear_folder = settings_input(&state);
        clear_folder.mirror_dir = Some(String::new());
        assert!(state.save_settings(clear_folder).is_err());
        let mut disable = settings_input(&state);
        disable.mirror_enabled = Some(false);
        disable.mirror_dir = Some(String::new());
        state.save_settings(disable).unwrap();
        assert_eq!(state.mirror_config().unwrap().dir, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn audio_selects_microphone_system_and_silence() {
        let (state, dir) = state("audio");
        assert_eq!(state.audio_choice().unwrap(), AudioChoice::default());
        let mut input = settings_input(&state);
        input.mic = Some("Jabra Evolve2 65".into());
        input.system_source = Some(config::SOURCE_NONE.into());
        input.note_silence_s = Some(8);
        input.language = Some("en".into());
        state.save_settings(input).unwrap();
        let view = state.settings().unwrap();
        assert_eq!(view.mic.as_deref(), Some("Jabra Evolve2 65"));
        assert_eq!(view.system_source, config::SOURCE_NONE);
        assert_eq!(view.note_silence_s, Some(8));
        assert_eq!(view.language.as_deref(), Some("en"));
        assert_eq!(state.view().unwrap().theme, "system");
        assert_eq!(state.language().unwrap().as_deref(), Some("en"));
        assert_eq!(
            state.audio_choice().unwrap().mic.device(),
            Some("Jabra Evolve2 65")
        );

        // Missing keeps the current value; "" restores the default; 0 means "Never".
        state.save_settings(settings_input(&state)).unwrap();
        assert_eq!(state.settings().unwrap().note_silence_s, Some(8));
        let mut input = settings_input(&state);
        input.mic = Some(String::new());
        input.note_silence_s = Some(0);
        input.language = Some(String::new());
        state.save_settings(input).unwrap();
        let view = state.settings().unwrap();
        assert_eq!(view.mic, None);
        assert_eq!(view.language, None);
        assert_eq!(view.note_silence_s, None);
        let mut bad = settings_input(&state);
        bad.note_silence_s = Some(5);
        assert!(state.save_settings(bad).is_err());

        // A selected output, then "None" for both sources, which config rejects.
        let mut input = settings_input(&state);
        input.system_source = Some("alsa_output.usb".into());
        state.save_settings(input).unwrap();
        let view = state.settings().unwrap();
        assert_eq!(view.system_source, "alsa_output.usb");
        let mut input = settings_input(&state);
        input.mic = Some(config::SOURCE_NONE.into());
        input.system_source = Some(config::SOURCE_NONE.into());
        let err = state.save_settings(input).unwrap_err();
        assert_eq!(err.to_string(), "Escolha ao menos uma fonte de áudio");
        let mut input = settings_input(&state);
        input.mic = Some(config::SOURCE_NONE.into());
        input.system_source = Some(String::new());
        state.save_settings(input).unwrap();
        let choice = state.audio_choice().unwrap();
        assert_eq!(choice.mic, SourceChoice::Off);
        assert_eq!(choice.system, SourceChoice::Auto);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn level_test_shows_meter_finishes_on_its_own_and_stops_immediately() {
        let (state, _dir) = state("teste-nivel");
        assert!(state.source_test_meter().unwrap().is_none());
        /// Tone arriving at clock pace, like a real microphone.
        struct Paced(SineSource);
        impl AudioSource for Paced {
            fn sample_rate(&self) -> u32 {
                self.0.sample_rate()
            }
            fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
                std::thread::sleep(Duration::from_millis(10));
                self.0.read(timeout)
            }
        }
        let open = || -> Result<Box<dyn AudioSource>> {
            Ok(Box::new(Paced(SineSource::new(
                48_000,
                440.0,
                0.5,
                Duration::from_secs(5),
            ))))
        };
        state
            .start_source_test(open, Duration::from_millis(400))
            .unwrap();
        let mut heard = false;
        for _ in 0..200 {
            match state.source_test_meter().unwrap() {
                Some(levels) => heard |= levels.iter().any(|&l| l > 0.5),
                None if heard => break,
                None => {}
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(heard, "the meter should rise with the tone");
        std::thread::sleep(Duration::from_millis(600));
        assert!(state.source_test_meter().unwrap().is_none());

        // "Stop" ends early and releases the source promptly.
        let (tx, rx) = std::sync::mpsc::channel();
        let open = move || -> Result<Box<dyn AudioSource>> {
            Ok(Box::new(Notify(
                Paced(SineSource::new(48_000, 440.0, 0.5, Duration::from_secs(60))),
                tx,
            )))
        };
        /// Notifies when the source is dropped, meaning the test released the device.
        struct Notify(Paced, std::sync::mpsc::Sender<()>);
        impl AudioSource for Notify {
            fn sample_rate(&self) -> u32 {
                self.0.sample_rate()
            }
            fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
                self.0.read(timeout)
            }
        }
        impl Drop for Notify {
            fn drop(&mut self) {
                let _ = self.1.send(());
            }
        }
        state.start_source_test(open, SOURCE_TEST).unwrap();
        for _ in 0..200 {
            if state
                .source_test_meter()
                .unwrap()
                .is_some_and(|levels| levels.iter().any(|&l| l > 0.5))
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        state.stop_source_test().unwrap();
        assert!(state.source_test_meter().unwrap().is_none());
        rx.recv_timeout(Duration::from_secs(1))
            .expect("stopping should close the source well before 10 s");
    }

    #[test]
    fn updated_to_x_until_dismissed_and_notified_once() {
        let dir =
            std::env::temp_dir().join(format!("eclume-state-atualizado-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let config_dir = dir.join("config");
        Config {
            last_version: Some("0.0.9".into()),
            pending_update: Some(PendingUpdate {
                version: CURRENT_VERSION.into(),
                notes: Some("Nova nota e Importar arquivo".into()),
            }),
            ..Config::default()
        }
        .save(&config_dir.join("config.json"))
        .unwrap();

        let state = AppState::open(&dir.join("dados"), &config_dir).unwrap();
        let updated = state.view().unwrap().updated.unwrap();
        assert_eq!(updated.version, CURRENT_VERSION);
        assert_eq!(
            updated.notes.as_deref(),
            Some("Nova nota e Importar arquivo")
        );
        assert!(state.take_update_notification().unwrap().is_some());
        assert!(state.take_update_notification().unwrap().is_none());
        drop(state);

        // Reopened without dismissing the notice: it stays in the window without notifying again.
        let state = AppState::open(&dir.join("dados"), &config_dir).unwrap();
        assert!(state.view().unwrap().updated.is_some());
        assert!(state.take_update_notification().unwrap().is_none());
        state.dismiss_update_notice().unwrap();
        assert!(state.view().unwrap().updated.is_none());
        let saved = Config::load(&config_dir.join("config.json"));
        assert_eq!(saved.pending_update, None);
        assert_eq!(saved.last_version.as_deref(), Some(CURRENT_VERSION));

        state
            .record_pending_update("9.9.9", Some("  ".into()))
            .unwrap();
        let saved = Config::load(&config_dir.join("config.json"));
        assert_eq!(
            saved.pending_update,
            Some(PendingUpdate {
                version: "9.9.9".into(),
                notes: None
            })
        );
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_policy_dismisses_pending_prompt() {
        let (state, dir) = state("politica");
        state
            .on_meeting_event(&MeetingEvent::Started { app: "meet".into() })
            .unwrap();
        let mut input = settings_input(&state);
        input.policies.insert(AppKey::Meet, Policy::Ignore);
        assert_eq!(state.save_settings(input).unwrap(), Action::Dismiss);
        assert!(state.view().unwrap().pending_ask.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn guard_clears_each_flag_even_on_panic() {
        let (state, _dir) = state("guardas");
        let panics = |work: &dyn Fn()| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).unwrap_err();
        };
        panics(&|| {
            let _syncing = state.syncing();
            assert_eq!(state.status().unwrap(), AppStatus::Syncing);
            panic!("sync failed");
        });
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        panics(&|| {
            let _running = state.mirror_running();
            assert!(state.mirror_status().unwrap().running);
            panic!("folder failed");
        });
        assert!(!state.mirror_status().unwrap().running);
        state.begin_import().unwrap();
        panics(&|| {
            let _importing = state.import_guard();
            panic!("decoder failed");
        });
        assert!(state.begin_import().is_ok());
    }

    #[test]
    fn syncing_state_and_sync_notice() {
        let (state, _dir) = state("sync");
        let syncing = state.syncing();
        assert_eq!(state.status().unwrap(), AppStatus::Syncing);
        drop(syncing);
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(AppStatus::Syncing.label(), "Sincronizando");
        state.set_sync_notice(Some("sem PAT".into())).unwrap();
        assert_eq!(
            state.view().unwrap().sync_notice.as_deref(),
            Some("sem PAT")
        );
        assert_eq!(state.retention_days().unwrap(), Some(7));
        assert!(state.detection_enabled().unwrap());
    }

    #[test]
    fn first_run_sign_in_and_sign_out() {
        use crate::account::tests::{
            body, credential, info, pem, ScriptNet, Shared, CA_SHA256, SECRET, URL,
        };

        let (state, dir) = state("conta");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(state.view().unwrap().connection, Connection::FirstRun);
        let err = state
            .sign_in(
                &Shared(std::sync::Arc::new(ScriptNet::default())),
                Login::Code("K7Q4MX"),
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "Escolha o servidor antes de entrar");

        let net = std::sync::Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                )
                .expect(
                    "verificado POST /api/v1/devices/login",
                    body(201, credential()),
                )
                .expect(
                    "verificado GET /api/v1/me",
                    body(
                        200,
                        serde_json::json!({
                            "user": {"email": "ana@exemplo.com.br", "locale": "pt-PT"},
                            "auth": {"method": "device", "token_id": "t-1"}
                        }),
                    ),
                ),
        );
        let shared = Shared(std::sync::Arc::clone(&net));
        let server = state.prepare_server(&shared, URL, Some(CA_SHA256)).unwrap();
        assert_eq!(server.name, "eclume");
        // Outside the installer, the person checks the fingerprint before signing in.
        state.confirm_server(URL, Some(CA_SHA256)).unwrap();
        state
            .sign_in(
                &shared,
                Login::Password {
                    email: "ana@exemplo.com.br",
                    password: "segredo",
                },
            )
            .unwrap();
        assert!(net.done());

        let view = state.view().unwrap();
        assert_eq!(view.connection, Connection::Account);
        assert_eq!(view.locale, Locale::PtBr);
        assert_eq!(
            Config::load(&state.config_path).account_locale.as_deref(),
            Some("pt-BR")
        );
        assert_eq!(view.account.unwrap().email, "ana@exemplo.com.br");
        assert_eq!(view.web_url, URL);
        let pinned = dir.join(eclume_sync::pin::PINNED_FILE);
        assert_eq!(
            state.pinned_ca().unwrap(),
            Some((URL.to_string(), pinned.clone()))
        );
        let uploader = state.uploader_config().unwrap().unwrap();
        assert_eq!(uploader.pat, SECRET);
        // The CA pinned on first run is the only one sync trusts.
        assert_eq!(uploader.trust, TrustMode::Pinned(pinned.clone()));
        assert_eq!(state.trust().unwrap(), TrustMode::Pinned(pinned));
        let saved = Config::load(&dir.join("config.json"));
        assert_eq!(saved.account.unwrap().token_id.as_deref(), Some("t-1"));

        // CA changed: sync stops and the window returns to first run.
        state.mark_ca_changed().unwrap();
        assert!(state.uploader_config().unwrap().is_none());
        let view = state.view().unwrap();
        assert_eq!(view.connection, Connection::FirstRun);
        assert_eq!(
            view.sync_notice.as_deref(),
            Some("O certificado do servidor mudou")
        );

        // Signing out deletes the credential, but keeps the queue and server.
        state.sign_out().unwrap();
        assert_eq!(Config::load(&state.config_path).account_locale, None);
        assert_eq!(state.view().unwrap().connection, Connection::FirstRun);
        assert!(state.uploader_config().unwrap().is_none());
        assert_eq!(Config::load(&dir.join("config.json")).account, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn existing_pat_users_keep_syncing() {
        let (state, dir) = state("pat-antigo");
        let mut input = settings_input(&state);
        input.pat = Some("eclp_antigo".into());
        state.save_settings(input).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.connection, Connection::PersonalToken);
        assert_eq!(view.account, None);
        assert_eq!(
            state.settings().unwrap().connection,
            Connection::PersonalToken
        );
        assert_eq!(state.pinned_ca().unwrap(), None);
        let mut clear = settings_input(&state);
        clear.clear_pat = true;
        state.save_settings(clear).unwrap();
        assert_eq!(state.view().unwrap().connection, Connection::FirstRun);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn account_locale_refresh_and_connection_test_store_server_preference() {
        use crate::account::tests::{body, ScriptNet, Shared, CA};

        let (state, dir, _) = opened_with_pinned("locale-refresh", CA);
        state.report_system_locale("en").unwrap();
        let net = Arc::new(
            ScriptNet::default()
                .expect(
                    "verificado GET /api/v1/me",
                    body(
                        200,
                        serde_json::json!({
                            "user": {"email": "user@example.org", "locale": "pt_BR"},
                            "auth": {"method": "device", "token_id": "t-1"}
                        }),
                    ),
                )
                .expect(
                    "verificado GET /api/v1/me",
                    body(
                        200,
                        serde_json::json!({
                            "user": {"email": "user@example.org", "locale": "en-US"},
                            "auth": {"method": "device", "token_id": "t-1"}
                        }),
                    ),
                )
                .expect(
                    "verificado GET /api/v1/me",
                    Err(anyhow!("network unavailable")),
                ),
        );
        let shared = Shared(Arc::clone(&net));
        state.refresh_account_locale(&shared).unwrap();
        assert_eq!(state.locale().unwrap(), Locale::PtBr);
        assert_eq!(
            Config::load(&state.config_path).account_locale.as_deref(),
            Some("pt-BR")
        );
        assert_eq!(
            state.test_connection(&shared).unwrap().email,
            "user@example.org"
        );
        assert_eq!(
            Config::load(&state.config_path).account_locale.as_deref(),
            Some("en")
        );
        assert!(state.refresh_account_locale(&shared).is_err());
        assert_eq!(state.locale().unwrap(), Locale::En);
        assert!(net.done());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sign_in_succeeds_when_account_locale_refresh_fails() {
        use crate::account::tests::{body, credential, ScriptNet, Shared, URL};

        let (state, dir) = state("locale-sign-in-failure");
        state.inner().unwrap().prepared = Some(PreparedServer {
            name: "eclume".into(),
            url: URL.into(),
            ca_sha256: None,
            trusted_by: account::TrustedBy::System,
            ca_path: None,
            confirmed: true,
        });
        let net = Arc::new(
            ScriptNet::default()
                .expect(
                    "verificado POST /api/v1/devices/login",
                    body(201, credential()),
                )
                .expect(
                    "verificado GET /api/v1/me",
                    Err(anyhow!("network unavailable")),
                ),
        );
        state
            .sign_in(
                &Shared(Arc::clone(&net)),
                Login::Password {
                    email: "user@example.org",
                    password: "password",
                },
            )
            .unwrap();
        assert!(net.done());
        assert_eq!(state.view().unwrap().connection, Connection::Account);
        assert_eq!(Config::load(&state.config_path).account_locale, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Opens state with an account, the credential in a file, and `pem` as the pinned CA.
    fn opened_with_pinned(name: &str, pem: &str) -> (AppState, PathBuf, PathBuf) {
        use crate::account::tests::{SECRET, URL};
        use eclume_sync::pat::PAT_FILE;

        let dir = std::env::temp_dir().join(format!("eclume-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pinned = dir.join(eclume_sync::pin::PINNED_FILE);
        std::fs::write(&pinned, pem).unwrap();
        std::fs::write(dir.join(PAT_FILE), SECRET).unwrap();
        Config {
            web_url: URL.into(),
            ca_path: Some(pinned.clone()),
            account: Some(Account {
                email: "ana@exemplo.com.br".into(),
                token_id: Some("t-1".into()),
                server_name: None,
            }),
            ..Config::default()
        }
        .save(&dir.join("config.json"))
        .unwrap();
        let pat = PatStore::with_backend(dir.join(PAT_FILE), Box::new(NoKeyring), None);
        let state = AppState::open_with(&dir, &dir, pat).unwrap();
        (state, dir, pinned)
    }

    #[test]
    fn pinned_ca_with_extra_certificate_requires_sign_in_on_open() {
        use crate::account::tests::CA;

        let other = include_str!("../../../server/tests/fixtures/ca-test.pem");
        let (state, dir, pinned) = opened_with_pinned("ca-a-mais", &format!("{CA}{other}"));
        let view = state.view().unwrap();
        assert_eq!(view.connection, Connection::FirstRun);
        assert_eq!(
            view.sync_notice.as_deref(),
            Some(eclume_sync::pin::CA_TRIMMED)
        );
        assert!(state.uploader_config().unwrap().is_none());
        assert!(!dir.join(eclume_sync::pat::PAT_FILE).exists());
        assert_eq!(Config::load(&dir.join("config.json")).account, None);
        assert_eq!(std::fs::read(&pinned).unwrap(), CA.as_bytes());
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();

        // With just one certificate, nothing changes and nobody needs to sign in again.
        let (state, dir, pinned) = opened_with_pinned("ca-unica", CA);
        let view = state.view().unwrap();
        assert_eq!(view.connection, Connection::Account);
        assert_eq!(view.sync_notice, None);
        assert!(state.uploader_config().unwrap().is_some());
        assert_eq!(std::fs::read(&pinned).unwrap(), CA.as_bytes());
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
