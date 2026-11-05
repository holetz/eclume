//! Where the credential lives: the device credential issued by sign-in or pairing, or the PAT
//! pasted in an earlier version; both are `eclp_` tokens and use the same entry in the OS keyring
//! (Secret Service on Linux, Credential Manager on Windows, Keychain on macOS), through the
//! `keyring` crate. Without an available keyring (a session without Secret Service, for example),
//! in a `pat` file in the config directory with mode 0600, the same protection as a `~/.netrc`, and
//! the window warns the user. `ECLUME_PAT` overrides both for development and tests.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::protocol::PAT_PREFIX;

/// Service and account of the keyring entry.
pub const KEYRING_SERVICE: &str = "eclume-desktop";
pub const KEYRING_ACCOUNT: &str = "pat";
/// Variable that overrides the stored PAT.
pub const PAT_ENV: &str = "ECLUME_PAT";
/// Fallback filename in the config directory.
pub const PAT_FILE: &str = "pat";

/// Where the PAT in use came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PatSource {
    Env,
    Keyring,
    File,
}

/// A secret vault (the OS keyring, or a fake in tests).
pub trait SecretBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, secret: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

/// The OS keyring.
#[cfg(feature = "os-keyring")]
pub struct OsKeyring;

#[cfg(feature = "os-keyring")]
impl OsKeyring {
    fn entry() -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).context("chaveiro do SO indisponível")
    }
}

/// Runs `op` on its own thread. The `keyring` Secret Service uses `block_on` internally and panics
/// on a thread already running a Tokio runtime (a Tauri `async` command, the updater); the panic
/// also poisons the vault's global mutex, and every subsequent access panics too. On a thread
/// without a runtime, `block_on` works, and any remaining panic becomes an error.
#[cfg(feature = "os-keyring")]
fn isolated<T: Send>(op: impl FnOnce() -> Result<T> + Send) -> Result<T> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("eclume-keyring".into())
            .spawn_scoped(scope, op)
            .context("falha ao abrir a thread do chaveiro")?
            .join()
            .unwrap_or_else(|_| bail!("o chaveiro do SO falhou (panic)"))
    })
}

#[cfg(feature = "os-keyring")]
impl SecretBackend for OsKeyring {
    fn get(&self) -> Result<Option<String>> {
        isolated(|| match Self::entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err).context("falha ao ler o chaveiro do SO"),
        })
    }

    fn set(&self, secret: &str) -> Result<()> {
        isolated(|| {
            Self::entry()?
                .set_password(secret)
                .context("falha ao gravar no chaveiro do SO")
        })
    }

    fn delete(&self) -> Result<()> {
        isolated(|| match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err).context("falha ao apagar do chaveiro do SO"),
        })
    }
}

/// Without a keyring (built without `os-keyring`): nothing stored here, and `PatStore` uses the
/// file.
pub struct NoKeyring;

impl SecretBackend for NoKeyring {
    fn get(&self) -> Result<Option<String>> {
        Ok(None)
    }

    fn set(&self, _secret: &str) -> Result<()> {
        bail!("sem chaveiro do SO neste build")
    }

    fn delete(&self) -> Result<()> {
        Ok(())
    }
}

/// Reads, writes and deletes the PAT.
pub struct PatStore {
    file: PathBuf,
    keyring: Box<dyn SecretBackend>,
    env: Option<String>,
}

impl PatStore {
    /// The real vault: OS keyring (with `os-keyring`), file in `config_dir` and the `ECLUME_PAT`
    /// variable.
    pub fn new(config_dir: &Path) -> Self {
        #[cfg(feature = "os-keyring")]
        let keyring: Box<dyn SecretBackend> = Box::new(OsKeyring);
        #[cfg(not(feature = "os-keyring"))]
        let keyring: Box<dyn SecretBackend> = Box::new(NoKeyring);
        Self::with_backend(
            config_dir.join(PAT_FILE),
            keyring,
            std::env::var(PAT_ENV).ok(),
        )
    }

    pub fn with_backend(
        file: PathBuf,
        keyring: Box<dyn SecretBackend>,
        env: Option<String>,
    ) -> Self {
        Self {
            file,
            keyring,
            env: env.filter(|pat| !pat.trim().is_empty()),
        }
    }

    /// The PAT in use and where it came from; `None` when there is none.
    pub fn load(&self) -> Result<Option<(String, PatSource)>> {
        if let Some(pat) = &self.env {
            return Ok(Some((pat.trim().to_string(), PatSource::Env)));
        }
        match self.keyring.get() {
            Ok(Some(pat)) => return Ok(Some((pat, PatSource::Keyring))),
            Ok(None) => {}
            Err(err) => log::warn!("{err:#}; trying the file"),
        }
        match std::fs::read_to_string(&self.file) {
            Ok(pat) if !pat.trim().is_empty() => {
                Ok(Some((pat.trim().to_string(), PatSource::File)))
            }
            Ok(_) => Ok(None),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err).with_context(|| format!("falha ao ler {}", self.file.display())),
        }
    }

    /// Stores the PAT in the keyring; without a keyring, in the 0600 file. Returns where it was
    /// stored.
    pub fn save(&self, pat: &str) -> Result<PatSource> {
        let pat = pat.trim();
        if !pat.starts_with(PAT_PREFIX) || pat.len() <= PAT_PREFIX.len() {
            bail!("PAT inválido: um PAT do eclume começa com {PAT_PREFIX}");
        }
        match self.keyring.set(pat) {
            Ok(()) => {
                self.remove_file()?;
                Ok(PatSource::Keyring)
            }
            Err(err) => {
                log::warn!("{err:#}; storing the PAT in {}", self.file.display());
                write_private(&self.file, pat)?;
                Ok(PatSource::File)
            }
        }
    }

    /// Forgets the stored PAT (keyring and file).
    pub fn clear(&self) -> Result<()> {
        if let Err(err) = self.keyring.delete() {
            log::warn!("{err:#}");
        }
        self.remove_file()
    }

    fn remove_file(&self) -> Result<()> {
        match std::fs::remove_file(&self.file) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => {
                Err(err).with_context(|| format!("falha ao apagar {}", self.file.display()))
            }
        }
    }
}

/// Writes a file readable only by its owner (0600 on Unix; on Windows, the user's config directory
/// is already restricted to them).
fn write_private(path: &Path, content: &str) -> Result<()> {
    use std::io::Write;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("falha ao criar {}", dir.display()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        // An existing file keeps its old mode on `open`: fix it before writing.
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("falha ao gravar {}", path.display()))?;
    file.write_all(content.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use anyhow::anyhow;

    use super::*;

    /// In-memory keyring; `broken` simulates an OS without Secret Service.
    #[derive(Clone, Default)]
    struct FakeKeyring {
        secret: Arc<Mutex<Option<String>>>,
        broken: bool,
    }

    impl SecretBackend for FakeKeyring {
        fn get(&self) -> Result<Option<String>> {
            if self.broken {
                return Err(anyhow!("sem Secret Service"));
            }
            Ok(self.secret.lock().unwrap().clone())
        }
        fn set(&self, secret: &str) -> Result<()> {
            if self.broken {
                return Err(anyhow!("sem Secret Service"));
            }
            *self.secret.lock().unwrap() = Some(secret.to_string());
            Ok(())
        }
        fn delete(&self) -> Result<()> {
            *self.secret.lock().unwrap() = None;
            Ok(())
        }
    }

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-pat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn stores_in_keyring_and_reads_back() {
        let dir = dir("chaveiro");
        let keyring = FakeKeyring::default();
        let store = PatStore::with_backend(dir.join(PAT_FILE), Box::new(keyring.clone()), None);
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(store.save(" eclp_abc\n").unwrap(), PatSource::Keyring);
        assert_eq!(keyring.secret.lock().unwrap().as_deref(), Some("eclp_abc"));
        assert_eq!(
            store.load().unwrap(),
            Some(("eclp_abc".into(), PatSource::Keyring))
        );
        assert!(!dir.join(PAT_FILE).exists());
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn without_keyring_falls_back_to_private_file() {
        let dir = dir("arquivo");
        let broken = FakeKeyring {
            broken: true,
            ..FakeKeyring::default()
        };
        let store = PatStore::with_backend(dir.join(PAT_FILE), Box::new(broken), None);
        assert_eq!(store.save("eclp_xyz").unwrap(), PatSource::File);
        assert_eq!(
            store.load().unwrap(),
            Some(("eclp_xyz".into(), PatSource::File))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(PAT_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn returning_keyring_clears_file() {
        let dir = dir("migra");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(PAT_FILE), "eclp_velho").unwrap();
        let store =
            PatStore::with_backend(dir.join(PAT_FILE), Box::new(FakeKeyring::default()), None);
        assert_eq!(
            store.load().unwrap(),
            Some(("eclp_velho".into(), PatSource::File))
        );
        store.save("eclp_novo").unwrap();
        assert!(!dir.join(PAT_FILE).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn environment_variable_overrides_and_invalid_pat_is_rejected() {
        let store = PatStore::with_backend(
            dir("env").join(PAT_FILE),
            Box::new(FakeKeyring::default()),
            Some("eclp_env".into()),
        );
        assert_eq!(
            store.load().unwrap(),
            Some(("eclp_env".into(), PatSource::Env))
        );
        assert!(store.save("ghp_token").is_err());
        assert!(store.save("eclp_").is_err());
    }

    #[cfg(feature = "os-keyring")]
    #[test]
    fn keyring_runs_on_own_thread_and_panic_becomes_error() {
        // Outside the caller's thread, the Secret Service's `block_on` does not see its runtime.
        let name = isolated(|| Ok(std::thread::current().name().map(str::to_owned))).unwrap();
        assert_eq!(name.as_deref(), Some("eclume-keyring"));
        let err = isolated::<()>(|| panic!("poisoned vault")).unwrap_err();
        assert_eq!(err.to_string(), "o chaveiro do SO falhou (panic)");
    }
}
