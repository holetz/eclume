//! O transporte HTTP: uma interface mínima (o protocolo é testado sobre um roteirizado) e a
//! implementação real em `ureq` com rustls.
//!
//! TLS: sem CA extra vale o verificador da plataforma, que enxerga a CA do Caddy instalada no SO
//! pelo runbook do host. Com `ca_path`, as raízes nativas do SO mais os certificados do PEM
//! indicado — é o caminho para confiar na CA interna sem instalá-la no sistema, e o que a CA
//! fixada pelo `pin.rs` usa.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use ureq::tls::{Certificate, PemItem, RootCerts, TlsConfig};

/// Uma requisição, com o corpo já em memória.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn new(method: &'static str, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn json(mut self, body: &impl serde::Serialize) -> Result<Self> {
        self.body = serde_json::to_vec(body)?;
        Ok(self.header("Content-Type", "application/json"))
    }

    pub fn body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }
}

/// Uma resposta; qualquer status HTTP chega aqui, só falha de rede vira erro.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// Nomes em minúsculas.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Envia uma requisição. `Err` é falha de rede ou de TLS; status de erro vem em `Ok`.
pub trait Transport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse>;
}

/// Prazos do transporte real: conectar é rápido; uma parte (5 MiB ou mais) numa rede lenta não.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// O prazo total padrão de uma requisição.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// Teto padrão do corpo de resposta lido (as respostas do upload são JSON pequenos).
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

/// Em quem o transporte confia.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrustMode {
    /// As raízes do SO (o verificador da plataforma) mais a CA do PEM, se houver: o desktop.
    PlatformPlus(Option<PathBuf>),
    /// Só os certificados do PEM, sem as raízes do SO nem o `rustls-platform-verifier` (que no
    /// Android exige inicialização JNI própria): o celular, que fixa a CA do servidor.
    Pinned(PathBuf),
}

/// Transporte real em `ureq`.
pub struct UreqTransport {
    agent: ureq::Agent,
    max_response: u64,
}

impl UreqTransport {
    /// `ca_path`: PEM com a CA extra a confiar (a CA interna do Caddy), além das do SO.
    pub fn new(ca_path: Option<&Path>, user_agent: &str) -> Result<Self> {
        Self::with_trust(
            &TrustMode::PlatformPlus(ca_path.map(Path::to_path_buf)),
            user_agent,
            REQUEST_TIMEOUT,
        )
    }

    /// Só a CA fixada em `ca_path` ([`TrustMode::Pinned`]).
    pub fn pinned(ca_path: &Path, user_agent: &str) -> Result<Self> {
        Self::with_trust(
            &TrustMode::Pinned(ca_path.to_path_buf()),
            user_agent,
            REQUEST_TIMEOUT,
        )
    }

    /// Com a confiança e o prazo total dados (a sonda da rede do celular usa 3 s).
    pub fn with_trust(trust: &TrustMode, user_agent: &str, timeout: Duration) -> Result<Self> {
        let tls = TlsConfig::builder()
            .root_certs(trusted_roots(trust)?)
            .build();
        Ok(Self::with_tls(tls, user_agent, timeout))
    }

    /// Troca o teto do corpo de resposta (o app móvel baixa o APK da atualização por aqui).
    pub fn com_limite(mut self, bytes: u64) -> Self {
        self.max_response = bytes;
        self
    }

    /// Sem verificação de TLS: só para baixar a CA raiz que o `pin.rs` confere pela impressão
    /// digital. Nunca leva credencial.
    pub fn insecure(user_agent: &str) -> Self {
        let tls = TlsConfig::builder().disable_verification(true).build();
        Self::with_tls(tls, user_agent, REQUEST_TIMEOUT)
    }

    fn with_tls(tls: TlsConfig, user_agent: &str, timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT.min(timeout)))
            .timeout_global(Some(timeout))
            .user_agent(user_agent)
            .tls_config(tls)
            .build();
        Self {
            agent: config.into(),
            max_response: MAX_RESPONSE_BYTES,
        }
    }
}

/// As raízes de confiança de um [`TrustMode`].
pub fn trusted_roots(trust: &TrustMode) -> Result<RootCerts> {
    match trust {
        TrustMode::PlatformPlus(ca_path) => root_certs(ca_path.as_deref()),
        TrustMode::Pinned(ca_path) => Ok(RootCerts::new_with_certs(&read_pem_certs(ca_path)?)),
    }
}

/// As raízes de confiança: o verificador da plataforma, ou as nativas mais o PEM extra.
pub fn root_certs(ca_path: Option<&Path>) -> Result<RootCerts> {
    let Some(path) = ca_path else {
        return Ok(RootCerts::PlatformVerifier);
    };
    let mut certs = read_pem_certs(path)?;
    let native = rustls_native_certs::load_native_certs();
    for error in &native.errors {
        log::warn!("certificado do SO ignorado: {error}");
    }
    certs.extend(
        native
            .certs
            .iter()
            .map(|der| Certificate::from_der(der.as_ref()).to_owned()),
    );
    Ok(RootCerts::new_with_certs(&certs))
}

/// Lê todos os certificados de um PEM; um arquivo sem nenhum é erro.
pub fn read_pem_certs(path: &Path) -> Result<Vec<Certificate<'static>>> {
    let pem = std::fs::read(path)
        .with_context(|| format!("falha ao ler a CA extra em {}", path.display()))?;
    let mut certs = Vec::new();
    for item in ureq::tls::parse_pem(&pem) {
        if let PemItem::Certificate(cert) =
            item.with_context(|| format!("PEM inválido em {}", path.display()))?
        {
            certs.push(cert);
        }
    }
    if certs.is_empty() {
        bail!("nenhum certificado no PEM {}", path.display());
    }
    Ok(certs)
}

impl Transport for UreqTransport {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let http_request = builder
            .body(request.body)
            .with_context(|| format!("requisição inválida para {}", request.url))?;
        let mut response = self
            .agent
            .run(http_request)
            .with_context(|| format!("{} {} falhou", request.method, request.url))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_ascii_lowercase(), v.to_string()))
            })
            .collect();
        let body = response
            .body_mut()
            .with_config()
            .limit(self.max_response)
            .read_to_vec()
            .with_context(|| format!("falha ao ler a resposta de {}", request.url))?;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CA autoassinada de teste (CN=eclume-teste), só para o parser.
    const TEST_CA: &str = include_str!("../tests/fixtures/ca-teste.pem");

    fn temp(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-sync-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn sem_ca_extra_usa_o_verificador_da_plataforma() {
        assert!(matches!(
            root_certs(None).unwrap(),
            RootCerts::PlatformVerifier
        ));
    }

    #[test]
    fn ca_extra_entra_junto_das_raizes_do_so() {
        let path = temp("ca.pem", TEST_CA);
        assert_eq!(read_pem_certs(&path).unwrap().len(), 1);
        let RootCerts::Specific(certs) = root_certs(Some(&path)).unwrap() else {
            panic!("esperava raízes específicas");
        };
        assert!(!certs.is_empty());
    }

    #[test]
    fn ca_fixada_confia_so_no_pem() {
        let path = temp("fixada.pem", TEST_CA);
        let RootCerts::Specific(pinned) = trusted_roots(&TrustMode::Pinned(path.clone())).unwrap()
        else {
            panic!("esperava raízes específicas");
        };
        assert_eq!(pinned.len(), 1);
        let RootCerts::Specific(plus) =
            trusted_roots(&TrustMode::PlatformPlus(Some(path.clone()))).unwrap()
        else {
            panic!("esperava raízes específicas");
        };
        assert!(plus.len() >= pinned.len());
        assert!(UreqTransport::pinned(&path, "eclume-android/0.1.0").is_ok());
        // Sem PEM, o modo fixado não cai nas raízes do SO: é erro.
        assert!(trusted_roots(&TrustMode::Pinned(PathBuf::from("/nao/existe.pem"))).is_err());
    }

    #[test]
    fn ca_extra_invalida_ou_ausente_e_erro_claro() {
        let vazio = temp("vazio.pem", "não é um PEM\n");
        let err = read_pem_certs(&vazio).unwrap_err();
        assert!(format!("{err:#}").contains("nenhum certificado"), "{err:#}");
        let err = read_pem_certs(Path::new("/nao/existe.pem")).unwrap_err();
        assert!(
            format!("{err:#}").contains("falha ao ler a CA extra"),
            "{err:#}"
        );
    }

    #[test]
    fn resposta_acha_header_sem_diferenciar_caixa() {
        let response = HttpResponse {
            status: 200,
            headers: vec![("etag".into(), "\"abc\"".into())],
            body: Vec::new(),
        };
        assert_eq!(response.header("ETag"), Some("\"abc\""));
        assert!(response.is_success());
    }
}
