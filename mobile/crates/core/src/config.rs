//! O que o app guarda entre execuções, no diretório privado do app: o `config.json`, a CA fixada
//! (`ca.pem`) e, fora do backup, o token do dispositivo (`device-token`, 0600).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Nome do arquivo da configuração.
pub const CONFIG_FILE: &str = "config.json";
/// Nome do arquivo da CA fixada.
pub const CA_FILE: &str = "ca.pem";
/// Nome do arquivo do token do dispositivo, no diretório sem backup.
pub const TOKEN_FILE: &str = "device-token";

/// Os diretórios do app: `dados` (config, CA, fila e gravações) e `sem_backup` (o token; no Android,
/// o `noBackupFilesDir`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dirs {
    pub dados: PathBuf,
    pub sem_backup: PathBuf,
}

impl Dirs {
    pub fn config(&self) -> PathBuf {
        self.dados.join(CONFIG_FILE)
    }

    pub fn ca(&self) -> PathBuf {
        self.dados.join(CA_FILE)
    }

    pub fn token(&self) -> PathBuf {
        self.sem_backup.join(TOKEN_FILE)
    }

    pub fn fila(&self) -> PathBuf {
        self.dados.join("queue.sqlite")
    }

    pub fn gravacoes(&self) -> PathBuf {
        self.dados.join("gravacoes")
    }
}

/// O servidor pareado.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Servidor {
    /// Endereço público (`https://192.168.15.199:8443`), sem barra no fim.
    pub url: String,
    pub nome: String,
    /// SHA-256 (hex minúsculo) do DER da CA raiz fixada.
    pub ca_sha256: String,
}

/// A qualidade do áudio: a taxa de bits do Opus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Qualidade {
    /// 24 kbps, cerca de 11 MB por hora.
    #[default]
    Padrao,
    /// 48 kbps, cerca de 22 MB por hora.
    Alta,
}

impl Qualidade {
    pub fn bitrate(self) -> i32 {
        match self {
            Self::Padrao => 24_000,
            Self::Alta => 48_000,
        }
    }
}

/// Um tipo de agenda do usuário, no cache para a folha "Gravação salva" fora da rede.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TipoDeAgenda {
    pub id: String,
    pub nome: String,
}

fn verdadeiro() -> bool {
    true
}

fn sete() -> u32 {
    7
}

/// O `config.json`. Campos novos entram com padrão, para um arquivo antigo continuar válido.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub servidor: Option<Servidor>,
    /// O nome do aparelho (`Build.MODEL`): o que a web lista e o que os marcadores levam.
    #[serde(default)]
    pub device_name: String,
    #[serde(default = "verdadeiro")]
    pub sync_auto: bool,
    #[serde(default)]
    pub qualidade: Qualidade,
    /// Apagar do celular as gravações sincronizadas há mais de `reter_dias`.
    #[serde(default)]
    pub excluir_sincronizadas: bool,
    #[serde(default = "sete")]
    pub reter_dias: u32,
    #[serde(default)]
    pub tipos_de_agenda: Vec<TipoDeAgenda>,
    /// O idioma de transcrição que vale para a conta (`GET /me/transcription`), no cache para a
    /// folha "Gravação salva" nomear o padrão fora da rede.
    #[serde(default)]
    pub idioma_da_conta: Option<String>,
    /// Quando o `movel.json` foi lido pela última vez (ms Unix).
    #[serde(default)]
    pub atualizacao_verificada_em: Option<i64>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            servidor: None,
            device_name: String::new(),
            sync_auto: true,
            qualidade: Qualidade::Padrao,
            excluir_sincronizadas: false,
            reter_dias: 7,
            tipos_de_agenda: Vec::new(),
            idioma_da_conta: None,
            atualizacao_verificada_em: None,
        }
    }
}

impl Config {
    /// Lê o `config.json`; sem arquivo, a configuração padrão.
    pub fn carregar(path: &Path) -> Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("config inválida em {}", path.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err).with_context(|| format!("falha ao ler {}", path.display())),
        }
    }

    /// Grava por cópia e troca, para uma queda no meio não deixar um JSON pela metade.
    pub fn salvar(&self, path: &Path) -> Result<()> {
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
    fn config_padrao_e_ida_e_volta() {
        let dir = std::env::temp_dir().join(format!("eclume-config-{}", std::process::id()));
        let path = dir.join(CONFIG_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let padrao = Config::carregar(&path).unwrap();
        assert!(padrao.sync_auto);
        assert_eq!(padrao.reter_dias, 7);
        assert_eq!(padrao.qualidade.bitrate(), 24_000);

        let config = Config {
            servidor: Some(Servidor {
                url: "https://eclume.test".into(),
                nome: "eclume".into(),
                ca_sha256: "ab".repeat(32),
            }),
            qualidade: Qualidade::Alta,
            ..padrao
        };
        config.salvar(&path).unwrap();
        assert_eq!(Config::carregar(&path).unwrap(), config);
        // Um arquivo de uma versão anterior, sem os campos novos, continua válido.
        std::fs::write(&path, r#"{"device_name":"Pixel 8"}"#).unwrap();
        let antigo = Config::carregar(&path).unwrap();
        assert_eq!(antigo.device_name, "Pixel 8");
        assert!(antigo.sync_auto);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
