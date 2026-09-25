//! Configuração do app, em `config.json` no diretório de config do sistema. Todo campo tem
//! padrão, então um `config.json` de uma versão anterior continua lendo.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use eclume_detect::DetectionConfig;
use serde::{Deserialize, Serialize};

/// Endereço padrão do eclume web: o host GPU, pela porta do eclume.
pub const DEFAULT_WEB_URL: &str = "https://192.168.15.199:8443";
/// Variável de ambiente que sobrepõe `web_url` sem mexer no arquivo.
pub const WEB_URL_ENV: &str = "ECLUME_WEB_URL";
/// Variável de ambiente que sobrepõe o endereço da API (dev, com web e API separados).
pub const API_URL_ENV: &str = "ECLUME_API_URL";
/// Dias que o arquivo local fica depois da confirmação do servidor, por padrão.
pub const DEFAULT_RETENTION_DAYS: u32 = 7;
/// Teto da retenção configurável (10 anos).
pub const MAX_RETENTION_DAYS: u32 = 3650;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Endereço do servidor do eclume: o eclume web (item da bandeja) e, sem `api_url`, a API.
    #[serde(default = "default_web_url")]
    pub web_url: String,
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
}

fn default_web_url() -> String {
    DEFAULT_WEB_URL.to_string()
}

fn default_retention_days() -> Option<u32> {
    Some(DEFAULT_RETENTION_DAYS)
}

impl Default for Config {
    fn default() -> Self {
        Self {
            web_url: default_web_url(),
            api_url: None,
            ca_path: None,
            detection: DetectionConfig::default(),
            retention_days: default_retention_days(),
        }
    }
}

impl Config {
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
        Ok(())
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
    fn config_padrao_aponta_para_o_host() {
        assert_eq!(Config::default().web_url, "https://192.168.15.199:8443");
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
            DEFAULT_WEB_URL
        );
        assert_eq!(config.effective_web_url(None), DEFAULT_WEB_URL);
    }

    #[test]
    fn config_da_versao_anterior_ganha_os_padroes() {
        let config: Config =
            serde_json::from_str(r#"{"web_url": "https://eclume.local"}"#).unwrap();
        assert_eq!(config.web_url, "https://eclume.local");
        assert_eq!(config.api_url, None);
        assert!(config.detection.enabled);
        assert_eq!(config.retention_days, Some(DEFAULT_RETENTION_DAYS));
        let keep: Config = serde_json::from_str(r#"{"retention_days": null}"#).unwrap();
        assert_eq!(keep.retention_days, None);
    }

    #[test]
    fn config_endereco_da_api() {
        let mut config = Config::default();
        assert_eq!(config.effective_api_url(None, None), DEFAULT_WEB_URL);
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
        config.ca_path = Some("/nao/existe.pem".into());
        let err = config.validate().unwrap_err();
        assert!(format!("{err:#}").contains("CA extra"), "{err:#}");
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
