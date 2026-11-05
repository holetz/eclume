//! Core of eclume's mobile app, independent of Tauri: the same object serves the UI (through the
//! Tauri commands) and the system (through the Android plugin's JNI bridge), because the Activity
//! can die and come back while the service records, and WorkManager calls the sync with no Activity
//! at all. Architecture in docs/standards/code/mobile-app.md.
//!
//! The [`Core`] lives in a process-wide `OnceLock<Mutex<Core>>` ([`init`], [`global`]). What talks
//! to the network (the probe, the sync, the authenticated reads) runs **outside** the lock: the core
//! prepares the plan, the call runs without it and the result comes back through a short method, so
//! the UI keeps reading the state every 250 ms.
//!
//! The serialized names of the structs the UI and the plugin read keep their original (pt-BR)
//! names through `#[serde(rename)]`: they are the wire format of the bridge.

pub mod config;
pub mod connection;
pub mod estimates;
pub mod network;
pub mod session;
pub mod sync;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use anyhow::{anyhow, Context, Result};
use eclume_recorder::session::RecorderConfig;
use eclume_recorder::{now_ms, AudioSource, Marker, Queue, QueuedRecording, Source, Status};
use eclume_sync::transport::REQUEST_TIMEOUT;
use serde::Serialize;

use crate::config::{Config, Dirs, Quality, Server};
use crate::connection::{Connection, ConnectionState, RealTransports, Transports};
use crate::estimates::{Battery, BatteryReading, Warnings};
use crate::network::{Network, NetworkState, Probe, PROBE_TIMEOUT};
use crate::session::{Session, SessionState};
use crate::sync::{Meter, OnServer, Step, Wait};

/// The prefix of the Android app's `client_version` and user agent.
pub const CLIENT_PREFIX: &str = "eclume-android";

/// `eclume-android/<version>`: the upload's `capture.client_version` and the user agent.
pub fn client_version(version: &str) -> String {
    format!("{CLIENT_PREFIX}/{version}")
}

/// The languages the saved-recording sheet offers, besides the account default (labels are UI
/// copy).
const LANGUAGES: [(&str, &str); 4] = [
    ("auto", "Detectar automaticamente"),
    ("pt", "Português"),
    ("es", "Español"),
    ("en", "English"),
];

/// The name of a language from the short list (`pt-BR` becomes `pt`); outside it, the code itself.
fn language_name(language: &str) -> &str {
    let base = language.split('-').next().unwrap_or(language);
    LANGUAGES
        .iter()
        .find(|(value, _)| *value == base)
        .map_or(language, |(_, label)| label)
}

/// One option of the sheet's language picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LanguageOption {
    #[serde(rename = "valor")]
    pub value: String,
    #[serde(rename = "rotulo")]
    pub label: String,
}

/// The saved-recording sheet, opened after stopping.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Sheet {
    pub id: String,
    /// Recording start, in Unix ms (the suggested title).
    #[serde(rename = "iniciada_em")]
    pub started_at: i64,
    #[serde(rename = "duracao_ms")]
    pub duration_ms: i64,
    #[serde(rename = "marcadores")]
    pub markers: usize,
}

/// Why the recording stopped without being asked; the service shows the reason in the
/// recording-stopped notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// Less than 5 min of recording fits in the free space.
    #[serde(rename = "sem_espaco")]
    NoSpace,
    /// The audio source ended (or the recording failed) on its own.
    #[serde(rename = "fonte_encerrada")]
    SourceEnded,
}

impl StopReason {
    /// The warning's short text (notification copy).
    pub fn text(self) -> &'static str {
        match self {
            Self::NoSpace => "pouco espaço livre",
            Self::SourceEnded => "o microfone parou",
        }
    }
}

/// Everything the UI draws: it is a function of this state.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AppState {
    #[serde(rename = "conexao")]
    pub connection: ConnectionState,
    #[serde(rename = "rede")]
    pub network: NetworkState,
    #[serde(rename = "sessao")]
    pub session: Option<SessionState>,
    #[serde(rename = "folha")]
    pub sheet: Option<Sheet>,
    /// Recordings that have not reached the server yet.
    #[serde(rename = "pendentes")]
    pub pending: u32,
    #[serde(rename = "avisos")]
    pub warnings: Warnings,
    /// "cerca de 9 h" of recording in the free space.
    #[serde(rename = "espaco_livre")]
    pub free_space: Option<String>,
    #[serde(rename = "versao")]
    pub version: String,
}

/// How a local recording shows in "Neste celular".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Badge {
    #[serde(rename = "gravando")]
    Recording,
    #[serde(rename = "aguardando")]
    Waiting,
    #[serde(rename = "sincronizando")]
    Syncing,
    #[serde(rename = "sincronizada")]
    Synced,
    #[serde(rename = "interrompida")]
    Interrupted,
    #[serde(rename = "falhou")]
    Failed,
}

/// A recording on the phone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalRecording {
    pub id: String,
    #[serde(rename = "titulo")]
    pub title: Option<String>,
    /// The title the server gave the recording (queue v5); the list shows it when there is no local
    /// title.
    #[serde(rename = "titulo_do_servidor")]
    pub server_title: Option<String>,
    #[serde(rename = "iniciada_em")]
    pub started_at: i64,
    #[serde(rename = "duracao_ms")]
    pub duration_ms: Option<i64>,
    pub bytes: Option<i64>,
    #[serde(rename = "marcadores")]
    pub markers: usize,
    #[serde(rename = "selo")]
    pub badge: Badge,
    pub remote_id: Option<String>,
    /// The local file was already deleted (it stays only on the server).
    #[serde(rename = "apagada")]
    pub purged: bool,
    #[serde(rename = "tipo_de_agenda")]
    pub agenda_type: Option<String>,
    #[serde(rename = "ultimo_erro")]
    pub last_error: Option<String>,
}

/// A recording's detail: the row, the markers, the server steps and the queue wait (cached off the
/// network).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalDetail {
    #[serde(rename = "gravacao")]
    pub recording: LocalRecording,
    #[serde(rename = "caminho")]
    pub path: Option<String>,
    #[serde(rename = "marcadores")]
    pub markers: Vec<Marker>,
    #[serde(rename = "etapas")]
    pub steps: Option<Vec<Step>>,
    #[serde(rename = "espera")]
    pub wait: Option<Wait>,
    /// The recording's page on eclume web (`/gravacoes/<server id>`), once uploaded.
    #[serde(rename = "endereco_na_web")]
    pub web_address: Option<String>,
}

/// The settings the Settings screen edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Preferences {
    pub sync_auto: bool,
    #[serde(rename = "qualidade")]
    pub quality: Quality,
    #[serde(rename = "excluir_sincronizadas")]
    pub delete_synced: bool,
}

/// What the sync needs, built under the lock and used outside it.
pub struct SyncPlan {
    uploader: eclume_sync::HttpUploader,
    queue: Arc<Mutex<Queue>>,
    meter: Arc<Meter>,
    busy: Arc<AtomicBool>,
}

/// An authenticated read to make outside the lock.
pub struct ReadPlan {
    transport: Arc<dyn eclume_sync::transport::Transport>,
    server: Server,
    token: String,
    /// The pinned CA, next to which the probe stores the next announced root.
    ca: std::path::PathBuf,
}

/// The stored next root and the transport pinned to it: the switch checked outside the lock.
pub struct NextRootPlan {
    transport: Arc<dyn eclume_sync::transport::Transport>,
    server: Server,
    root: eclume_sync::pin::RootCa,
}

/// The app's core.
pub struct Core {
    dirs: Dirs,
    version: String,
    config: Config,
    connection: Connection,
    network: Network,
    session: Session,
    queue: Arc<Mutex<Queue>>,
    meter: Arc<Meter>,
    syncing: Arc<AtomicBool>,
    battery: Battery,
    free_space: Option<u64>,
    visible: bool,
    sheet: Option<Sheet>,
    steps: HashMap<String, OnServer>,
    /// The new version from `movel.json`, if any.
    update: Option<sync::Manifest>,
    /// The next `?since=` of the server titles read, and when it ran.
    titles_since: Option<String>,
    titles_read_at: i64,
}

/// At most how often the server titles are read in the network cycle.
pub const TITLES_INTERVAL_MS: i64 = 60 * 1_000;

/// How often `movel.json` is read, on eclume's network.
pub const UPDATE_INTERVAL_MS: i64 = 24 * 60 * 60 * 1_000;

/// Rewrites a `ca.pem` with extra certificates keeping only the first: the first connection may
/// have been intercepted, so the credential is deleted and the sign-in screen says why. A failure
/// stays in the log.
fn trim_ca(dirs: &Dirs, connection: &mut Connection) {
    match eclume_sync::pin::trim_saved(&dirs.ca()) {
        Ok(0) => {}
        Ok(_) => {
            log::warn!("{}", eclume_sync::pin::CA_TRIMMED);
            if let Err(err) = connection.credential_lost_because(eclume_sync::pin::CA_TRIMMED) {
                log::warn!("failed to delete the credential: {err:#}");
            }
        }
        Err(err) => log::warn!("failed to check the pinned CA: {err:#}"),
    }
}

impl Core {
    /// Opens the core: config, queue and the recovery of what a crash left behind.
    pub fn open(dirs: Dirs, version: &str, transports: Arc<dyn Transports>) -> Result<Self> {
        std::fs::create_dir_all(&dirs.data)
            .with_context(|| format!("falha ao criar {}", dirs.data.display()))?;
        let config = Config::load(&dirs.config())?;
        let queue = Arc::new(Mutex::new(Queue::open(&dirs.queue())?));
        Session::recover(&queue)?;
        let mut connection = Connection::new(dirs.clone(), transports);
        if config.server.is_some() && dirs.ca().exists() {
            trim_ca(&dirs, &mut connection);
        }
        Ok(Self {
            connection,
            dirs,
            version: version.to_string(),
            config,
            network: Network::default(),
            session: Session::default(),
            queue,
            meter: Arc::new(Meter::default()),
            syncing: Arc::new(AtomicBool::new(false)),
            battery: Battery::default(),
            free_space: None,
            visible: true,
            sheet: None,
            steps: HashMap::new(),
            update: None,
            titles_since: None,
            titles_read_at: 0,
        })
    }

    pub fn dirs(&self) -> &Dirs {
        &self.dirs
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn queue(&self) -> &Arc<Mutex<Queue>> {
        &self.queue
    }

    fn lock_queue(&self) -> Result<MutexGuard<'_, Queue>> {
        self.queue
            .lock()
            .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
    }

    /// The device name (`Build.MODEL`), from the plugin on open.
    pub fn set_device(&mut self, name: &str) -> Result<()> {
        let name = name.trim();
        if !name.is_empty() && self.config.device_name != name {
            self.config.device_name = name.to_string();
            self.save_config()?;
        }
        Ok(())
    }

    fn save_config(&self) -> Result<()> {
        self.config.save(&self.dirs.config())
    }

    fn bitrate(&self) -> i32 {
        self.config.quality.bitrate()
    }

    pub fn state(&self) -> Result<AppState> {
        let mut network = self.network.clone();
        if self.syncing.load(Ordering::Acquire) {
            network.sync_progress(self.meter.progress());
        }
        let pending = self.lock_queue()?.counts()?.unsynced();
        let synced = if self.free_space.is_some() {
            sync::synced_bytes(&self.queue)?
        } else {
            0
        };
        let bitrate = self.bitrate();
        Ok(AppState {
            connection: self.connection.state(&self.config),
            network: network.state(),
            session: self.session.state(&self.queue)?,
            sheet: self.sheet.clone(),
            pending,
            warnings: Warnings {
                storage: self
                    .free_space
                    .and_then(|free| estimates::storage_warning(free, bitrate, synced)),
                battery: if self.session.is_recording() {
                    estimates::battery_warning(&self.battery)
                } else {
                    None
                },
            },
            free_space: self
                .free_space
                .map(|free| estimates::about(estimates::seconds_that_fit(free, bitrate))),
            version: self.version.clone(),
        })
    }

    // --- connection -----------------------------------------------------------------------------

    pub fn connect_discovered(&mut self, url: &str, ca: Option<&str>) -> Result<()> {
        self.connection.connect_discovered(url, ca)
    }

    pub fn connect_address(&mut self, address: &str) -> Result<()> {
        self.connection.connect_address(address)
    }

    pub fn trust_ca(&mut self) -> Result<()> {
        if self.connection.trust_ca(&mut self.config)? {
            self.network.credential_restored();
        }
        Ok(())
    }

    pub fn cancel_ca(&mut self) {
        self.connection.cancel_ca();
    }

    pub fn sign_in(&mut self, email: &str, password: &str) -> Result<()> {
        self.connection.sign_in(&self.config, email, password)?;
        self.network.credential_restored();
        Ok(())
    }

    pub fn pair(&mut self, qr_text: &str) -> Result<()> {
        if self.connection.pair(&mut self.config, qr_text)? {
            self.network.credential_restored();
        }
        Ok(())
    }

    /// "Sair e esquecer o servidor". The waiting recordings stay and upload to the next server.
    pub fn sign_out(&mut self) -> Result<()> {
        self.connection.sign_out(&mut self.config)?;
        let wifi = self.network.unmetered_wifi();
        self.network = Network::default();
        self.network.wifi_changed(wifi);
        self.steps.clear();
        Ok(())
    }

    // --- network and sync -----------------------------------------------------------------------

    /// The plugin reported the unmetered Wi-Fi (the system callback, right away, or the device
    /// reading). Without it, the running sync stops at the next request. Returns whether the probe
    /// must run again.
    pub fn network_changed(&mut self, unmetered_wifi: bool) -> bool {
        if !unmetered_wifi {
            self.meter.interrupt();
        }
        let changed = self.network.wifi_changed(unmetered_wifi);
        if changed {
            log::info!("unmetered Wi-Fi: {unmetered_wifi}");
        }
        changed
    }

    /// Whether the UI is visible (the app loop slows down with it hidden).
    pub fn visible(&self) -> bool {
        self.visible
    }

    /// The current recording's microphone and silence, without reading the queue (see
    /// [`Session::signals`]).
    pub fn session_signals(&self) -> Option<(crate::session::MicState, bool)> {
        self.session.signals()
    }

    pub fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
    }

    /// The paired server, the token and the transport pinned with the given timeout; `None` with
    /// no connection.
    fn read_plan(&self, timeout: std::time::Duration) -> Result<Option<ReadPlan>> {
        let (Some(server), Some(token)) = (self.config.server.clone(), self.connection.token()?)
        else {
            return Ok(None);
        };
        Ok(Some(ReadPlan {
            transport: self.connection.transport(timeout)?,
            server,
            token,
            ca: self.dirs.ca(),
        }))
    }

    /// The probe to run (`force`: opening the app, a network change, stopping, "Sincronizar
    /// agora").
    pub fn prepare_probe(&self, now_ms: i64, force: bool) -> Result<Option<ReadPlan>> {
        let should = if force {
            self.network.can_probe()
        } else {
            self.network.needs_probe(now_ms, self.visible)
        };
        if !should {
            return Ok(None);
        }
        self.read_plan(PROBE_TIMEOUT)
    }

    /// After a `CaChanged` probe: the stored next root, to check whether the server switched to it;
    /// `None` with no server or no next root.
    pub fn prepare_next_root(&self) -> Result<Option<NextRootPlan>> {
        let Some(server) = self.config.server.clone() else {
            return Ok(None);
        };
        Ok(self
            .connection
            .next_root(PROBE_TIMEOUT)?
            .map(|(root, transport)| NextRootPlan {
                transport,
                server,
                root,
            }))
    }

    /// The checked next root becomes the pinned one (see [`connection::Connection::promote_next`]).
    pub fn promote_next(&mut self, plan: &NextRootPlan) -> Result<()> {
        self.connection.promote_next(&plan.root, &mut self.config)
    }

    pub fn record_probe(&mut self, now_ms: i64, probe: Probe) {
        let before = self.network.state();
        self.network.record_probe(now_ms, probe);
        if self.network.state() != before {
            log::info!("probe {probe:?}: network {:?}", self.network.state());
        }
    }

    /// The system stopped the sync work (the worker's `onStopped`): the upload stops at the next
    /// request and the recording goes back to the queue without spending an attempt.
    pub fn interrupt_sync(&self) {
        self.meter.interrupt();
    }

    /// The recordings waiting for the sync and how many bytes they add up to.
    pub fn pending(&self) -> Result<(u32, u64)> {
        let queue = self.lock_queue()?;
        queue.retry_due(now_ms(), sync::MAX_ATTEMPTS)?;
        let pending = queue.by_status(Status::Pending)?;
        let bytes = pending
            .iter()
            .filter_map(|rec| rec.bytes)
            .map(|b| u64::try_from(b).unwrap_or(0))
            .sum();
        Ok((u32::try_from(pending.len()).unwrap_or(u32::MAX), bytes))
    }

    /// The sync to run: on eclume's network, with no other running, with something pending and
    /// (without `now`) with the automatic sync on. On the network, the previous interruption stops
    /// counting.
    pub fn prepare_sync(&self, now: bool) -> Result<Option<SyncPlan>> {
        if !self.network.on_network()
            || (!now && !self.config.sync_auto)
            || self.syncing.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        {
            let queue = self.lock_queue()?;
            if now {
                // "Sincronizar agora" does not wait for the failures' backoff.
                queue.retry_failed(sync::MAX_ATTEMPTS)?;
            }
            queue.retry_due(now_ms(), sync::MAX_ATTEMPTS)?;
            if queue.counts()?.pending == 0 {
                return Ok(None);
            }
        }
        let Some(read) = self.read_plan(REQUEST_TIMEOUT)? else {
            return Ok(None);
        };
        let uploader = sync::uploader(
            read.transport,
            Arc::clone(&self.meter),
            &read.server,
            &read.token,
            Arc::clone(&self.queue),
            &client_version(&self.version),
            &self.config.device_name,
        )?;
        self.syncing.store(true, Ordering::Release);
        // Under the core's lock: a "left the network" after this point interrupts this pass.
        self.meter.resume();
        Ok(Some(SyncPlan {
            uploader,
            queue: Arc::clone(&self.queue),
            meter: Arc::clone(&self.meter),
            busy: Arc::clone(&self.syncing),
        }))
    }

    /// After the sync: a 401 leads to sign-in, and the retention deletes what expired.
    pub fn finish_sync(&mut self, credential_refused: bool) -> Result<()> {
        if credential_refused {
            self.credential_lost()?;
        }
        if self.config.delete_synced {
            sync::retain(&self.queue, now_ms(), self.config.retention_days)?;
        }
        Ok(())
    }

    /// The server refused the credential (401 on any authenticated call): back to sign-in.
    pub fn credential_lost(&mut self) -> Result<()> {
        self.connection.credential_lost()?;
        self.network.credential_lost();
        Ok(())
    }

    pub fn prepare_types(&self) -> Result<Option<ReadPlan>> {
        if !self.network.on_network() {
            return Ok(None);
        }
        self.read_plan(REQUEST_TIMEOUT)
    }

    pub fn store_account_language(&mut self, language: String) -> Result<()> {
        if self.config.account_language.as_deref() != Some(language.as_str()) {
            self.config.account_language = Some(language);
            self.save_config()?;
        }
        Ok(())
    }

    /// The saved-recording sheet's language options: the named account default, Detect and the
    /// short list. The empty value is the default (the recording uploads without a language and the
    /// account's applies).
    pub fn language_options(&self) -> Vec<LanguageOption> {
        let default = match self.config.account_language.as_deref() {
            Some(language) => format!("Padrão da conta: {}", language_name(language)),
            None => "Padrão da conta".to_string(),
        };
        std::iter::once(LanguageOption {
            value: String::new(),
            label: default,
        })
        .chain(LANGUAGES.iter().map(|(value, label)| LanguageOption {
            value: (*value).to_string(),
            label: (*label).to_string(),
        }))
        .collect()
    }

    pub fn store_types(&mut self, types: Vec<config::AgendaType>) -> Result<()> {
        if self.config.agenda_types != types {
            self.config.agenda_types = types;
            self.save_config()?;
        }
        Ok(())
    }

    // --- session --------------------------------------------------------------------------------

    /// Starts recording the given source (the microphone).
    pub fn record(&mut self, source: Box<dyn AudioSource>) -> Result<String> {
        let config = RecorderConfig {
            bitrate: self.bitrate(),
            source: Source::Mobile,
            ask_details: true,
            ..RecorderConfig::new(self.dirs.recordings())
        };
        self.battery.restart();
        if let Some(reading) = self.battery.last() {
            self.battery.record(BatteryReading {
                at_ms: now_ms(),
                ..reading
            });
        }
        let id = self.session.start(&config, &self.queue, source)?;
        self.sheet = None;
        Ok(id)
    }

    pub fn pause(&self) -> Result<()> {
        self.session.pause()
    }

    pub fn resume(&self) -> Result<()> {
        self.session.resume()
    }

    pub fn mark(&self, note: Option<&str>) -> Result<Marker> {
        self.session.mark(&self.queue, note)
    }

    /// Watches the current recording's microphone (drop and return markers); the app loop calls
    /// it.
    pub fn watch(&mut self) -> Result<()> {
        self.session.watch(&self.queue)
    }

    /// The system muted (`true`) or gave back the capture, through `AudioRecordingCallback`.
    pub fn set_muted(&mut self, muted: bool) -> Result<()> {
        self.session.set_muted(&self.queue, muted)
    }

    pub fn annotate_marker(&self, client_id: &str, note: Option<&str>) -> Result<Marker> {
        Session::annotate(&self.queue, client_id, note)
    }

    /// Stops and opens the saved-recording sheet.
    pub fn stop(&mut self) -> Result<QueuedRecording> {
        let recording = self.session.stop(&self.queue)?;
        let markers = self.lock_queue()?.markers(&recording.id)?.len();
        self.sheet = Some(Sheet {
            id: recording.id.clone(),
            started_at: recording.started_at,
            duration_ms: recording.duration_ms.unwrap_or(0),
            markers,
        });
        Ok(recording)
    }

    /// Android refused the foreground service: stops the just-opened recording and removes it from
    /// the phone (queue and disk), with no saved-recording sheet, so no unprotected recording is
    /// left behind.
    pub fn undo_recording(&mut self) -> Result<()> {
        let recording = self.session.stop(&self.queue)?;
        self.sheet = None;
        self.lock_queue()?.discard(&recording.id)?;
        match std::fs::remove_file(&recording.path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!("failed to delete {}: {err}", recording.path.display()),
        }
        Ok(())
    }

    /// "Salvar" or "Pular" on the sheet.
    pub fn save_details(
        &mut self,
        id: &str,
        title: Option<&str>,
        agenda_type: Option<&str>,
        language: Option<&str>,
    ) -> Result<()> {
        Session::save_details(&self.queue, id, title, agenda_type, language)?;
        if self.sheet.as_ref().is_some_and(|s| s.id == id) {
            self.sheet = None;
        }
        Ok(())
    }

    /// The periodic device reading (battery and free space).
    pub fn update_device(&mut self, pct: u8, charging: bool, free_space: u64) {
        self.battery.record(BatteryReading {
            at_ms: now_ms(),
            pct,
            charging,
        });
        self.free_space = Some(free_space);
    }

    /// The recording's limits: closes the one that ended on its own and stops the one out of
    /// space. Returns the closed recording and the reason, for the caller to warn.
    pub fn check_limits(&mut self) -> Result<Option<(QueuedRecording, StopReason)>> {
        if !self.session.is_recording() {
            return Ok(None);
        }
        let reason = if self
            .free_space
            .is_some_and(|free| estimates::should_stop_for_storage(free, self.bitrate()))
        {
            StopReason::NoSpace
        } else if self.session.ended_on_its_own() {
            StopReason::SourceEnded
        } else {
            return Ok(None);
        };
        self.stop().map(|recording| Some((recording, reason)))
    }

    // --- local recordings -----------------------------------------------------------------------

    fn local(&self, queue: &Queue, rec: &QueuedRecording) -> Result<LocalRecording> {
        let badge = match rec.status {
            Status::Recording => Badge::Recording,
            Status::Syncing => Badge::Syncing,
            Status::Synced => Badge::Synced,
            Status::Failed => Badge::Failed,
            Status::Pending if rec.interrupted => Badge::Interrupted,
            Status::Pending => Badge::Waiting,
        };
        let agenda_type = rec.agenda_type_id.as_ref().and_then(|id| {
            self.config
                .agenda_types
                .iter()
                .find(|t| &t.id == id)
                .map(|t| t.name.clone())
        });
        Ok(LocalRecording {
            id: rec.id.clone(),
            title: rec.title.clone(),
            server_title: rec.server_title.clone(),
            started_at: rec.started_at,
            duration_ms: rec.duration_ms,
            bytes: rec.bytes,
            markers: queue.markers(&rec.id)?.len(),
            badge,
            remote_id: rec.remote_id.clone(),
            purged: rec.purged_at.is_some(),
            agenda_type,
            last_error: rec.last_error.clone(),
        })
    }

    /// "Neste celular": the most recent recordings first.
    pub fn recordings(&self) -> Result<Vec<LocalRecording>> {
        let queue = self.lock_queue()?;
        queue
            .list(200)?
            .iter()
            .map(|rec| self.local(&queue, rec))
            .collect()
    }

    pub fn recording(&self, id: &str) -> Result<LocalDetail> {
        let queue = self.lock_queue()?;
        let rec = queue
            .get(id)?
            .with_context(|| format!("gravação {id} não está no celular"))?;
        Ok(LocalDetail {
            recording: self.local(&queue, &rec)?,
            path: (rec.purged_at.is_none() && rec.status != Status::Recording)
                .then(|| rec.path.to_string_lossy().into_owned()),
            markers: queue.markers(id)?,
            steps: self.steps.get(id).map(|on| on.steps.clone()),
            wait: self.steps.get(id).and_then(|on| on.wait.clone()),
            web_address: self.web_address(rec.remote_id.as_deref()),
        })
    }

    /// The recording's page on eclume web, by the paired server's address.
    fn web_address(&self, remote_id: Option<&str>) -> Option<String> {
        let server = self.config.server.as_ref()?;
        Some(format!(
            "{}/gravacoes/{}",
            server.url.trim_end_matches('/'),
            remote_id?
        ))
    }

    /// The read of a synced recording's steps, on eclume's network.
    pub fn prepare_steps(&self, id: &str) -> Result<Option<(ReadPlan, String)>> {
        if !self.network.on_network() {
            return Ok(None);
        }
        let remote = self.lock_queue()?.get(id)?.and_then(|rec| rec.remote_id);
        let (Some(remote), Some(plan)) = (remote, self.read_plan(REQUEST_TIMEOUT)?) else {
            return Ok(None);
        };
        Ok(Some((plan, remote)))
    }

    pub fn store_steps(&mut self, id: &str, steps: OnServer) -> Result<()> {
        if let Some(title) = &steps.title {
            let queue = self.lock_queue()?;
            if let Some(remote) = queue.get(id)?.and_then(|rec| rec.remote_id) {
                queue.set_server_title(&remote, title)?;
            }
        }
        self.steps.insert(id.to_string(), steps);
        Ok(())
    }

    /// The read of the server titles, on eclume's network and at most every
    /// [`TITLES_INTERVAL_MS`]. The first starts from the oldest uploaded one still without a title
    /// (with none, from now); the next ones, from the previous one's `since`.
    pub fn prepare_titles(&mut self, now_ms: i64) -> Result<Option<(ReadPlan, String)>> {
        if !self.network.on_network() || now_ms - self.titles_read_at < TITLES_INTERVAL_MS {
            return Ok(None);
        }
        let since = match &self.titles_since {
            Some(since) => since.clone(),
            None => {
                let untitled = self
                    .lock_queue()?
                    .by_status(Status::Synced)?
                    .into_iter()
                    .filter(|rec| rec.server_title.is_none())
                    .filter_map(|rec| rec.synced_at)
                    .min();
                let start = untitled.unwrap_or(now_ms) - TITLES_INTERVAL_MS;
                eclume_sync::api::rfc3339_from_ms(start).context("instante inválido")?
            }
        };
        let Some(plan) = self.read_plan(REQUEST_TIMEOUT)? else {
            return Ok(None);
        };
        self.titles_read_at = now_ms;
        Ok(Some((plan, since)))
    }

    /// Stores the read titles on the rows uploaded from here, and the next `since`.
    pub fn store_titles(&mut self, titles: sync::Titles, since: String) -> Result<()> {
        let queue = self.lock_queue()?;
        for (remote, title) in &titles.pairs {
            queue.set_server_title(remote, title)?;
        }
        drop(queue);
        self.titles_since = Some(titles.next.unwrap_or(since));
        Ok(())
    }

    /// "Excluir deste celular": only a recording the server already confirmed.
    pub fn delete_local(&self, id: &str) -> Result<()> {
        let queue = self.lock_queue()?;
        let rec = queue
            .get(id)?
            .with_context(|| format!("gravação {id} não está no celular"))?;
        if rec.status != Status::Synced {
            anyhow::bail!("Só dá para excluir do celular depois de sincronizar");
        }
        if rec.purged_at.is_none() {
            sync::delete_file(&rec.path)?;
            queue.mark_purged(id, now_ms())?;
        }
        Ok(())
    }

    /// "Excluir sincronizadas": returns the bytes freed.
    pub fn delete_synced(&self) -> Result<u64> {
        sync::delete_synced(&self.queue).map(|(_, bytes)| bytes)
    }

    // --- update ---------------------------------------------------------------------------------

    /// The `movel.json` read: on eclume's network, once a day (or right away, with `force`).
    pub fn prepare_update(&self, force: bool) -> Result<Option<ReadPlan>> {
        let due = self
            .config
            .update_checked_at
            .is_none_or(|at| now_ms() - at >= UPDATE_INTERVAL_MS);
        if !self.network.on_network() || !(force || due) {
            return Ok(None);
        }
        self.read_plan(REQUEST_TIMEOUT)
    }

    /// Stores the read manifest: only a version above the installed one becomes an update.
    pub fn store_manifest(&mut self, manifest: Option<sync::Manifest>) -> Result<()> {
        self.update = manifest.filter(|m| sync::is_newer(&m.version, &self.version));
        self.config.update_checked_at = Some(now_ms());
        self.save_config()
    }

    pub fn update(&self) -> Option<&sync::Manifest> {
        self.update.as_ref()
    }

    /// Where the downloaded APK goes: the app's cache (`<app data>/cache`), which Android's
    /// `FileProvider` exposes to the installer.
    fn apk_dir(&self) -> std::path::PathBuf {
        self.dirs
            .data
            .parent()
            .unwrap_or(&self.dirs.data)
            .join("cache")
    }

    /// The update download to make outside the lock.
    pub fn prepare_download(&self) -> Result<DownloadPlan> {
        let manifest = self
            .update
            .clone()
            .context("Nenhuma versão nova para baixar")?;
        let server = self
            .config
            .server
            .clone()
            .context("nenhum servidor pareado")?;
        Ok(DownloadPlan {
            transport: self.connection.downloader()?,
            server,
            manifest,
            dest: self.apk_dir(),
        })
    }

    // --- settings -------------------------------------------------------------------------------

    pub fn preferences(&self) -> Preferences {
        Preferences {
            sync_auto: self.config.sync_auto,
            quality: self.config.quality,
            delete_synced: self.config.delete_synced,
        }
    }

    pub fn save_preferences(&mut self, preferences: &Preferences) -> Result<()> {
        self.config.sync_auto = preferences.sync_auto;
        self.config.quality = preferences.quality;
        self.config.delete_synced = preferences.delete_synced;
        self.save_config()
    }

    /// Bytes of the recordings still on the phone.
    pub fn local_usage(&self) -> Result<u64> {
        Ok(self
            .lock_queue()?
            .list(10_000)?
            .iter()
            .filter(|rec| rec.purged_at.is_none())
            .filter_map(|rec| rec.bytes.and_then(|b| u64::try_from(b).ok()))
            .sum())
    }
}

impl ReadPlan {
    pub fn probe(self) -> Probe {
        network::probe_and_learn(self.transport, &self.server, &self.ca)
    }

    pub fn types(&self) -> Result<Vec<config::AgendaType>> {
        sync::fetch_agenda_types(self.transport.as_ref(), &self.server, &self.token)
    }

    pub fn account_language(&self) -> Result<String> {
        sync::fetch_account_language(self.transport.as_ref(), &self.server, &self.token)
    }

    pub fn titles(&self, since: &str) -> Result<sync::Titles> {
        sync::fetch_titles(self.transport.as_ref(), &self.server, &self.token, since)
    }

    pub fn steps(&self, remote_id: &str) -> Result<OnServer> {
        sync::fetch_steps(
            self.transport.as_ref(),
            &self.server,
            &self.token,
            remote_id,
        )
    }
}

/// The APK download, built under the lock and made outside it.
pub struct DownloadPlan {
    transport: Arc<dyn eclume_sync::transport::Transport>,
    server: Server,
    manifest: sync::Manifest,
    dest: std::path::PathBuf,
}

impl NextRootPlan {
    /// The descriptor, read pinning the next root, confirms it: the server switched to it.
    pub fn confirms(&self) -> bool {
        network::confirms_next(Arc::clone(&self.transport), &self.server, &self.root.sha256)
    }
}

impl DownloadPlan {
    /// Downloads and checks the APK; returns its path.
    pub fn run(&self) -> Result<std::path::PathBuf> {
        sync::download_apk(
            self.transport.as_ref(),
            &self.server,
            &self.manifest,
            &self.dest,
        )
    }
}

impl SyncPlan {
    /// Runs the sync (blocks) and returns whether the server refused the credential.
    pub fn run(self) -> Result<(eclume_recorder::SyncReport, bool)> {
        let result = sync::synchronize(&self.queue, &self.uploader, &self.meter);
        self.busy.store(false, Ordering::Release);
        Ok((result?, self.meter.credential_refused()))
    }
}

// --- the process's core ----------------------------------------------------------------------

static CORE: OnceLock<Mutex<Core>> = OnceLock::new();
/// Serializes the opening: the screen and WorkManager opening together would run the recovery
/// twice.
static OPENING: Mutex<()> = Mutex::new(());

/// Opens the process's core on the first call; the next ones return the same (the Activity that
/// comes back, WorkManager).
pub fn init(dirs: Dirs, version: &str) -> Result<&'static Mutex<Core>> {
    if let Some(core) = CORE.get() {
        return Ok(core);
    }
    let _turn = OPENING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(core) = CORE.get() {
        return Ok(core);
    }
    let transports = Arc::new(RealTransports {
        user_agent: client_version(version),
    });
    let core = Core::open(dirs, version, transports)?;
    Ok(CORE.get_or_init(|| Mutex::new(core)))
}

/// The core, if already opened.
pub fn global() -> Option<&'static Mutex<Core>> {
    CORE.get()
}

/// Locks the core.
pub fn lock(core: &Mutex<Core>) -> Result<MutexGuard<'_, Core>> {
    core.lock()
        .map_err(|_| anyhow!("o núcleo ficou envenenado por um pânico"))
}

/// The result of [`probe`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbeOutcome {
    /// The probe ran now (and not only the previous result counted).
    pub ran: bool,
    pub on_network: bool,
}

/// Runs the probe (when it applies) outside the lock and records the result.
pub fn probe(core: &Mutex<Core>, force: bool) -> Result<ProbeOutcome> {
    let now = now_ms();
    let plan = lock(core)?.prepare_probe(now, force)?;
    let ran = plan.is_some();
    if let Some(plan) = plan {
        let mut probe = plan.probe();
        if probe == Probe::CaChanged && switch_to_next(core)? {
            probe = Probe::Ok;
        }
        lock(core)?.record_probe(now, probe);
    }
    Ok(ProbeOutcome {
        ran,
        on_network: lock(core)?.network.on_network(),
    })
}

/// On a probe that reported another CA: if the server switched to the stored next root (the
/// descriptor, read pinning it, confirms it), it becomes the pinned one and the probe counts as ok;
/// otherwise `CaChanged` stands.
fn switch_to_next(core: &Mutex<Core>) -> Result<bool> {
    let Some(plan) = lock(core)?.prepare_next_root()? else {
        return Ok(false);
    };
    if !plan.confirms() {
        return Ok(false);
    }
    lock(core)?.promote_next(&plan)?;
    Ok(true)
}

/// What the `SyncWorker` needs to know before uploading: whether it is on eclume's network and what
/// waits. Serialized to the plugin over JNI; the keys keep their names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WorkerProbe {
    #[serde(rename = "na_rede")]
    pub on_network: bool,
    #[serde(rename = "pendentes")]
    pub pending: u32,
    pub bytes: u64,
}

/// The worker cycle's result: the sync report and whether it was interrupted halfway.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkerReport {
    pub report: eclume_recorder::SyncReport,
    pub interrupted: bool,
}

/// The `SyncWorker`'s probe, before deciding on the foreground: it assumes the unmetered network
/// WorkManager guarantees (the process opened only for it has no screen that would report the
/// Wi-Fi).
pub fn worker_probe(core: &Mutex<Core>) -> Result<WorkerProbe> {
    lock(core)?.network_changed(true);
    let on_network = probe(core, false)?.on_network;
    let (pending, bytes) = lock(core)?.pending()?;
    Ok(WorkerProbe {
        on_network,
        pending,
        bytes,
    })
}

/// The `SyncWorker`'s cycle. WorkManager only runs it on an unmetered network (`UNMETERED`), and the
/// process opened only for it has no screen that would report the Wi-Fi: without this, the probe
/// would never run.
pub fn worker_cycle(core: &Mutex<Core>) -> Result<Option<WorkerReport>> {
    lock(core)?.network_changed(true);
    let report = cycle(core, false)?;
    let interrupted = lock(core)?.meter.interrupted();
    Ok(report.map(|report| WorkerReport {
        report,
        interrupted,
    }))
}

/// One cycle: probes, refreshes the agenda types and syncs (`now`: "Sincronizar agora", which
/// uploads even with the automatic sync off). Blocks until the sync ends.
pub fn cycle(core: &Mutex<Core>, now: bool) -> Result<Option<eclume_recorder::SyncReport>> {
    let outcome = probe(core, now)?;
    if !outcome.on_network {
        return Ok(None);
    }
    // The agenda types change rarely: they are read only when the probe runs.
    if outcome.ran {
        // The plan leaves the lock before the network: in `if let` (edition 2021), the temporary
        // guard would live the whole block, and locking again inside would deadlock.
        let plan = lock(core)?.prepare_types()?;
        if let Some(plan) = plan {
            match plan.types() {
                Ok(types) => lock(core)?.store_types(types)?,
                Err(err) => read_failed(core, &err)?,
            }
            // A server older than 2.20.0 lacks the route: the sheet keeps the plain account default.
            match plan.account_language() {
                Ok(language) => lock(core)?.store_account_language(language)?,
                Err(err) => log::warn!("{err:#}"),
            }
        }
    }
    if let Err(err) = check_update(core, false) {
        log::warn!("{err:#}");
    }
    let plan = lock(core)?.prepare_sync(now)?;
    let report = match plan {
        Some(plan) => {
            let (report, refused) = plan.run()?;
            lock(core)?.finish_sync(refused)?;
            Some(report)
        }
        None => None,
    };
    refresh_titles(core)?;
    Ok(report)
}

/// Reads the server titles (outside the lock) and stores them in the queue: the list and the detail
/// show the server title of the already processed recording.
pub fn refresh_titles(core: &Mutex<Core>) -> Result<()> {
    let plan = lock(core)?.prepare_titles(now_ms())?;
    if let Some((plan, since)) = plan {
        match plan.titles(&since) {
            Ok(titles) => lock(core)?.store_titles(titles, since)?,
            Err(err) => read_failed(core, &err)?,
        }
    }
    Ok(())
}

/// An authenticated read that failed: on 401, the credential dropped; the rest only goes to the
/// log.
fn read_failed(core: &Mutex<Core>, err: &anyhow::Error) -> Result<()> {
    log::warn!("{err:#}");
    if sync::refused_credential(err) {
        lock(core)?.credential_lost()?;
    }
    Ok(())
}

/// Reads `movel.json` (once a day, or right away with `force`) and returns the new version, if any.
pub fn check_update(core: &Mutex<Core>, force: bool) -> Result<Option<sync::Manifest>> {
    let plan = lock(core)?.prepare_update(force)?;
    if let Some(plan) = plan {
        let manifest = sync::fetch_manifest(plan.transport.as_ref(), &plan.server)?;
        lock(core)?.store_manifest(manifest)?;
    }
    Ok(lock(core)?.update().cloned())
}

/// Downloads the update (outside the lock) and returns the checked APK's path.
pub fn download_update(core: &Mutex<Core>) -> Result<std::path::PathBuf> {
    let plan = lock(core)?.prepare_download()?;
    plan.run()
}

/// Refreshes a recording's server steps (outside the lock) and returns the detail.
pub fn detail(core: &Mutex<Core>, id: &str) -> Result<LocalDetail> {
    let plan = lock(core)?.prepare_steps(id)?;
    if let Some((plan, remote)) = plan {
        match plan.steps(&remote) {
            Ok(steps) => lock(core)?.store_steps(id, steps)?,
            Err(err) => read_failed(core, &err)?,
        }
    }
    lock(core)?.recording(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_version_follows_the_contract() {
        assert_eq!(client_version("0.1.0"), "eclume-android/0.1.0");
    }

    #[test]
    fn bridge_keys_stay_the_installed_format() {
        let probe = serde_json::to_value(WorkerProbe {
            on_network: true,
            pending: 2,
            bytes: 3,
        })
        .unwrap();
        assert_eq!(probe["na_rede"], true);
        assert_eq!(probe["pendentes"], 2);
        assert_eq!(serde_json::to_value(Badge::Waiting).unwrap(), "aguardando");
        assert_eq!(
            serde_json::to_value(StopReason::NoSpace).unwrap(),
            "sem_espaco"
        );
    }
}
