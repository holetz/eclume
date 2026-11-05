//! "Na rede do eclume": unmetered Wi-Fi **and** `GET /api/v1/server` answering, through the
//! pinned CA, with the same fingerprint. A pure state machine, tested without a network: the plugin
//! reports the Wi-Fi, the core runs the probe and records the result, and the state comes out here.
//!
//! Off unmetered Wi-Fi the probe does not run and no byte leaves over mobile data.
//!
//! During the root rotation (holetz/eclume#101), a probe that answers stores the next root the
//! descriptor announces ([`probe_and_learn`]); when the CA changes, the core checks the next one
//! ([`confirms_next`]) and swaps it for the pinned one before reporting `CaChanged`.
//!
//! The serialized names (`estado` tag, `sem_credencial`) are read by the UI and stay as they are.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use eclume_sync::api::ServerInfo;
use eclume_sync::pin;
use eclume_sync::transport::Transport;
use eclume_sync::Devices;
use serde::Serialize;

use crate::config::Server;

/// The probe's timeout.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often the probe repeats while the app is visible.
pub const PROBE_INTERVAL_MS: i64 = 60_000;

/// The result of a `/server` probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// Answered with the pinned CA.
    Ok,
    /// Did not answer in time (another Wi-Fi network, server down).
    NoAnswer,
    /// Answered, but the root is no longer the pinned one (or TLS refused the chain).
    CaChanged,
}

/// The sync's progress, for the "Sincronizando 1 de 2 · 64 % · 18 MB/s" banner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub i: u32,
    pub n: u32,
    pub pct: u8,
    pub bytes_s: u64,
}

/// The network state, as the UI shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "estado", rename_all = "snake_case")]
pub enum NetworkState {
    /// "Fora da rede do eclume · N aguardando".
    Away,
    /// "Na rede do eclume · Sincronizar agora".
    OnNetwork,
    Syncing(Progress),
    /// The server answers with another CA: sync stops until the person pairs again.
    CaMismatch,
    /// The server refused the credential (401).
    #[serde(rename = "sem_credencial")]
    NoCredential,
}

/// The network state machine.
#[derive(Clone, Debug, Default)]
pub struct Network {
    unmetered_wifi: bool,
    /// The last probe (Unix ms, result), invalidated on every network change.
    probe: Option<(i64, Probe)>,
    syncing: Option<Progress>,
    no_credential: bool,
}

impl Network {
    /// The plugin reported a network change. Returns whether the unmetered Wi-Fi changed (and the
    /// probe must run again).
    pub fn wifi_changed(&mut self, unmetered: bool) -> bool {
        let changed = self.unmetered_wifi != unmetered;
        self.unmetered_wifi = unmetered;
        if changed {
            self.probe = None;
        }
        changed
    }

    pub fn unmetered_wifi(&self) -> bool {
        self.unmetered_wifi
    }

    /// Whether the probe may run now: only on unmetered Wi-Fi.
    pub fn can_probe(&self) -> bool {
        self.unmetered_wifi && !self.no_credential
    }

    /// The periodic probe: no result yet, or expired while the app is visible.
    pub fn needs_probe(&self, now_ms: i64, visible: bool) -> bool {
        if !self.can_probe() {
            return false;
        }
        match self.probe {
            None => true,
            Some((at, _)) => visible && now_ms - at >= PROBE_INTERVAL_MS,
        }
    }

    pub fn record_probe(&mut self, now_ms: i64, probe: Probe) {
        self.probe = Some((now_ms, probe));
    }

    pub fn credential_lost(&mut self) {
        self.no_credential = true;
        self.syncing = None;
    }

    pub fn credential_restored(&mut self) {
        self.no_credential = false;
        self.probe = None;
    }

    pub fn sync_progress(&mut self, progress: Progress) {
        self.syncing = Some(progress);
    }

    pub fn sync_finished(&mut self) {
        self.syncing = None;
    }

    pub fn state(&self) -> NetworkState {
        if self.no_credential {
            return NetworkState::NoCredential;
        }
        if !self.unmetered_wifi {
            return NetworkState::Away;
        }
        match self.probe {
            Some((_, Probe::CaChanged)) => NetworkState::CaMismatch,
            Some((_, Probe::Ok)) => match self.syncing {
                Some(progress) => NetworkState::Syncing(progress),
                None => NetworkState::OnNetwork,
            },
            _ => NetworkState::Away,
        }
    }

    /// On eclume's network: sync may upload.
    pub fn on_network(&self) -> bool {
        matches!(
            self.state(),
            NetworkState::OnNetwork | NetworkState::Syncing(_)
        )
    }
}

/// Runs the probe: `GET /api/v1/server` through the pinned transport (with [`PROBE_TIMEOUT`]) and
/// checks the announced fingerprint against the pinned one.
pub fn probe(transport: Arc<dyn Transport>, server: &Server) -> Probe {
    read(transport, server).0
}

/// The probe that, with the CA pinned in `ca` confirmed, also stores the next root the descriptor
/// announces ([`pin::learn_next`], over the same connection). Failing to store it does not change
/// the probe.
pub fn probe_and_learn(transport: Arc<dyn Transport>, server: &Server, ca: &Path) -> Probe {
    let (probe, info) = read(Arc::clone(&transport), server);
    if let Some(info) = info {
        if let Err(err) = pin::learn_next(transport.as_ref(), &server.url, &info, ca) {
            log::info!("could not store the next CA: {err:#}");
        }
    }
    probe
}

/// Does the descriptor, read through the transport pinned to the next root, confirm it (`next`,
/// the SHA-256)?
pub fn confirms_next(transport: Arc<dyn Transport>, server: &Server, next: &str) -> bool {
    Devices::new(transport, &server.url)
        .and_then(|d| d.server_info())
        .is_ok_and(|info| pin::confirm(&info, next).is_ok())
}

/// The probe and, when it confirms the pinned CA, the descriptor it read.
fn read(transport: Arc<dyn Transport>, server: &Server) -> (Probe, Option<ServerInfo>) {
    let info = Devices::new(transport, &server.url).and_then(|d| d.server_info());
    match info {
        Ok(info) => match pin::confirm(&info, &server.ca_sha256) {
            Ok(()) => (Probe::Ok, Some(info)),
            Err(_) => (Probe::CaChanged, None),
        },
        // With the CA pinned, a chain from another root fails in TLS: the CA changed, not the
        // network.
        Err(err) if is_certificate_error(&err) => (Probe::CaChanged, None),
        Err(err) => {
            log::info!("probe got no answer: {err:#}");
            (Probe::NoAnswer, None)
        }
    }
}

fn is_certificate_error(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}").to_ascii_lowercase();
    text.contains("unknownissuer") || text.contains("certificate")
}
