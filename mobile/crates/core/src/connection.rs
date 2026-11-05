//! The link with the server: find it, pin the CA, sign in and keep the device credential.
//!
//! Three paths lead to the pinned CA (holetz/eclume#35, CA pinning by the apps):
//!
//! 1. **Discovered** over mDNS: the TXT carries `url` and `ca`, but is not authenticated (any machine
//!    on the network can announce another CA). The downloaded root must match the announced `ca`
//!    **and** the person checks the fingerprint before sending e-mail and password.
//! 2. **QR** from the web (`pair_url`): the code and the fingerprint come from the web's
//!    authenticated screen, and pairing ends without a password and without a check.
//! 3. **Typed address**: with no expected fingerprint (TOFU), the person checks the blocks against
//!    the web before "Confiar".
//!
//! Once pinned, only the CA in `ca.pem` counts (`TrustMode::Pinned`, exactly one certificate:
//! `pin.rs` writes only the first, the fingerprint's), and the already pinned `GET /api/v1/server`
//! confirms `ca_sha256`. The device token lives in the private file outside the backup. An old
//! `ca.pem` with extra certificates is rewritten with a single one on open (`Core::open`), and the
//! credential is deleted with the reason [`pin::CA_TRIMMED`] (holetz/eclume#102).
//!
//! Root rotation (holetz/eclume#101): the probe stores in `ca.proxima.pem` the next root the pinned
//! descriptor announces; when the server switches, [`Connection::promote_next`] swaps it for the
//! pinned one by `rename`, with no new sign-in and no new pairing.
//!
//! The serialized names of [`ConnectionState`] (`fase` tag, variants and fields) are read by the UI
//! and keep their original (pt-BR) names.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use eclume_sync::api::DeviceCredential;
use eclume_sync::pat::{NoKeyring, PatStore};
use eclume_sync::pin::{self, RootCa};
use eclume_sync::transport::{Transport, UreqTransport, REQUEST_TIMEOUT};
use eclume_sync::Devices;
use serde::Serialize;

use crate::config::{Config, Dirs, Server};

/// How the core opens connections: the insecure one (only to download the CA) and the pinned one.
/// Tests inject scripted transports.
pub trait Transports: Send + Sync {
    fn insecure(&self) -> Arc<dyn Transport>;
    fn pinned(&self, ca: &Path, timeout: Duration) -> Result<Arc<dyn Transport>>;

    /// The pinned one for downloading a large file (the update's APK).
    fn downloader(&self, ca: &Path) -> Result<Arc<dyn Transport>> {
        self.pinned(ca, REQUEST_TIMEOUT)
    }
}

/// The real transports, on `ureq`.
pub struct RealTransports {
    pub user_agent: String,
}

impl Transports for RealTransports {
    fn insecure(&self) -> Arc<dyn Transport> {
        Arc::new(UreqTransport::insecure(&self.user_agent))
    }

    fn pinned(&self, ca: &Path, timeout: Duration) -> Result<Arc<dyn Transport>> {
        let trust = eclume_sync::transport::TrustMode::Pinned(ca.to_path_buf());
        Ok(Arc::new(UreqTransport::with_trust(
            &trust,
            &self.user_agent,
            timeout,
        )?))
    }

    fn downloader(&self, ca: &Path) -> Result<Arc<dyn Transport>> {
        let trust = eclume_sync::transport::TrustMode::Pinned(ca.to_path_buf());
        Ok(Arc::new(
            // `com_limite` is the desktop sync crate's response-size limit.
            UreqTransport::with_trust(&trust, &self.user_agent, REQUEST_TIMEOUT)?
                .com_limite(APK_LIMIT),
        ))
    }
}

/// The largest APK the app accepts to download.
const APK_LIMIT: u64 = 256 * 1024 * 1024;

/// A downloaded root waiting for the person to check it ("Confiar" or "Cancelar").
#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingCa {
    url: String,
    root: RootCa,
    /// The code of a QR without `ca`: redeemed for the credential only after "Confiar".
    code: Option<String>,
}

/// Where the link stands: the UI picks the screen by it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "fase", rename_all = "snake_case")]
pub enum ConnectionState {
    /// First run, or after "Sair e esquecer o servidor".
    #[serde(rename = "sem_servidor")]
    NoServer,
    /// The downloaded CA waits for a check: `fingerprint` in blocks of 4 (`3F9A 12C4 …`).
    #[serde(rename = "confirmar_ca")]
    ConfirmCa {
        url: String,
        #[serde(rename = "impressao")]
        fingerprint: String,
    },
    /// Server pinned, no credential (or the server refused it with 401): the sign-in screen. The
    /// `reason`, when there is one, explains why the credential was deleted.
    #[serde(rename = "sem_credencial")]
    NoCredential {
        #[serde(rename = "servidor")]
        server: Server,
        #[serde(rename = "motivo", skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "conectado")]
    Connected {
        #[serde(rename = "servidor")]
        server: Server,
    },
}

/// The fingerprint in blocks of 4 uppercase characters, to check against the web.
pub fn fingerprint_blocks(sha256: &str) -> String {
    sha256
        .to_ascii_uppercase()
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The address as the person typed it: without a scheme it becomes `https://`, without a trailing
/// slash.
pub fn normalize_address(text: &str) -> Result<String> {
    let text = text.trim().trim_end_matches('/');
    if text.is_empty() {
        bail!("Digite o endereço do servidor");
    }
    let url = if text.contains("://") {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    if !url.starts_with("https://") {
        bail!("O endereço precisa ser https://");
    }
    Ok(url)
}

/// The link with the server and what it keeps on disk.
pub struct Connection {
    dirs: Dirs,
    transports: Arc<dyn Transports>,
    credential: PatStore,
    /// The file's token, read once on open and replaced on sign-in, pairing, sign-out and credential
    /// loss: the state, read every 250 ms, does not reread the disk.
    token: Option<String>,
    pending: Option<PendingCa>,
    no_credential: bool,
    /// Why the credential was deleted, for the sign-in screen; cleared after signing in.
    reason: Option<String>,
}

impl Connection {
    pub fn new(dirs: Dirs, transports: Arc<dyn Transports>) -> Self {
        let credential = PatStore::with_backend(dirs.token(), Box::new(NoKeyring), None);
        let token = match credential.load() {
            Ok(read) => read.map(|(token, _)| token),
            Err(err) => {
                log::warn!("failed to read the credential: {err:#}");
                None
            }
        };
        Self {
            dirs,
            transports,
            credential,
            token,
            pending: None,
            no_credential: false,
            reason: None,
        }
    }

    pub fn state(&self, config: &Config) -> ConnectionState {
        if let Some(pending) = &self.pending {
            return ConnectionState::ConfirmCa {
                url: pending.url.clone(),
                fingerprint: fingerprint_blocks(&pending.root.sha256),
            };
        }
        let Some(server) = config.server.clone() else {
            return ConnectionState::NoServer;
        };
        match self.token() {
            Ok(Some(_)) if !self.no_credential => ConnectionState::Connected { server },
            _ => ConnectionState::NoCredential {
                server,
                reason: self.reason.clone(),
            },
        }
    }

    /// The device token, if any (from memory: see the `token` field).
    pub fn token(&self) -> Result<Option<String>> {
        Ok(self.token.clone())
    }

    /// Deletes the credential from the file and from memory.
    fn forget_token(&mut self) -> Result<()> {
        self.token = None;
        self.credential.clear()
    }

    /// The pinned transport for downloading the update.
    pub fn downloader(&self) -> Result<Arc<dyn Transport>> {
        self.transports.downloader(&self.dirs.ca())
    }

    /// The transport pinned to the saved CA, with the given timeout.
    pub fn transport(&self, timeout: Duration) -> Result<Arc<dyn Transport>> {
        self.transports.pinned(&self.dirs.ca(), timeout)
    }

    /// The next root the probe stored and the transport pinned to it, to check the switch outside
    /// the core's lock; `None` with no next root stored.
    pub fn next_root(&self, timeout: Duration) -> Result<Option<(RootCa, Arc<dyn Transport>)>> {
        let ca = self.dirs.ca();
        let Some(root) = pin::saved_next(&ca) else {
            return Ok(None);
        };
        let transport = self.transports.pinned(&pin::next_path(&ca), timeout)?;
        Ok(Some((root, transport)))
    }

    /// The server switched to the next root and the descriptor pinned to it confirmed it: it
    /// becomes the pinned CA (`rename`) and the new fingerprint goes to the config. The device stays
    /// paired.
    pub fn promote_next(&mut self, root: &RootCa, config: &mut Config) -> Result<()> {
        let ca = self.dirs.ca();
        if pin::saved_next(&ca).is_none_or(|stored| stored.sha256 != root.sha256) {
            bail!("a próxima CA guardada mudou durante a conferência");
        }
        pin::promote_next(&ca)?;
        if let Some(server) = config.server.as_mut() {
            server.ca_sha256 = root.sha256.clone();
        }
        log::info!(
            "server CA replaced by the announced next one ({})",
            root.sha256
        );
        config.save(&self.dirs.config())
    }

    /// A server found over mDNS: downloads the root, checks it against the announced `ca` and
    /// waits for the person to check the fingerprint (the TXT is not authenticated).
    pub fn connect_discovered(&mut self, url: &str, announced_ca: Option<&str>) -> Result<()> {
        let url = normalize_address(url)?;
        let root = pin::fetch_root(self.transports.insecure().as_ref(), &url, announced_ca)?;
        self.pending = Some(PendingCa {
            url,
            root,
            code: None,
        });
        Ok(())
    }

    /// A typed address: downloads the root with no expected fingerprint (TOFU) and waits for the
    /// check.
    pub fn connect_address(&mut self, text: &str) -> Result<()> {
        let url = normalize_address(text)?;
        let root = pin::fetch_root(self.transports.insecure().as_ref(), &url, None)?;
        self.pending = Some(PendingCa {
            url,
            root,
            code: None,
        });
        Ok(())
    }

    pub fn cancel_ca(&mut self) {
        self.pending = None;
    }

    /// "Confiar": pins the checked root, confirms it through the descriptor and writes the server
    /// into the config. If the check came from a QR without `ca`, redeems its code for the
    /// credential. Returns whether it paired.
    pub fn trust_ca(&mut self, config: &mut Config) -> Result<bool> {
        let pending = self
            .pending
            .take()
            .context("não há certificado esperando conferência")?;
        self.pin(&pending.url, &pending.root, config)?;
        let Some(code) = pending.code else {
            return Ok(false);
        };
        self.redeem_code(config, &pending.url, &code)?;
        Ok(true)
    }

    fn pin(&mut self, url: &str, root: &RootCa, config: &mut Config) -> Result<()> {
        std::fs::create_dir_all(&self.dirs.data)
            .with_context(|| format!("falha ao criar {}", self.dirs.data.display()))?;
        // The new root only replaces the current server's after the descriptor confirms it: a check
        // that fails does not leave the server paired with another one's CA.
        let ca = self.dirs.ca();
        let provisional = ca.with_extension("pem.novo");
        std::fs::write(&provisional, &root.pem)
            .with_context(|| format!("falha ao gravar {}", provisional.display()))?;
        let confirmed = self
            .transports
            .pinned(&provisional, REQUEST_TIMEOUT)
            .and_then(|transport| Devices::new(transport, url)?.server_info())
            .and_then(|info| {
                pin::confirm(&info, &root.sha256)?;
                Ok(info)
            });
        let info = match confirmed {
            Ok(info) => info,
            Err(err) => {
                let _ = std::fs::remove_file(&provisional);
                return Err(err);
            }
        };
        std::fs::rename(&provisional, &ca)
            .with_context(|| format!("falha ao gravar {}", ca.display()))?;
        pin::forget_next(&ca)?;
        if config
            .server
            .as_ref()
            .is_some_and(|previous| previous.url != url)
        {
            // Switching servers invalidates the previous one's credential.
            self.forget_token()?;
            config.agenda_types.clear();
        }
        config.server = Some(Server {
            url: url.to_string(),
            name: info.name,
            ca_sha256: root.sha256.clone(),
        });
        config.save(&self.dirs.config())
    }

    /// Signs in with e-mail and password on the pinned server and keeps the device credential.
    pub fn sign_in(&mut self, config: &Config, email: &str, password: &str) -> Result<()> {
        let server = config
            .server
            .as_ref()
            .context("nenhum servidor escolhido")?;
        let devices = Devices::new(self.transport(REQUEST_TIMEOUT)?, &server.url)?;
        let credential = devices.login(email, password, &config.device_name)?;
        self.store(&credential)
    }

    /// Reads the web QR's `pair_url`: pins the CA by the QR's own fingerprint and redeems the code
    /// for the credential, with no password. Returns whether it paired: a QR without `ca` (the root
    /// not yet published) does not skip the check, and the code waits for "Confiar".
    pub fn pair(&mut self, config: &mut Config, qr_text: &str) -> Result<bool> {
        let pair = eclume_sync::devices::parse_pair_url(qr_text)?;
        let root = pin::fetch_root(
            self.transports.insecure().as_ref(),
            &pair.url,
            pair.ca_sha256.as_deref(),
        )?;
        if pair.ca_sha256.is_none() {
            self.pending = Some(PendingCa {
                url: pair.url,
                root,
                code: Some(pair.code),
            });
            return Ok(false);
        }
        self.pin(&pair.url, &root, config)?;
        self.redeem_code(config, &pair.url, &pair.code)?;
        Ok(true)
    }

    fn redeem_code(&mut self, config: &Config, url: &str, code: &str) -> Result<()> {
        let devices = Devices::new(self.transport(REQUEST_TIMEOUT)?, url)?;
        let credential = devices.pair(code, &config.device_name)?;
        self.store(&credential)
    }

    fn store(&mut self, credential: &DeviceCredential) -> Result<()> {
        std::fs::create_dir_all(&self.dirs.no_backup)
            .with_context(|| format!("falha ao criar {}", self.dirs.no_backup.display()))?;
        self.credential.save(&credential.secret)?;
        self.token = Some(credential.secret.clone());
        self.no_credential = false;
        self.reason = None;
        Ok(())
    }

    /// The server refused the credential (401): forgets the token and goes back to the sign-in
    /// screen, without touching the local recordings.
    pub fn credential_lost(&mut self) -> Result<()> {
        self.no_credential = true;
        self.forget_token()
    }

    /// The credential was deleted for `reason`, which the sign-in screen shows.
    pub fn credential_lost_because(&mut self, reason: &str) -> Result<()> {
        self.reason = Some(reason.to_string());
        self.credential_lost()
    }

    /// "Sair e esquecer o servidor": deletes the token, the CA and the server from the config. The
    /// recordings stay and upload to the next paired server.
    pub fn sign_out(&mut self, config: &mut Config) -> Result<()> {
        self.pending = None;
        self.forget_token()?;
        match std::fs::remove_file(self.dirs.ca()) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).context("falha ao apagar a CA"),
        }
        pin::forget_next(&self.dirs.ca())?;
        config.server = None;
        config.agenda_types.clear();
        config.save(&self.dirs.config())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_in_blocks_of_four() {
        let sha = "3f9a12c4".repeat(8);
        let blocks = fingerprint_blocks(&sha);
        assert!(blocks.starts_with("3F9A 12C4 3F9A"));
        assert_eq!(blocks.split(' ').count(), 16);
    }

    #[test]
    fn typed_address_gets_https() {
        assert_eq!(
            normalize_address(" 192.0.2.10:8443/ ").unwrap(),
            "https://192.0.2.10:8443"
        );
        assert!(normalize_address("http://eclume.test").is_err());
        assert!(normalize_address("  ").is_err());
    }
}
