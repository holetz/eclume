//! Automatic updates through the Tauri updater: the eclume server serves the `latest.json`
//! manifest at `<web_url>/downloads/`, and the package is checked against the minisign key in
//! `tauri.conf.json` before installing. Never installs or restarts during recording or sync.
//!
//! The updater HTTP client trusts the server like sync ([`AppState::trust`]): the CA pinned
//! at first run is the only root (`tls_certs_only`); a manually chosen CA is added to system
//! roots (`tls_certs_merge`); without a custom CA, uses the default client. An unreadable pinned
//! CA, or one with multiple certificates, skips the check (logged), without using system roots.
//! The package is still checked by minisign; pinned TLS protects `latest.json` and the download.

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use eclume_sync::transport::TrustMode;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

use crate::state::{AppState, AppStatus};

/// Wait after opening the app to avoid competing with startup.
const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Interval between checks.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Where the eclume server publishes the updater manifest.
fn endpoint(web_url: &str) -> Result<Url> {
    let url = format!("{}/downloads/latest.json", web_url.trim_end_matches('/'));
    Url::parse(&url).with_context(|| format!("invalid update URL: {url}"))
}

/// Updater client roots.
enum Roots {
    /// No custom server CA: the default client.
    Default,
    /// Manually chosen CA: added to system roots.
    Merge(Vec<reqwest::Certificate>),
    /// CA pinned at first run: the only root.
    Only(reqwest::Certificate),
}

/// Roots based on sync trust; the pinned CA must have exactly one certificate.
fn roots(trust: &TrustMode) -> Result<Roots> {
    match trust {
        TrustMode::PlatformPlus(None) => Ok(Roots::Default),
        TrustMode::PlatformPlus(Some(path)) => Ok(Roots::Merge(read_certs(path)?)),
        TrustMode::Pinned(path) => {
            let mut certs = read_certs(path)?;
            if certs.len() != 1 {
                bail!(
                    "the CA pinned at {} has {} certificates; expected exactly one",
                    path.display(),
                    certs.len()
                );
            }
            Ok(Roots::Only(certs.remove(0)))
        }
    }
}

/// Certificates from a PEM; a file without any is an error.
fn read_certs(path: &Path) -> Result<Vec<reqwest::Certificate>> {
    let pem = std::fs::read(path)
        .with_context(|| format!("failed to read the extra CA at {}", path.display()))?;
    let certs = reqwest::Certificate::from_pem_bundle(&pem)
        .with_context(|| format!("invalid PEM at {}", path.display()))?;
    if certs.is_empty() {
        bail!("no certificates in PEM {}", path.display());
    }
    Ok(certs)
}

fn is_idle(app: &AppHandle) -> bool {
    matches!(app.state::<AppState>().status(), Ok(AppStatus::Idle))
}

/// Checks, downloads and installs a new version, if available. Returns whether it installed.
async fn check_and_install(app: &AppHandle) -> Result<bool> {
    let state = app.state::<AppState>();
    let url = endpoint(&state.web_url()?)?;
    let mut builder = app.updater_builder().endpoints(vec![url.clone()])?;
    let trust = state.trust()?;
    match roots(&trust) {
        Ok(Roots::Default) => {}
        Ok(Roots::Merge(certs)) => {
            builder = builder.configure_client(move |client| client.tls_certs_merge(certs.clone()));
        }
        Ok(Roots::Only(root)) => {
            builder = builder.configure_client(move |client| client.tls_certs_only([root.clone()]));
        }
        // An unreadable pinned CA stops the check: system roots do not replace it.
        Err(err) if matches!(trust, TrustMode::Pinned(_)) => {
            return Err(err.context("update not checked"));
        }
        // An unreadable manually chosen CA does not stop the check: system roots may still suffice.
        Err(err) => log::warn!("update without the extra CA: {err:#}"),
    }
    let updater = builder.build()?;
    let Some(update) = updater
        .check()
        .await
        .with_context(|| format!("failed to check {url}"))?
    else {
        return Ok(false);
    };
    log::info!("version {} available; downloading", update.version);
    let bytes = update.download(|_, _| {}, || {}).await?;
    if !is_idle(app) {
        log::info!("update {} deferred: the app is not idle", update.version);
        return Ok(false);
    }
    // The notes go into the "Updated to X" notice on the next launch.
    if let Err(err) = state.record_pending_update(&update.version, update.body.clone()) {
        log::warn!(
            "failed to save notes for version {}: {err:#}",
            update.version
        );
    }
    // On Windows, `install` opens the installer in passive mode and exits the app.
    update.install(bytes)?;
    log::info!("version {} installed", update.version);
    Ok(true)
}

/// Checks for updates 30 s after launch and every 6 h. Debug builds do not update themselves.
pub fn spawn(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if is_idle(&app) {
                // Each check runs in a subtask: a panic is logged and the loop continues.
                let check = {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move { check_and_install(&app).await })
                };
                match check.await {
                    // Linux and macOS: the new version takes effect after reopening.
                    Ok(Ok(true)) if is_idle(&app) => app.restart(),
                    Ok(Ok(_)) => {}
                    Ok(Err(err)) => log::warn!("update: {err:#}"),
                    Err(tauri::Error::JoinError(err)) if err.is_panic() => {
                        log::error!("panic during update check; next check remains on schedule");
                    }
                    Err(err) => log::warn!("update check interrupted: {err}"),
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use eclume_sync::transport::TrustMode;

    use super::{endpoint, roots, Roots};

    const CA: &str = "-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIUZq/L15v8O8Pr4T/lykPSvtBCcvUwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZWNsdW1lIHRlc3RlMCAXDTI2MDkyNTEwNDQxNloYDzIxMjYw
OTAxMTA0NDE2WjAXMRUwEwYDVQQDDAxlY2x1bWUgdGVzdGUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAT1ysTldR1/rP5BmL3/VwD/J65t9C2TgTHLU+KacwJUxp0j
HhwK1AvDPl/7YVivmDUEI+D4dqmuaubJ9gfOZ2rMo1MwUTAdBgNVHQ4EFgQUn3Sk
yWf7HZqHcVA58oNJGvraVyMwHwYDVR0jBBgwFoAUn3SkyWf7HZqHcVA58oNJGvra
VyMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiAqogMqxEP541HD
urwVrn2LuMQiFhpsFqzijXlyfFPQmgIhALpw58Bg8XjfqCOaXRJ53v7gVlG7SPkr
8cZ14kyIWDAT
-----END CERTIFICATE-----\n";

    #[test]
    fn no_custom_ca_uses_default_client() {
        assert!(matches!(
            roots(&TrustMode::PlatformPlus(None)),
            Ok(Roots::Default)
        ));
    }

    #[test]
    fn extra_ca_becomes_updater_client_root() {
        let dir = std::env::temp_dir().join(format!("eclume-updater-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("eclume-root.crt");
        let chosen = || TrustMode::PlatformPlus(Some(path.clone()));
        let pinned = || TrustMode::Pinned(path.clone());

        std::fs::write(&path, CA).unwrap();
        assert!(matches!(roots(&pinned()), Ok(Roots::Only(_))));

        // Manually chosen, both are added to system roots; pinned, two certificates are rejected.
        std::fs::write(&path, format!("{CA}{CA}")).unwrap();
        let Ok(Roots::Merge(certs)) = roots(&chosen()) else {
            panic!("the manually chosen CA is added to system roots");
        };
        assert_eq!(certs.len(), 2);
        assert!(roots(&pinned()).is_err());

        std::fs::write(&path, "sem certificado").unwrap();
        assert!(roots(&chosen()).is_err());
        assert!(roots(&pinned()).is_err());
        let missing = TrustMode::Pinned(dir.join("nao-existe.pem"));
        assert!(roots(&missing).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn endpoint_is_in_web_url_downloads() {
        assert_eq!(
            endpoint("https://192.0.2.10:8443").unwrap().as_str(),
            "https://192.0.2.10:8443/downloads/latest.json"
        );
        assert_eq!(
            endpoint("https://eclume.local/").unwrap().as_str(),
            "https://eclume.local/downloads/latest.json"
        );
    }
}
