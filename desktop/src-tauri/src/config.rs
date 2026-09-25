//! Configuração do app, em `config.json` no diretório de config do sistema.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Endereço padrão do eclume web: o host GPU, pela porta do eclume.
pub const DEFAULT_WEB_URL: &str = "https://192.168.15.199:8443";
/// Variável de ambiente que sobrepõe `web_url` sem mexer no arquivo.
pub const WEB_URL_ENV: &str = "ECLUME_WEB_URL";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Endereço do eclume web, aberto pelo item da bandeja.
    #[serde(default = "default_web_url")]
    pub web_url: String,
}

fn default_web_url() -> String {
    DEFAULT_WEB_URL.to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            web_url: default_web_url(),
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
        let config = Config {
            web_url: "https://eclume.local".into(),
        };
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
    fn config_valida_endereco() {
        assert!(validate_web_url("https://192.168.15.199:8443").is_ok());
        assert!(validate_web_url("http://localhost").is_ok());
        assert!(validate_web_url("https://").is_err());
        assert!(validate_web_url("192.168.15.199").is_err());
        assert!(validate_web_url("https://a b").is_err());
    }
}
