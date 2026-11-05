//! What the app keeps between runs, in the app's private directory: `config.json`, the pinned CA
//! (`ca.pem`) and, outside the backup, the device token (`device-token`, 0600).
//!
//! The serialized field and value names are the on-disk format of `config.json` that installed
//! apps already wrote, so they keep their original (pt-BR) names through `#[serde(rename)]`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// File name of the configuration.
pub const CONFIG_FILE: &str = "config.json";
/// File name of the pinned CA.
pub const CA_FILE: &str = "ca.pem";
/// File name of the device token, in the directory without backup.
pub const TOKEN_FILE: &str = "device-token";

/// The app's directories: `data` (config, CA, queue and recordings) and `no_backup` (the token; on
/// Android, `noBackupFilesDir`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dirs {
    pub data: PathBuf,
    pub no_backup: PathBuf,
}

impl Dirs {
    pub fn config(&self) -> PathBuf {
        self.data.join(CONFIG_FILE)
    }

    pub fn ca(&self) -> PathBuf {
        self.data.join(CA_FILE)
    }

    pub fn token(&self) -> PathBuf {
        self.no_backup.join(TOKEN_FILE)
    }

    pub fn queue(&self) -> PathBuf {
        self.data.join("queue.sqlite")
    }

    /// The recordings folder; its on-disk name is kept for installed apps.
    pub fn recordings(&self) -> PathBuf {
        self.data.join("gravacoes")
    }
}

/// The paired server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    /// Public address (`https://192.0.2.10:8443`), without a trailing slash.
    pub url: String,
    #[serde(rename = "nome")]
    pub name: String,
    /// SHA-256 (lowercase hex) of the DER of the pinned root CA.
    pub ca_sha256: String,
}

/// The audio quality: the Opus bitrate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Quality {
    /// 24 kbps, about 11 MB per hour.
    #[default]
    #[serde(rename = "padrao")]
    Standard,
    /// 48 kbps, about 22 MB per hour.
    #[serde(rename = "alta")]
    High,
}

impl Quality {
    pub fn bitrate(self) -> i32 {
        match self {
            Self::Standard => 24_000,
            Self::High => 48_000,
        }
    }
}

/// One of the user's agenda types, cached for the saved-recording sheet off the network.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgendaType {
    pub id: String,
    #[serde(rename = "nome")]
    pub name: String,
}

fn yes() -> bool {
    true
}

fn seven() -> u32 {
    7
}

/// The `config.json`. New fields come with a default, so an old file stays valid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, rename = "servidor")]
    pub server: Option<Server>,
    /// The device name (`Build.MODEL`): what the web lists and what the markers carry.
    #[serde(default)]
    pub device_name: String,
    #[serde(default = "yes")]
    pub sync_auto: bool,
    #[serde(default, rename = "qualidade")]
    pub quality: Quality,
    /// Delete from the phone the recordings synced more than `retention_days` ago.
    #[serde(default, rename = "excluir_sincronizadas")]
    pub delete_synced: bool,
    #[serde(default = "seven", rename = "reter_dias")]
    pub retention_days: u32,
    #[serde(default, rename = "tipos_de_agenda")]
    pub agenda_types: Vec<AgendaType>,
    /// The transcription language in force for the account (`GET /me/transcription`), cached so
    /// the saved-recording sheet can name the default off the network.
    #[serde(default, rename = "idioma_da_conta")]
    pub account_language: Option<String>,
    /// When `movel.json` was last read (Unix ms).
    #[serde(default, rename = "atualizacao_verificada_em")]
    pub update_checked_at: Option<i64>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: None,
            device_name: String::new(),
            sync_auto: true,
            quality: Quality::Standard,
            delete_synced: false,
            retention_days: 7,
            agenda_types: Vec::new(),
            account_language: None,
            update_checked_at: None,
        }
    }
}

impl Config {
    /// Reads `config.json`; without a file, the default configuration.
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("config inválida em {}", path.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err).with_context(|| format!("falha ao ler {}", path.display())),
        }
    }

    /// Writes by copy and swap, so a crash halfway does not leave half a JSON.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("falha ao criar {}", dir.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)
            .with_context(|| format!("falha ao gravar {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("falha ao gravar {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_round_trips() {
        let dir = std::env::temp_dir().join(format!("eclume-config-{}", std::process::id()));
        let path = dir.join(CONFIG_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let default = Config::load(&path).unwrap();
        assert!(default.sync_auto);
        assert_eq!(default.retention_days, 7);
        assert_eq!(default.quality.bitrate(), 24_000);

        let config = Config {
            server: Some(Server {
                url: "https://eclume.test".into(),
                name: "eclume".into(),
                ca_sha256: "ab".repeat(32),
            }),
            quality: Quality::High,
            ..default
        };
        config.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), config);
        // A file from an earlier version, without the new fields, stays valid.
        std::fs::write(&path, r#"{"device_name":"Pixel 8"}"#).unwrap();
        let old = Config::load(&path).unwrap();
        assert_eq!(old.device_name, "Pixel 8");
        assert!(old.sync_auto);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn on_disk_keys_stay_the_installed_format() {
        let config = Config {
            server: Some(Server {
                url: "https://eclume.test".into(),
                name: "eclume".into(),
                ca_sha256: "ab".repeat(32),
            }),
            quality: Quality::High,
            ..Config::default()
        };
        let json = serde_json::to_value(&config).unwrap();
        for key in [
            "servidor",
            "qualidade",
            "excluir_sincronizadas",
            "reter_dias",
            "tipos_de_agenda",
            "idioma_da_conta",
            "atualizacao_verificada_em",
        ] {
            assert!(json.get(key).is_some(), "{key} missing from config.json");
        }
        assert_eq!(json["qualidade"], "alta");
        assert_eq!(json["servidor"]["nome"], "eclume");
    }
}
