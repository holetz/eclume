//! Onde a credencial fica — a de dispositivo, emitida pelo login ou pelo pareamento, ou o PAT
//! colado numa versão anterior; as duas são tokens `eclp_` e usam a mesma entrada: no chaveiro do SO (Secret Service no Linux, Credential Manager no Windows,
//! Keychain no macOS), pelo crate `keyring`. Sem chaveiro disponível (sessão sem Secret Service,
//! por exemplo), num arquivo `pat` no diretório de config com permissão 0600 — o mesmo nível de
//! proteção de um `~/.netrc`, e a janela avisa. `ECLUME_PAT` sobrepõe os dois, para dev e testes.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::protocol::PAT_PREFIX;

/// Serviço e conta da entrada no chaveiro.
pub const KEYRING_SERVICE: &str = "eclume-desktop";
pub const KEYRING_ACCOUNT: &str = "pat";
/// Variável que sobrepõe o PAT guardado.
pub const PAT_ENV: &str = "ECLUME_PAT";
/// Nome do arquivo do fallback, no diretório de config.
pub const PAT_FILE: &str = "pat";

/// De onde veio o PAT em uso.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PatSource {
    Env,
    Keyring,
    File,
}

/// Um cofre de segredo (o chaveiro do SO, ou um falso nos testes).
pub trait SecretBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, secret: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

/// O chaveiro do SO.
#[cfg(feature = "os-keyring")]
pub struct OsKeyring;

#[cfg(feature = "os-keyring")]
impl OsKeyring {
    fn entry() -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).context("chaveiro do SO indisponível")
    }
}

/// Roda `op` numa thread própria. O Secret Service do `keyring` faz `block_on` por dentro e dá
/// panic numa thread que já roda um runtime Tokio (um comando `async` do Tauri, o updater); o
/// panic ainda envenena o mutex global do cofre, e todo acesso seguinte dá panic também. Numa
/// thread sem runtime o `block_on` funciona, e um panic que sobrar vira erro.
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

/// Sem chaveiro (build sem `os-keyring`): nada guardado aqui, e o `PatStore` usa o arquivo.
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

/// Lê, grava e apaga o PAT.
pub struct PatStore {
    file: PathBuf,
    keyring: Box<dyn SecretBackend>,
    env: Option<String>,
}

impl PatStore {
    /// O cofre real: chaveiro do SO (com `os-keyring`), arquivo em `config_dir` e a variável
    /// `ECLUME_PAT`.
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

    /// O PAT em uso e de onde veio; `None` quando não há nenhum.
    pub fn load(&self) -> Result<Option<(String, PatSource)>> {
        if let Some(pat) = &self.env {
            return Ok(Some((pat.trim().to_string(), PatSource::Env)));
        }
        match self.keyring.get() {
            Ok(Some(pat)) => return Ok(Some((pat, PatSource::Keyring))),
            Ok(None) => {}
            Err(err) => log::warn!("{err:#}; tentando o arquivo"),
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

    /// Guarda o PAT no chaveiro; sem chaveiro, no arquivo 0600. Devolve onde ficou.
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
                log::warn!("{err:#}; guardando o PAT em {}", self.file.display());
                write_private(&self.file, pat)?;
                Ok(PatSource::File)
            }
        }
    }

    /// Esquece o PAT guardado (chaveiro e arquivo).
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

/// Grava um arquivo legível só pelo dono (0600 no Unix; no Windows, o diretório de config do
/// usuário já é restrito a ele).
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
        // Um arquivo que já existia mantém o modo antigo no `open`: acerta antes de escrever.
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

    /// Chaveiro em memória; `broken` simula um SO sem Secret Service.
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
    fn guarda_no_chaveiro_e_le_de_volta() {
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
    fn sem_chaveiro_cai_no_arquivo_privado() {
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
    fn chaveiro_que_volta_limpa_o_arquivo() {
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
    fn variavel_de_ambiente_sobrepoe_e_pat_invalido_e_recusado() {
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
    fn chaveiro_roda_em_thread_propria_e_panic_vira_erro() {
        // Fora da thread do chamador, o `block_on` do Secret Service não vê o runtime dele.
        let name = isolated(|| Ok(std::thread::current().name().map(str::to_owned))).unwrap();
        assert_eq!(name.as_deref(), Some("eclume-keyring"));
        let err = isolated::<()>(|| panic!("cofre envenenado")).unwrap_err();
        assert_eq!(err.to_string(), "o chaveiro do SO falhou (panic)");
    }
}
