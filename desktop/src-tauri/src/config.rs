//! Configuração do app, em `config.json` no diretório de config do sistema. Todo campo tem
//! padrão, então um `config.json` de uma versão anterior continua lendo.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use eclume_detect::DetectionConfig;
use serde::{Deserialize, Deserializer, Serialize};

use crate::shortcuts::Shortcuts;

/// Endereço do eclume web quando o build não embutiu servidor nenhum (build local, e a
/// `config.json` de uma versão anterior sem `web_url`).
pub const DEFAULT_WEB_URL: &str = "https://192.168.15.199:8443";
/// Variável de ambiente que sobrepõe `web_url` sem mexer no arquivo.
pub const WEB_URL_ENV: &str = "ECLUME_WEB_URL";
/// Variável de ambiente que sobrepõe o endereço da API (dev, com web e API separados).
pub const API_URL_ENV: &str = "ECLUME_API_URL";
/// Dias que o arquivo local fica depois da confirmação do servidor, por padrão.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
/// Teto da retenção configurável (10 anos).
pub const MAX_RETENTION_DAYS: u32 = 3650;
/// As paradas por silêncio que a nota oferece, em segundos (além de "Nunca").
pub const NOTE_SILENCE_CHOICES: [u32; 3] = [2, 4, 8];
/// A parada por silêncio padrão da nota, em segundos.
pub const DEFAULT_NOTE_SILENCE_S: u32 = 4;
/// "Nenhum" no microfone ou no áudio do sistema: a fonte fica de fora.
/// Os temas da janela; `system` acompanha o `prefers-color-scheme`.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

fn default_theme() -> String {
    THEMES[0].to_string()
}

fn default_true() -> bool {
    true
}

/// Os idiomas de transcrição que a aba Áudio oferece, além do automático (o padrão do servidor).
pub const LANGUAGES: [&str; 3] = ["pt", "es", "en"];

pub const SOURCE_NONE: &str = "none";
/// O áudio do sistema seguindo a saída em uso, o padrão.
pub const SYSTEM_FOLLOW: &str = "follow";

/// O servidor embutido no instalador pelo release por servidor (`desktop-release.yml` passa as
/// variáveis do repositório ao `tauri build`): a primeira execução o mostra como "Veio com este
/// instalador" e fixa a CA pela impressão digital.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EmbeddedServer {
    pub url: String,
    pub ca_sha256: Option<String>,
}

/// O servidor embutido neste build; `None` num build sem `ECLUME_SERVER_URL`.
pub fn embedded_server() -> Option<EmbeddedServer> {
    embedded_from(
        option_env!("ECLUME_SERVER_URL"),
        option_env!("ECLUME_SERVER_CA_SHA256"),
    )
}

/// Lê as variáveis do build: vazias (variável do repositório ausente) ou inválidas não valem.
fn embedded_from(url: Option<&str>, ca_sha256: Option<&str>) -> Option<EmbeddedServer> {
    let url = url
        .map(str::trim)
        .filter(|url| validate_web_url(url).is_ok())?;
    Some(EmbeddedServer {
        url: url.trim_end_matches('/').to_string(),
        ca_sha256: ca_sha256.and_then(|ca| eclume_sync::pin::normalize_fingerprint(ca).ok()),
    })
}

/// A conta em que este computador entrou com e-mail e senha ou código de pareamento.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub email: String,
    /// O token de dispositivo, que a web desvincula.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

/// Como o app fala com o servidor, o que decide a primeira execução.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    /// Nenhuma credencial guardada: a janela abre na primeira execução.
    FirstRun,
    /// Um PAT colado numa versão anterior (ou `ECLUME_PAT`): continua sincronizando, e a aba
    /// Servidor oferece entrar com e-mail e senha.
    PersonalToken,
    /// A credencial de dispositivo de uma conta.
    Account,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Endereço do servidor do eclume: o eclume web (item da bandeja) e, sem `api_url`, a API.
    #[serde(default = "default_web_url")]
    pub web_url: String,
    /// A conta em que este computador entrou; `null` antes de entrar e com um PAT antigo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// Endereço da API quando difere do eclume web.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    /// PEM com a CA extra a confiar (a CA interna do Caddy, `tls internal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_path: Option<PathBuf>,
    /// Detecção de reuniões e políticas por app.
    #[serde(default)]
    pub detection: DetectionConfig,
    /// Dias que o arquivo local fica depois de o servidor confirmar a gravação: `0` apaga logo,
    /// `null` guarda para sempre.
    #[serde(default = "default_retention_days")]
    pub retention_days: Option<u32>,
    /// Silêncio que encerra uma nota por voz, em segundos; `null` é "Nunca".
    #[serde(default = "default_note_silence")]
    pub note_silence_s: Option<u32>,
    /// Atalhos globais de gravar, nova nota e marcador.
    #[serde(default)]
    pub shortcuts: Shortcuts,
    /// Idioma da transcrição (`pt`, `es` ou `en`); `null` deixa o padrão do servidor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Tema da janela: `system` (acompanha o sistema), `light` ou `dark`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Avisar quando o resumo automático de uma gravação enviada fica pronto.
    #[serde(default = "default_true")]
    pub notify_summary: bool,
    /// A pasta local que espelha os resumos e as transcrições da biblioteca.
    #[serde(default)]
    pub mirror: MirrorConfig,
    /// O microfone pelo nome; `null` é o padrão do sistema e `"none"`, nenhum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic: Option<String>,
    /// O áudio do sistema nas reuniões: `"follow"` segue a saída em uso, o id de uma saída a
    /// fixa e `"none"` não grava. Lê também o `system_audio` booleano da versão anterior.
    #[serde(
        default = "default_system_source",
        alias = "system_audio",
        deserialize_with = "system_source_or_legacy"
    )]
    pub system_source: String,
    /// A versão que abriu por último; `null` antes da primeira abertura.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_version: Option<String>,
    /// A versão que o updater instalou, com as notas, guardada antes de instalar; some quando a
    /// pessoa fecha o aviso "Atualizado para X".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_update: Option<PendingUpdate>,
}

/// A pasta sincronizada: resumos em Markdown e transcrições em JSONL, uma subpasta por Collection
/// (contrato em docs/standards/code/desktop-pasta-sincronizada.md). Desligada até a pessoa
/// escolher a pasta.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorConfig {
    #[serde(default)]
    pub enabled: bool,
    /// A raiz do espelho; `null` até a pessoa escolher.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<PathBuf>,
    /// Espelhar também as transcrições (`.jsonl`).
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
            // Uma Collection chamada "Documents" escreveria em ~/Documents.
            bail!("Escolha uma subpasta, não a pasta pessoal");
        }
        Ok(())
    }
}

/// Uma atualização instalada pelo updater: a versão e as notas do release (`body` do
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

/// O `system_source` de agora ou o `system_audio` antigo: `true` seguia a saída em uso.
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

/// O servidor embutido, ou o padrão de um build sem servidor.
fn default_web_url() -> String {
    embedded_server().map_or_else(|| DEFAULT_WEB_URL.to_string(), |server| server.url)
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
            mirror: MirrorConfig::default(),
            mic: None,
            system_source: default_system_source(),
            last_version: None,
            pending_update: None,
        }
    }
}

impl Config {
    /// A primeira execução aparece sem credencial guardada; um PAT sem `account` é de uma versão
    /// anterior e segue valendo.
    pub fn connection(&self, has_token: bool) -> Connection {
        match (has_token, &self.account) {
            (false, _) => Connection::FirstRun,
            (true, None) => Connection::PersonalToken,
            (true, Some(_)) => Connection::Account,
        }
    }

    /// O aviso "Atualizado para X" da janela: a atualização guardada é a desta versão.
    pub fn update_notice(&self, current: &str) -> Option<&PendingUpdate> {
        self.pending_update
            .as_ref()
            .filter(|update| update.version == current)
    }

    /// Registra a abertura de `current`. Devolve a atualização quando esta é a primeira abertura
    /// depois de o updater instalá-la (para a notificação sair uma vez só); na primeira
    /// instalação, sem `last_version`, não há aviso.
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

    /// Lê o arquivo; ausente ou inválido cai no padrão (inválido fica registrado no log).
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                log::warn!(
                    "config inválida em {}, usando o padrão: {err}",
                    path.display()
                );
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("falha ao criar {}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text).with_context(|| format!("falha ao gravar {}", path.display()))
    }

    /// O endereço em vigor: o da variável de ambiente, se houver, senão o do arquivo.
    pub fn effective_web_url(&self, env: Option<String>) -> String {
        env.filter(|url| validate_web_url(url).is_ok())
            .unwrap_or_else(|| self.web_url.clone())
    }

    /// O endereço da API em vigor: a variável, a `api_url` ou o próprio servidor.
    pub fn effective_api_url(&self, env: Option<String>, web_env: Option<String>) -> String {
        env.filter(|url| validate_web_url(url).is_ok())
            .or_else(|| self.api_url.clone())
            .unwrap_or_else(|| self.effective_web_url(web_env))
    }

    /// Confere o que a janela pode mandar: endereços, CA legível e retenção no limite.
    pub fn validate(&self) -> Result<()> {
        validate_web_url(&self.web_url)?;
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
        if let Some(language) = &self.language {
            if !LANGUAGES.contains(&language.as_str()) {
                bail!("idioma da transcrição: use pt, es ou en, ou Automático");
            }
        }
        self.mirror.validate()?;
        if self.mic.as_deref() == Some(SOURCE_NONE) && self.system_source == SOURCE_NONE {
            bail!("Escolha ao menos uma fonte de áudio");
        }
        self.shortcuts.validate()
    }
}

/// Aceita só endereços `http(s)://` com host.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tema_e_aviso_de_resumo_tem_padrao_e_o_tema_e_fechado() {
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
        let lido: Config = serde_json::from_str(&json).unwrap();
        assert_eq!((lido.theme.as_str(), lido.notify_summary), ("dark", false));
        config.theme = "sepia".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn pasta_sincronizada_vem_desligada_e_config_antiga_le() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.mirror, MirrorConfig::default());
        assert!(!config.mirror.enabled);
        assert!(config.mirror.transcripts);
        assert_eq!(config.mirror.dir, None);
        assert!(!serde_json::to_string(&config).unwrap().contains("\"dir\""));
        config.validate().unwrap();
    }

    #[test]
    fn ligar_a_pasta_exige_um_caminho_completo_que_nao_seja_a_raiz() {
        let dir = std::env::temp_dir();
        let mut config = Config::default();
        config.mirror.enabled = true;
        assert!(config.validate().is_err());
        config.mirror.dir = Some(PathBuf::from("relativa/pasta"));
        assert!(config.validate().is_err());
        config.mirror.dir = dir.ancestors().last().map(Path::to_path_buf);
        assert!(config.validate().is_err());
        // A pasta pessoal também é recusada: as Collections viram subpastas dela.
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            config.mirror.dir = Some(PathBuf::from(home));
            assert!(config.validate().is_err());
        }
        config.mirror.dir = Some(dir.join("eclume-resumos"));
        config.validate().unwrap();
        let json = serde_json::to_string(&config).unwrap();
        let lido: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(lido.mirror, config.mirror);
        // Desligada, a pasta não é conferida.
        config.mirror.enabled = false;
        config.mirror.dir = Some(PathBuf::from("relativa"));
        config.validate().unwrap();
    }

    #[test]
    fn idioma_da_transcricao_e_opcional_e_fechado() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.language, None);
        assert!(!serde_json::to_string(&config).unwrap().contains("language"));
        let mut config = Config {
            language: Some("es".into()),
            ..Config::default()
        };
        config.validate().unwrap();
        config.language = Some("fr".into());
        assert!(config.validate().is_err());
    }

    #[test]
    fn config_padrao_aponta_para_o_servidor_embutido_ou_o_host() {
        let expected = embedded_server().map_or(DEFAULT_WEB_URL.to_string(), |s| s.url);
        assert_eq!(Config::default().web_url, expected);
        assert_eq!(DEFAULT_WEB_URL, "https://192.168.15.199:8443");
    }

    #[test]
    fn servidor_embutido_no_build() {
        // O verify roda também com ECLUME_SERVER_URL=https://eclume.teste:8443.
        match option_env!("ECLUME_SERVER_URL").filter(|url| !url.trim().is_empty()) {
            Some(url) => {
                let server = embedded_server().expect("o build embutiu um servidor");
                assert_eq!(server.url, url.trim().trim_end_matches('/'));
                assert_eq!(Config::default().web_url, server.url);
            }
            None => assert_eq!(embedded_server(), None),
        }
    }

    #[test]
    fn variaveis_do_build_vazias_ou_invalidas_nao_embutem() {
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
    fn primeira_execucao_so_sem_credencial() {
        let mut config = Config::default();
        assert_eq!(config.connection(false), Connection::FirstRun);
        // Quem já usa um PAT (0.1.x) não vê a primeira execução.
        assert_eq!(config.connection(true), Connection::PersonalToken);
        config.account = Some(Account {
            email: "ana@exemplo.com.br".into(),
            token_id: Some("t-1".into()),
            server_name: Some("eclume".into()),
        });
        assert_eq!(config.connection(true), Connection::Account);
        // A credencial sumiu do chaveiro: entra de novo.
        assert_eq!(config.connection(false), Connection::FirstRun);
        let back: Config = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(back.account, config.account);
        let legacy: Config =
            serde_json::from_str(r#"{"web_url": "https://192.168.15.199:8443"}"#).unwrap();
        assert_eq!(legacy.account, None);
    }

    #[test]
    fn config_ausente_ou_invalida_cai_no_padrao() {
        let dir = std::env::temp_dir().join(format!("eclume-config-{}", std::process::id()));
        let path = dir.join("config.json");
        assert_eq!(Config::load(&path), Config::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ quebrado").unwrap();
        assert_eq!(Config::load(&path), Config::default());
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(Config::load(&path), Config::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn config_salva_e_relê() {
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
    fn config_variavel_de_ambiente_valida_sobrepoe() {
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
    fn config_da_versao_anterior_ganha_os_padroes() {
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
    fn audio_do_sistema_da_versao_anterior_vira_origem() {
        let off: Config = serde_json::from_str(r#"{"system_audio": false}"#).unwrap();
        assert_eq!(off.system_source, SOURCE_NONE);
        let on: Config = serde_json::from_str(r#"{"system_audio": true}"#).unwrap();
        assert_eq!(on.system_source, SYSTEM_FOLLOW);
        // Gravar de novo troca o booleano pela origem.
        let text = serde_json::to_string(&off).unwrap();
        assert!(!text.contains("system_audio"), "{text}");
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.system_source, SOURCE_NONE);
        let chosen: Config =
            serde_json::from_str(r#"{"system_source": "alsa_output.usb"}"#).unwrap();
        assert_eq!(chosen.system_source, "alsa_output.usb");
    }

    #[test]
    fn config_endereco_da_api() {
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
    fn config_valida_o_que_a_janela_manda() {
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
    fn aviso_de_atualizacao_uma_vez_e_ate_fechar() {
        let pending = PendingUpdate {
            version: "0.2.0".into(),
            notes: Some("Nova nota".into()),
        };
        // Primeira instalação: nada a avisar.
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
        // Reabrir não notifica de novo, mas o aviso da janela fica até ser fechado.
        assert_eq!(config.open_version("0.2.0"), None);
        assert_eq!(config.update_notice("0.2.0"), Some(&pending));
        // Uma atualização guardada que não chegou a instalar não vira aviso.
        assert_eq!(config.update_notice("0.1.2"), None);

        let text = serde_json::to_string(&config).unwrap();
        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(back.pending_update, Some(pending));
    }

    #[test]
    fn config_valida_endereco() {
        assert!(validate_web_url("https://192.168.15.199:8443").is_ok());
        assert!(validate_web_url("http://localhost").is_ok());
        assert!(validate_web_url("https://").is_err());
        assert!(validate_web_url("192.168.15.199").is_err());
        assert!(validate_web_url("https://a b").is_err());
    }
}
