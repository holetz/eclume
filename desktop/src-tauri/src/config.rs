//! App configuration in `config.json` in the system config directory. Every field has a default,
//! so `config.json` from an earlier version can still be read.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use eclume_detect::DetectionConfig;
use serde::{Deserialize, Deserializer, Serialize};

use crate::shortcuts::Shortcuts;

/// Environment variable that overrides `web_url` without changing the file.
pub const WEB_URL_ENV: &str = "ECLUME_WEB_URL";
/// Environment variable that overrides the API address (dev, with separate web and API).
pub const API_URL_ENV: &str = "ECLUME_API_URL";
/// Default days to keep the local file after server confirmation.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
/// Maximum configurable retention (10 years).
pub const MAX_RETENTION_DAYS: u32 = 3650;
/// Silence stops offered for voice notes, in seconds (besides "Never").
pub const NOTE_SILENCE_CHOICES: [u32; 3] = [2, 4, 8];
/// Default voice note silence stop, in seconds.
pub const DEFAULT_NOTE_SILENCE_S: u32 = 4;
/// Window themes; `system` follows `prefers-color-scheme`.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

fn default_theme() -> String {
    THEMES[0].to_string()
}

fn default_true() -> bool {
    true
}

/// Default number of recent recordings shown in the panel at the top of the window.
pub const DEFAULT_RECENT_COUNT: u8 = 5;
/// Maximum number in the recent recordings panel; `0` hides it.
pub const MAX_RECENT_COUNT: u8 = 10;

fn default_recent_count() -> u8 {
    DEFAULT_RECENT_COUNT
}

/// Default number of recent recordings shown in the tray menu.
pub const DEFAULT_TRAY_RECENT_COUNT: u8 = 1;

fn default_tray_recent_count() -> u8 {
    DEFAULT_TRAY_RECENT_COUNT
}

/// Transcription languages offered in the Audio tab, besides `auto` (detect) and the account
/// default (`null`).
pub const LANGUAGES: [&str; 4] = ["auto", "pt", "es", "en"];

/// "None" for microphone or system audio: the source is excluded.
pub const SOURCE_NONE: &str = "none";
/// System audio following the output in use, the default.
pub const SYSTEM_FOLLOW: &str = "follow";

/// Server embedded in the installer by the per-server release (`desktop-release.yml` passes
/// repository variables to `tauri build`): first run shows it as "Came with this installer"
/// and pins the CA by its fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EmbeddedServer {
    pub url: String,
    pub ca_sha256: Option<String>,
}

/// Server embedded in this build; `None` in a build without `ECLUME_SERVER_URL`.
pub fn embedded_server() -> Option<EmbeddedServer> {
    embedded_from(
        option_env!("ECLUME_SERVER_URL"),
        option_env!("ECLUME_SERVER_CA_SHA256"),
    )
}

/// Reads build variables: empty (missing repository variable) or invalid values are ignored.
fn embedded_from(url: Option<&str>, ca_sha256: Option<&str>) -> Option<EmbeddedServer> {
    let url = url
        .map(str::trim)
        .filter(|url| validate_web_url(url).is_ok())?;
    Some(EmbeddedServer {
        url: url.trim_end_matches('/').to_string(),
        ca_sha256: ca_sha256.and_then(|ca| eclume_sync::pin::normalize_fingerprint(ca).ok()),
    })
}

/// Account this computer signed in to with email and password or a pairing code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub email: String,
    /// Device token that the web can unlink.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

/// How the app connects to the server, which determines first run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    /// No stored credential: the window opens on first run.
    FirstRun,
    /// PAT pasted in an earlier version (or `ECLUME_PAT`): keeps syncing, and the Server tab
    /// offers sign-in with email and password.
    PersonalToken,
    /// Device credential for an account.
    Account,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// eclume server address: eclume web (tray item) and, without `api_url`, the API.
    /// Empty in a build without an embedded server until first run selects one.
    #[serde(default = "default_web_url")]
    pub web_url: String,
    /// Account this computer signed in to; `null` before sign-in and with an old PAT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// API address when it differs from eclume web.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    /// PEM with the extra trusted CA (Caddy internal CA, `tls internal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_path: Option<PathBuf>,
    /// Meeting detection and per-app policies.
    #[serde(default)]
    pub detection: DetectionConfig,
    /// Days to keep the local file after the server confirms the recording: `0` deletes at once,
    /// `null` keeps it forever.
    #[serde(default = "default_retention_days")]
    pub retention_days: Option<u32>,
    /// Silence that ends a voice note, in seconds; `null` means "Never".
    #[serde(default = "default_note_silence")]
    pub note_silence_s: Option<u32>,
    /// Global shortcuts for recording, new voice note, and marker.
    #[serde(default)]
    pub shortcuts: Shortcuts,
    /// Transcription language (`pt`, `es`, `en` or `auto`, detect); `null` uses the account
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Window theme: `system` (follows the system), `light` or `dark`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Notify when the automatic summary of an uploaded recording is ready.
    #[serde(default = "default_true")]
    pub notify_summary: bool,
    /// Start with the computer: the app reconciles system registration with this preference on
    /// each open and save. Enabled by default, also for config from an earlier version.
    #[serde(default = "default_true")]
    pub autostart: bool,
    /// Number of recent recordings in the panel at the top of the window (0 to 10, `0` hides it).
    /// Five by default, also for config from an earlier version.
    #[serde(default = "default_recent_count")]
    pub recent_count: u8,
    /// Number of recent recordings in the tray menu Recent section (0 to 10, `0` hides it),
    /// separate from the window. One by default, also for config from an earlier version.
    #[serde(default = "default_tray_recent_count")]
    pub tray_recent_count: u8,
    /// Local folder mirroring library summaries and transcripts.
    #[serde(default)]
    pub mirror: MirrorConfig,
    /// Microphone by name; `null` means system default and `"none"` means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic: Option<String>,
    /// System audio in meetings: `"follow"` follows the output in use, an output id pins it,
    /// and `"none"` disables recording. Also reads the earlier version's `system_audio` boolean.
    #[serde(
        default = "default_system_source",
        alias = "system_audio",
        deserialize_with = "system_source_or_legacy"
    )]
    pub system_source: String,
    /// Last version opened; `null` before the first open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_version: Option<String>,
    /// Version installed by the updater, with notes, stored before installation; removed when
    /// the person dismisses the "Updated to X" notice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_update: Option<PendingUpdate>,
}

/// Synced folder: Markdown summaries and JSONL transcripts, one subfolder per collection
/// (contract in docs/standards/code/desktop-pasta-sincronizada.md). Disabled until the person
/// chooses a folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Mirror root; `null` until the person chooses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<PathBuf>,
    /// Also mirror transcripts (`.jsonl`).
    #[serde(default = "default_true")]
    pub transcripts: bool,
}

impl Default for MirrorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: None,
            transcripts: true,
        }
    }
}

impl MirrorConfig {
    fn validate(&self) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let Some(dir) = &self.dir else {
            bail!("Escolha a pasta dos resumos para ligar a sincronização");
        };
        if !dir.is_absolute() {
            bail!("A pasta dos resumos precisa ser um caminho completo");
        }
        if dir.parent().is_none() {
            bail!("Escolha uma pasta, não a raiz do disco");
        }
        if dir.is_file() {
            bail!("A pasta dos resumos é um arquivo");
        }
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        if home.is_some_and(|home| Path::new(&home) == dir.as_path()) {
            // A collection named "Documents" would write to ~/Documents.
            bail!("Escolha uma subpasta, não a pasta pessoal");
        }
        Ok(())
    }
}

/// Update installed by the updater: version and release notes (`body` of
/// `latest.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingUpdate {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_system_source() -> String {
    SYSTEM_FOLLOW.to_string()
}

/// Current `system_source` or legacy `system_audio`: `true` followed the output in use.
fn system_source_or_legacy<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Field {
        Legacy(bool),
        Source(String),
    }
    Ok(match Field::deserialize(deserializer)? {
        Field::Legacy(true) => default_system_source(),
        Field::Legacy(false) => SOURCE_NONE.to_string(),
        Field::Source(source) => source,
    })
}

/// Embedded server; a build without an embedded server starts with no server (empty).
fn default_web_url() -> String {
    embedded_server()
        .map(|server| server.url)
        .unwrap_or_default()
}

fn default_retention_days() -> Option<u32> {
    Some(DEFAULT_RETENTION_DAYS)
}

fn default_note_silence() -> Option<u32> {
    Some(DEFAULT_NOTE_SILENCE_S)
}

impl Default for Config {
    fn default() -> Self {
        Self {
            web_url: default_web_url(),
            account: None,
            api_url: None,
            ca_path: None,
            detection: DetectionConfig::default(),
            retention_days: default_retention_days(),
            note_silence_s: default_note_silence(),
            shortcuts: Shortcuts::default(),
            language: None,
            theme: default_theme(),
            notify_summary: true,
            autostart: true,
            recent_count: DEFAULT_RECENT_COUNT,
            tray_recent_count: DEFAULT_TRAY_RECENT_COUNT,
            mirror: MirrorConfig::default(),
            mic: None,
            system_source: default_system_source(),
            last_version: None,
            pending_update: None,
        }
    }
}

impl Config {
    /// First run appears without a stored credential; a PAT without `account` comes from an
    /// earlier version and remains valid.
    pub fn connection(&self, has_token: bool) -> Connection {
        match (has_token, &self.account) {
            (false, _) => Connection::FirstRun,
            (true, None) => Connection::PersonalToken,
            (true, Some(_)) => Connection::Account,
        }
    }

    /// Window "Updated to X" notice: the stored update is for this version.
    pub fn update_notice(&self, current: &str) -> Option<&PendingUpdate> {
        self.pending_update
            .as_ref()
            .filter(|update| update.version == current)
    }

    /// Records opening `current`. Returns the update on the first open after the updater
    /// installed it (so the notification appears only once); a fresh installation, without
    /// `last_version`, has no notice.
    pub fn open_version(&mut self, current: &str) -> Option<PendingUpdate> {
        let previous = self.last_version.replace(current.to_string());
        let just_updated = previous.as_deref().is_some_and(|v| v != current);
        if previous.is_none() {
            self.pending_update = None;
        }
        just_updated
            .then(|| self.update_notice(current).cloned())
            .flatten()
    }

    /// Reads the file; missing or unreadable uses defaults (see [`Config::load_checked`]).
    pub fn load(path: &Path) -> Self {
        Self::load_checked(path).0
    }

    /// Reads the file; missing uses defaults. If unreadable, saves it alongside as
    /// `config.json.ilegivel-<ms>` before using defaults, and returns the copy path so the
    /// window can notify the person.
    pub fn load_checked(path: &Path) -> (Self, Option<PathBuf>) {
        let problem = match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(config) => return (config, None),
                Err(err) => err.to_string(),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return (Self::default(), None)
            }
            Err(err) => err.to_string(),
        };
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let copy = path.with_file_name(format!("{}.ilegivel-{ms}", file_name(path)));
        log::warn!(
            "unreadable config at {} ({problem}); saved to {} and using defaults",
            path.display(),
            copy.display()
        );
        match std::fs::rename(path, &copy) {
            Ok(()) => (Self::default(), Some(copy)),
            Err(err) => {
                log::warn!("failed to save unreadable config: {err}");
                (Self::default(), None)
            }
        }
    }

    /// Writes through a neighboring temporary file (`.config.json.tmp`), with `sync_all`, then
    /// renames: a crash never leaves a partial file. On failure, the temporary file is deleted.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("falha ao criar {}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(self)?;
        let tmp = path.with_file_name(format!(".{}.tmp", file_name(path)));
        let written = (|| {
            let mut file = std::fs::File::create(&tmp)?;
            std::io::Write::write_all(&mut file, text.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&tmp, path)
        })();
        if let Err(err) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(err).with_context(|| format!("falha ao gravar {}", path.display()));
        }
        Ok(())
    }

    /// Effective address: the environment variable, if present, otherwise the file.
    pub fn effective_web_url(&self, env: Option<String>) -> String {
        env.filter(|url| validate_web_url(url).is_ok())
            .unwrap_or_else(|| self.web_url.clone())
    }

    /// Effective API address: the environment variable, `api_url`, or the server itself.
    pub fn effective_api_url(&self, env: Option<String>, web_env: Option<String>) -> String {
        env.filter(|url| validate_web_url(url).is_ok())
            .or_else(|| self.api_url.clone())
            .unwrap_or_else(|| self.effective_web_url(web_env))
    }

    /// Validates what the window can send: addresses, readable CA, and retention within bounds.
    /// An empty server means "no server yet" in a build without an embedded server.
    pub fn validate(&self) -> Result<()> {
        if !self.web_url.is_empty() {
            validate_web_url(&self.web_url)?;
        }
        if let Some(api_url) = &self.api_url {
            validate_web_url(api_url).context("endereço da API")?;
        }
        if let Some(ca_path) = &self.ca_path {
            eclume_sync::transport::read_pem_certs(ca_path)?;
        }
        if self
            .retention_days
            .is_some_and(|days| days > MAX_RETENTION_DAYS)
        {
            bail!("retenção acima de {MAX_RETENTION_DAYS} dias");
        }
        if let Some(seconds) = self.note_silence_s {
            if !NOTE_SILENCE_CHOICES.contains(&seconds) {
                bail!("parada por silêncio da nota: use 2, 4 ou 8 s, ou Nunca");
            }
        }
        if !THEMES.contains(&self.theme.as_str()) {
            bail!("tema: use system, light ou dark");
        }
        if self.recent_count > MAX_RECENT_COUNT {
            bail!("gravações recentes na janela: no máximo {MAX_RECENT_COUNT}");
        }
        if self.tray_recent_count > MAX_RECENT_COUNT {
            bail!("gravações recentes no menu da bandeja: no máximo {MAX_RECENT_COUNT}");
        }
        if let Some(language) = &self.language {
            if !LANGUAGES.contains(&language.as_str()) {
                bail!("idioma da transcrição: use pt, es, en ou auto, ou o padrão da conta");
            }
        }
        self.mirror.validate()?;
        if self.mic.as_deref() == Some(SOURCE_NONE) && self.system_source == SOURCE_NONE {
            bail!("Escolha ao menos uma fonte de áudio");
        }
        self.shortcuts.validate()
    }
}

/// Accepts only `http(s)://` addresses with a host.
pub fn validate_web_url(url: &str) -> Result<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    match rest {
        Some(host)
            if !host.is_empty()
                && !host.starts_with('/')
                && !host.contains(char::is_whitespace) =>
        {
            Ok(())
        }
        _ => bail!("endereço inválido: use http:// ou https:// seguido do host"),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_defaults_to_enabled_and_remembers_disabling() {
        let old: Config = serde_json::from_str("{}").unwrap();
        assert!(old.autostart);
        let disabled = Config {
            autostart: false,
            ..Config::default()
        };
        let json = serde_json::to_string(&disabled).unwrap();
        let read: Config = serde_json::from_str(&json).unwrap();
        assert!(!read.autostart);
    }

    #[test]
    fn window_recent_recordings_default_to_5_and_range_from_0_to_10() {
        let old: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(old.recent_count, 5);
        assert_eq!(Config::default().recent_count, DEFAULT_RECENT_COUNT);
        let mut config = Config {
            recent_count: 0,
            ..Config::default()
        };
        config.validate().unwrap();
        config.recent_count = 10;
        config.validate().unwrap();
        let read: Config = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(read.recent_count, 10);
        config.recent_count = 11;
        assert!(config.validate().is_err());
    }

    #[test]
    fn tray_recent_recordings_default_to_1_and_range_from_0_to_10() {
        let old: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(old.tray_recent_count, 1);
        assert_eq!(old.recent_count, 5);
        assert_eq!(
            Config::default().tray_recent_count,
            DEFAULT_TRAY_RECENT_COUNT
        );
        let mut config = Config {
            tray_recent_count: 0,
            ..Config::default()
        };
        config.validate().unwrap();
        config.tray_recent_count = 10;
        config.validate().unwrap();
        let read: Config = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!((read.tray_recent_count, read.recent_count), (10, 5));
        config.tray_recent_count = 11;
        assert!(config.validate().is_err());
    }

    #[test]
    fn theme_and_summary_notice_have_defaults_and_theme_is_restricted() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.theme, "system");
        assert!(config.notify_summary);
        let mut config = Config {
            theme: "dark".into(),
            notify_summary: false,
            ..Config::default()
        };
        config.validate().unwrap();
        let json = serde_json::to_string(&config).unwrap();
        let read: Config = serde_json::from_str(&json).unwrap();
        assert_eq!((read.theme.as_str(), read.notify_summary), ("dark", false));
        config.theme = "sepia".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn synced_folder_defaults_to_disabled_and_reads_old_config() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.mirror, MirrorConfig::default());
        assert!(!config.mirror.enabled);
        assert!(config.mirror.transcripts);
        assert_eq!(config.mirror.dir, None);
        assert!(!serde_json::to_string(&config).unwrap().contains("\"dir\""));
        config.validate().unwrap();
    }

    #[test]
    fn enabling_synced_folder_requires_an_absolute_path_other_than_root() {
        let dir = std::env::temp_dir();
        let mut config = Config::default();
        config.mirror.enabled = true;
        assert!(config.validate().is_err());
        config.mirror.dir = Some(PathBuf::from("relativa/pasta"));
        assert!(config.validate().is_err());
        config.mirror.dir = dir.ancestors().last().map(Path::to_path_buf);
        assert!(config.validate().is_err());
        // The home folder is also rejected: collections become its subfolders.
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            config.mirror.dir = Some(PathBuf::from(home));
            assert!(config.validate().is_err());
        }
        config.mirror.dir = Some(dir.join("eclume-resumos"));
        config.validate().unwrap();
        let json = serde_json::to_string(&config).unwrap();
        let read: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(read.mirror, config.mirror);
        // When disabled, the folder is not checked.
        config.mirror.enabled = false;
        config.mirror.dir = Some(PathBuf::from("relativa"));
        config.validate().unwrap();
    }

    #[test]
    fn transcription_language_is_optional_and_restricted() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.language, None);
        assert!(!serde_json::to_string(&config).unwrap().contains("language"));
        let mut config = Config {
            language: Some("es".into()),
            ..Config::default()
        };
        config.validate().unwrap();
        config.language = Some("auto".into());
        config.validate().unwrap();
        config.language = Some("fr".into());
        assert!(config.validate().is_err());
    }

    #[test]
    fn default_config_uses_embedded_server_or_none() {
        let expected = embedded_server().map(|s| s.url).unwrap_or_default();
        assert_eq!(Config::default().web_url, expected);
        // Without a server, config remains valid: first run selects one.
        let without_server = Config {
            web_url: String::new(),
            ..Config::default()
        };
        assert!(without_server.validate().is_ok());
        // Old config without `web_url` gets the build default (embedded in installers).
        let old: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(old.web_url, expected);
    }

    #[test]
    fn server_is_embedded_in_build() {
        // Verification also runs with ECLUME_SERVER_URL=https://eclume.teste:8443.
        match option_env!("ECLUME_SERVER_URL").filter(|url| !url.trim().is_empty()) {
            Some(url) => {
                let server = embedded_server().expect("the build embedded a server");
                assert_eq!(server.url, url.trim().trim_end_matches('/'));
                assert_eq!(Config::default().web_url, server.url);
            }
            None => assert_eq!(embedded_server(), None),
        }
    }

    #[test]
    fn empty_or_invalid_build_variables_do_not_embed() {
        let ca = "98E209F5457514B7B12EC349D22B3B0D93C03C3F10E52350EA5F9E0B3D97792F";
        assert_eq!(
            embedded_from(Some(" https://eclume.teste:8443/ "), Some(ca)),
            Some(EmbeddedServer {
                url: "https://eclume.teste:8443".into(),
                ca_sha256: Some(ca.to_ascii_lowercase()),
            })
        );
        assert_eq!(
            embedded_from(Some("https://eclume.teste"), Some("")),
            Some(EmbeddedServer {
                url: "https://eclume.teste".into(),
                ca_sha256: None,
            })
        );
        assert_eq!(embedded_from(Some(""), Some(ca)), None);
        assert_eq!(embedded_from(Some("eclume.teste"), None), None);
        assert_eq!(embedded_from(None, None), None);
    }

    #[test]
    fn first_run_only_without_credential() {
        let mut config = Config::default();
        assert_eq!(config.connection(false), Connection::FirstRun);
        // Existing PAT users (0.1.x) do not see first run.
        assert_eq!(config.connection(true), Connection::PersonalToken);
        config.account = Some(Account {
            email: "ana@exemplo.com.br".into(),
            token_id: Some("t-1".into()),
            server_name: Some("eclume".into()),
        });
        assert_eq!(config.connection(true), Connection::Account);
        // Credential missing from the keyring: sign in again.
        assert_eq!(config.connection(false), Connection::FirstRun);
        let back: Config = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(back.account, config.account);
        let legacy: Config =
            serde_json::from_str(r#"{"web_url": "https://eclume.exemplo:8443"}"#).unwrap();
        assert_eq!(legacy.account, None);
    }

    #[test]
    fn missing_or_invalid_config_uses_defaults() {
        let dir = std::env::temp_dir().join(format!("eclume-config-{}", std::process::id()));
        let path = dir.join("config.json");
        assert_eq!(Config::load_checked(&path), (Config::default(), None));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ quebrado").unwrap();
        let (config, copy) = Config::load_checked(&path);
        assert_eq!(config, Config::default());
        // The unreadable file is saved alongside, with its contents, before using defaults.
        let copy = copy.unwrap();
        assert!(copy
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("config.json.ilegivel-"));
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "{ quebrado");
        assert!(!path.exists());
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(Config::load_checked(&path), (Config::default(), None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn config_writes_through_temporary_file_without_leftovers() {
        let dir = std::env::temp_dir().join(format!("eclume-config-tmp-{}", std::process::id()));
        let path = dir.join("config.json");
        Config::default().save(&path).unwrap();
        assert_eq!(Config::load(&path), Config::default());
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("config.json")]);
        // Blocked destination (a directory): writing fails and the temporary file is removed.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(Config::default().save(&path).is_err());
        assert!(!dir.join(".config.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn config_saves_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("eclume-config-rt-{}", std::process::id()));
        let path = dir.join("sub").join("config.json");
        let mut config = Config {
            web_url: "https://eclume.local".into(),
            api_url: Some("http://127.0.0.1:8000".into()),
            retention_days: None,
            ..Config::default()
        };
        config
            .detection
            .policies
            .insert(eclume_detect::AppKey::Teams, eclume_detect::Policy::Auto);
        config.save(&path).unwrap();
        assert_eq!(Config::load(&path), config);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn valid_environment_variable_overrides_config() {
        let config = Config::default();
        assert_eq!(
            config.effective_web_url(Some("http://localhost:5173".into())),
            "http://localhost:5173"
        );
        assert_eq!(
            config.effective_web_url(Some("ftp://x".into())),
            default_web_url()
        );
        assert_eq!(config.effective_web_url(None), default_web_url());
    }

    #[test]
    fn config_from_previous_version_gets_defaults() {
        let config: Config =
            serde_json::from_str(r#"{"web_url": "https://eclume.local"}"#).unwrap();
        assert_eq!(config.web_url, "https://eclume.local");
        assert_eq!(config.api_url, None);
        assert!(config.detection.enabled);
        assert_eq!(config.retention_days, Some(DEFAULT_RETENTION_DAYS));
        assert_eq!(config.note_silence_s, Some(DEFAULT_NOTE_SILENCE_S));
        assert_eq!(config.shortcuts, Shortcuts::default());
        assert_eq!(config.mic, None);
        assert_eq!(config.system_source, SYSTEM_FOLLOW);
        let keep: Config =
            serde_json::from_str(r#"{"retention_days": null, "note_silence_s": null}"#).unwrap();
        assert_eq!(keep.retention_days, None);
        assert_eq!(keep.note_silence_s, None);
    }

    #[test]
    fn legacy_system_audio_becomes_source() {
        let off: Config = serde_json::from_str(r#"{"system_audio": false}"#).unwrap();
        assert_eq!(off.system_source, SOURCE_NONE);
        let on: Config = serde_json::from_str(r#"{"system_audio": true}"#).unwrap();
        assert_eq!(on.system_source, SYSTEM_FOLLOW);
        // Saving again replaces the boolean with the source.
        let text = serde_json::to_string(&off).unwrap();
        assert!(!text.contains("system_audio"), "{text}");
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.system_source, SOURCE_NONE);
        let chosen: Config =
            serde_json::from_str(r#"{"system_source": "alsa_output.usb"}"#).unwrap();
        assert_eq!(chosen.system_source, "alsa_output.usb");
    }

    #[test]
    fn config_api_address() {
        let mut config = Config::default();
        assert_eq!(config.effective_api_url(None, None), default_web_url());
        assert_eq!(
            config.effective_api_url(None, Some("http://web:5173".into())),
            "http://web:5173"
        );
        config.api_url = Some("http://api:8000".into());
        assert_eq!(config.effective_api_url(None, None), "http://api:8000");
        assert_eq!(
            config.effective_api_url(Some("http://env:1".into()), None),
            "http://env:1"
        );
    }

    #[test]
    fn config_validates_window_input() {
        let mut config = Config::default();
        config.validate().unwrap();
        config.api_url = Some("sem-esquema".into());
        assert!(config.validate().is_err());
        config.api_url = None;
        config.retention_days = Some(MAX_RETENTION_DAYS + 1);
        assert!(config.validate().is_err());
        config.retention_days = Some(0);
        config.note_silence_s = Some(3);
        assert!(config.validate().is_err());
        config.note_silence_s = None;
        config.validate().unwrap();
        config.shortcuts.marker = config.shortcuts.note.clone();
        assert!(config.validate().is_err());
        config.shortcuts = Shortcuts::default();
        config.mic = Some(SOURCE_NONE.into());
        config.validate().unwrap();
        config.system_source = SOURCE_NONE.into();
        let err = config.validate().unwrap_err();
        assert_eq!(err.to_string(), "Escolha ao menos uma fonte de áudio");
        config.mic = None;
        config.ca_path = Some("/nao/existe.pem".into());
        let err = config.validate().unwrap_err();
        assert!(format!("{err:#}").contains("CA extra"), "{err:#}");
    }

    #[test]
    fn update_notice_once_and_until_dismissed() {
        let pending = PendingUpdate {
            version: "0.2.0".into(),
            notes: Some("Nova nota".into()),
        };
        // Fresh installation: nothing to notify.
        let mut fresh = Config::default();
        assert_eq!(fresh.open_version("0.2.0"), None);
        assert_eq!(fresh.last_version.as_deref(), Some("0.2.0"));

        let mut config = Config {
            last_version: Some("0.1.2".into()),
            pending_update: Some(pending.clone()),
            ..Config::default()
        };
        assert_eq!(config.open_version("0.2.0"), Some(pending.clone()));
        assert_eq!(config.update_notice("0.2.0"), Some(&pending));
        // Reopening does not notify again, but the window notice stays until dismissed.
        assert_eq!(config.open_version("0.2.0"), None);
        assert_eq!(config.update_notice("0.2.0"), Some(&pending));
        // A stored update that was never installed does not become a notice.
        assert_eq!(config.update_notice("0.1.2"), None);

        let text = serde_json::to_string(&config).unwrap();
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.pending_update, Some(pending));
    }

    #[test]
    fn config_validates_address() {
        assert!(validate_web_url("https://192.168.15.199:8443").is_ok());
        assert!(validate_web_url("http://localhost").is_ok());
        assert!(validate_web_url("https://").is_err());
        assert!(validate_web_url("192.168.15.199").is_err());
        assert!(validate_web_url("https://a b").is_err());
    }
}
