//! A ligação com o servidor: achar, fixar a CA, entrar e guardar a credencial do aparelho.
//!
//! Três caminhos levam à CA fixada (holetz/eclume#35, "Fixação da CA pelos apps"):
//!
//! 1. **Descoberto** pelo mDNS: o TXT traz `url` e `ca`, mas não é autenticado (qualquer máquina da
//!    rede pode anunciar outra CA). A raiz baixada tem de bater com o `ca` anunciado **e** a pessoa
//!    confere a impressão digital antes de mandar e-mail e senha.
//! 2. **QR** da web (`pair_url`): o código e a impressão digital vêm da tela autenticada da web, e
//!    o pareamento termina sem senha e sem conferência.
//! 3. **Endereço digitado**: sem impressão digital esperada (TOFU), a pessoa confere os blocos com
//!    a web antes de "Confiar".
//!
//! Depois de fixada, só a CA do `ca.pem` vale (`TrustMode::Pinned`, exatamente um certificado: o
//! `pin.rs` grava só o primeiro, o da impressão digital), e o `GET /api/v1/server` já fixado
//! confirma o `ca_sha256`. O token do dispositivo fica no arquivo privado fora do backup. Um
//! `ca.pem` antigo com certificados a mais é regravado com um só na abertura (`Core::abrir`), e a
//! credencial é apagada com o motivo [`pin::CA_TRIMMED`] (holetz/eclume#102).

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

use crate::config::{Config, Dirs, Servidor};

/// Como o núcleo abre conexões: a insegura (só para baixar a CA) e a fixada. Os testes injetam
/// transportes roteirizados.
pub trait Transportes: Send + Sync {
    fn inseguro(&self) -> Arc<dyn Transport>;
    fn fixado(&self, ca: &Path, prazo: Duration) -> Result<Arc<dyn Transport>>;

    /// O fixado para baixar um arquivo grande (o APK da atualização).
    fn baixador(&self, ca: &Path) -> Result<Arc<dyn Transport>> {
        self.fixado(ca, REQUEST_TIMEOUT)
    }
}

/// Os transportes reais, em `ureq`.
pub struct TransportesReais {
    pub user_agent: String,
}

impl Transportes for TransportesReais {
    fn inseguro(&self) -> Arc<dyn Transport> {
        Arc::new(UreqTransport::insecure(&self.user_agent))
    }

    fn fixado(&self, ca: &Path, prazo: Duration) -> Result<Arc<dyn Transport>> {
        let trust = eclume_sync::transport::TrustMode::Pinned(ca.to_path_buf());
        Ok(Arc::new(UreqTransport::with_trust(
            &trust,
            &self.user_agent,
            prazo,
        )?))
    }

    fn baixador(&self, ca: &Path) -> Result<Arc<dyn Transport>> {
        let trust = eclume_sync::transport::TrustMode::Pinned(ca.to_path_buf());
        Ok(Arc::new(
            UreqTransport::with_trust(&trust, &self.user_agent, REQUEST_TIMEOUT)?
                .com_limite(LIMITE_DO_APK),
        ))
    }
}

/// O maior APK que o app aceita baixar.
const LIMITE_DO_APK: u64 = 256 * 1024 * 1024;

/// Uma raiz baixada que espera a pessoa conferir ("Confiar" ou "Cancelar").
#[derive(Clone, Debug, PartialEq, Eq)]
struct CaPendente {
    url: String,
    raiz: RootCa,
    /// O código de um QR sem `ca`: trocado pela credencial só depois de "Confiar".
    codigo: Option<String>,
}

/// Em que ponto a ligação está: a UI escolhe a tela por ele.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "fase", rename_all = "snake_case")]
pub enum EstadoConexao {
    /// Primeira execução, ou depois de "Sair e esquecer o servidor".
    SemServidor,
    /// A CA baixada espera conferência: `impressao` em blocos de 4 (`3F9A 12C4 …`).
    ConfirmarCa {
        url: String,
        impressao: String,
    },
    /// Servidor fixado, sem credencial (ou o servidor a recusou com 401): tela Entrar. O
    /// `motivo`, quando há, explica por que a credencial foi apagada.
    SemCredencial {
        servidor: Servidor,
        #[serde(skip_serializing_if = "Option::is_none")]
        motivo: Option<String>,
    },
    Conectado {
        servidor: Servidor,
    },
}

/// A impressão digital em blocos de 4 caracteres maiúsculos, para conferir com a web.
pub fn impressao_em_blocos(sha256: &str) -> String {
    sha256
        .to_ascii_uppercase()
        .as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

/// O endereço como a pessoa digitou: sem esquema vira `https://`, sem barra no fim.
pub fn normalizar_endereco(texto: &str) -> Result<String> {
    let texto = texto.trim().trim_end_matches('/');
    if texto.is_empty() {
        bail!("Digite o endereço do servidor");
    }
    let url = if texto.contains("://") {
        texto.to_string()
    } else {
        format!("https://{texto}")
    };
    if !url.starts_with("https://") {
        bail!("O endereço precisa ser https://");
    }
    Ok(url)
}

/// A ligação com o servidor e o que ela guarda em disco.
pub struct Conexao {
    dirs: Dirs,
    transportes: Arc<dyn Transportes>,
    credencial: PatStore,
    /// O token do arquivo, lido uma vez na abertura e trocado em entrar, parear, sair e perda da
    /// credencial: o estado, lido a cada 250 ms, não relê o disco.
    token: Option<String>,
    pendente: Option<CaPendente>,
    sem_credencial: bool,
    /// Por que a credencial foi apagada, para a tela Entrar; some depois de entrar.
    motivo: Option<String>,
}

impl Conexao {
    pub fn new(dirs: Dirs, transportes: Arc<dyn Transportes>) -> Self {
        let credencial = PatStore::with_backend(dirs.token(), Box::new(NoKeyring), None);
        let token = match credencial.load() {
            Ok(lido) => lido.map(|(token, _)| token),
            Err(err) => {
                log::warn!("falha ao ler a credencial: {err:#}");
                None
            }
        };
        Self {
            dirs,
            transportes,
            credencial,
            token,
            pendente: None,
            sem_credencial: false,
            motivo: None,
        }
    }

    pub fn estado(&self, config: &Config) -> EstadoConexao {
        if let Some(pendente) = &self.pendente {
            return EstadoConexao::ConfirmarCa {
                url: pendente.url.clone(),
                impressao: impressao_em_blocos(&pendente.raiz.sha256),
            };
        }
        let Some(servidor) = config.servidor.clone() else {
            return EstadoConexao::SemServidor;
        };
        match self.token() {
            Ok(Some(_)) if !self.sem_credencial => EstadoConexao::Conectado { servidor },
            _ => EstadoConexao::SemCredencial {
                servidor,
                motivo: self.motivo.clone(),
            },
        }
    }

    /// O token do dispositivo, se houver (da memória: ver o campo `token`).
    pub fn token(&self) -> Result<Option<String>> {
        Ok(self.token.clone())
    }

    /// Apaga a credencial do arquivo e da memória.
    fn esquecer_token(&mut self) -> Result<()> {
        self.token = None;
        self.credencial.clear()
    }

    /// O transporte fixado para baixar a atualização.
    pub fn baixador(&self) -> Result<Arc<dyn Transport>> {
        self.transportes.baixador(&self.dirs.ca())
    }

    /// O transporte fixado na CA salva, com o prazo dado.
    pub fn transporte(&self, prazo: Duration) -> Result<Arc<dyn Transport>> {
        self.transportes.fixado(&self.dirs.ca(), prazo)
    }

    /// Um servidor achado pelo mDNS: baixa a raiz, confere com o `ca` anunciado e espera a pessoa
    /// conferir a impressão digital (o TXT não é autenticado).
    pub fn conectar_descoberto(&mut self, url: &str, ca_anunciada: Option<&str>) -> Result<()> {
        let url = normalizar_endereco(url)?;
        let raiz = pin::fetch_root(self.transportes.inseguro().as_ref(), &url, ca_anunciada)?;
        self.pendente = Some(CaPendente {
            url,
            raiz,
            codigo: None,
        });
        Ok(())
    }

    /// Um endereço digitado: baixa a raiz sem impressão esperada (TOFU) e espera a conferência.
    pub fn conectar_endereco(&mut self, texto: &str) -> Result<()> {
        let url = normalizar_endereco(texto)?;
        let raiz = pin::fetch_root(self.transportes.inseguro().as_ref(), &url, None)?;
        self.pendente = Some(CaPendente {
            url,
            raiz,
            codigo: None,
        });
        Ok(())
    }

    pub fn cancelar_ca(&mut self) {
        self.pendente = None;
    }

    /// "Confiar": fixa a raiz conferida, confirma pelo descritor e grava o servidor na config. Se
    /// a conferência veio de um QR sem `ca`, troca o código dele pela credencial. Devolve se pareou.
    pub fn confiar_ca(&mut self, config: &mut Config) -> Result<bool> {
        let pendente = self
            .pendente
            .take()
            .context("não há certificado esperando conferência")?;
        self.fixar(&pendente.url, &pendente.raiz, config)?;
        let Some(codigo) = pendente.codigo else {
            return Ok(false);
        };
        self.trocar_codigo(config, &pendente.url, &codigo)?;
        Ok(true)
    }

    fn fixar(&mut self, url: &str, raiz: &RootCa, config: &mut Config) -> Result<()> {
        std::fs::create_dir_all(&self.dirs.dados)
            .with_context(|| format!("falha ao criar {}", self.dirs.dados.display()))?;
        // A raiz nova só substitui a do servidor atual depois de o descritor confirmá-la: uma
        // conferência que falha não deixa o servidor pareado com a CA de outro.
        let ca = self.dirs.ca();
        let provisoria = ca.with_extension("pem.novo");
        std::fs::write(&provisoria, &raiz.pem)
            .with_context(|| format!("falha ao gravar {}", provisoria.display()))?;
        let conferida = self
            .transportes
            .fixado(&provisoria, REQUEST_TIMEOUT)
            .and_then(|transporte| Devices::new(transporte, url)?.server_info())
            .and_then(|info| {
                pin::confirm(&info, &raiz.sha256)?;
                Ok(info)
            });
        let info = match conferida {
            Ok(info) => info,
            Err(err) => {
                let _ = std::fs::remove_file(&provisoria);
                return Err(err);
            }
        };
        std::fs::rename(&provisoria, &ca)
            .with_context(|| format!("falha ao gravar {}", ca.display()))?;
        if config
            .servidor
            .as_ref()
            .is_some_and(|antigo| antigo.url != url)
        {
            // Trocar de servidor invalida a credencial do anterior.
            self.esquecer_token()?;
            config.tipos_de_agenda.clear();
        }
        config.servidor = Some(Servidor {
            url: url.to_string(),
            nome: info.name,
            ca_sha256: raiz.sha256.clone(),
        });
        config.salvar(&self.dirs.config())
    }

    /// Entra com e-mail e senha no servidor fixado e guarda a credencial do aparelho.
    pub fn entrar(&mut self, config: &Config, email: &str, senha: &str) -> Result<()> {
        let servidor = config
            .servidor
            .as_ref()
            .context("nenhum servidor escolhido")?;
        let devices = Devices::new(self.transporte(REQUEST_TIMEOUT)?, &servidor.url)?;
        let credencial = devices.login(email, senha, &config.device_name)?;
        self.guardar(&credencial)
    }

    /// Lê o `pair_url` do QR da web: fixa a CA pela impressão digital do próprio QR e troca o
    /// código pela credencial, sem senha. Devolve se pareou: um QR sem `ca` (a raiz ainda não
    /// publicada) não dispensa a conferência, e o código espera o "Confiar".
    pub fn parear(&mut self, config: &mut Config, texto_do_qr: &str) -> Result<bool> {
        let par = eclume_sync::devices::parse_pair_url(texto_do_qr)?;
        let raiz = pin::fetch_root(
            self.transportes.inseguro().as_ref(),
            &par.url,
            par.ca_sha256.as_deref(),
        )?;
        if par.ca_sha256.is_none() {
            self.pendente = Some(CaPendente {
                url: par.url,
                raiz,
                codigo: Some(par.code),
            });
            return Ok(false);
        }
        self.fixar(&par.url, &raiz, config)?;
        self.trocar_codigo(config, &par.url, &par.code)?;
        Ok(true)
    }

    fn trocar_codigo(&mut self, config: &Config, url: &str, codigo: &str) -> Result<()> {
        let devices = Devices::new(self.transporte(REQUEST_TIMEOUT)?, url)?;
        let credencial = devices.pair(codigo, &config.device_name)?;
        self.guardar(&credencial)
    }

    fn guardar(&mut self, credencial: &DeviceCredential) -> Result<()> {
        std::fs::create_dir_all(&self.dirs.sem_backup)
            .with_context(|| format!("falha ao criar {}", self.dirs.sem_backup.display()))?;
        self.credencial.save(&credencial.secret)?;
        self.token = Some(credencial.secret.clone());
        self.sem_credencial = false;
        self.motivo = None;
        Ok(())
    }

    /// O servidor recusou a credencial (401): esquece o token e volta à tela Entrar, sem mexer nas
    /// gravações locais.
    pub fn perdeu_credencial(&mut self) -> Result<()> {
        self.sem_credencial = true;
        self.esquecer_token()
    }

    /// A credencial foi apagada por `motivo`, que a tela Entrar mostra.
    pub fn perdeu_credencial_por(&mut self, motivo: &str) -> Result<()> {
        self.motivo = Some(motivo.to_string());
        self.perdeu_credencial()
    }

    /// "Sair e esquecer o servidor": apaga o token, a CA e o servidor da config. As gravações
    /// ficam e sobem no próximo servidor pareado.
    pub fn sair(&mut self, config: &mut Config) -> Result<()> {
        self.pendente = None;
        self.esquecer_token()?;
        match std::fs::remove_file(self.dirs.ca()) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).context("falha ao apagar a CA"),
        }
        config.servidor = None;
        config.tipos_de_agenda.clear();
        config.salvar(&self.dirs.config())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impressao_em_blocos_de_quatro() {
        let sha = "3f9a12c4".repeat(8);
        let blocos = impressao_em_blocos(&sha);
        assert!(blocos.starts_with("3F9A 12C4 3F9A"));
        assert_eq!(blocos.split(' ').count(), 16);
    }

    #[test]
    fn endereco_digitado_ganha_https() {
        assert_eq!(
            normalizar_endereco(" 192.168.15.199:8443/ ").unwrap(),
            "https://192.168.15.199:8443"
        );
        assert!(normalizar_endereco("http://eclume.test").is_err());
        assert!(normalizar_endereco("  ").is_err());
    }
}
