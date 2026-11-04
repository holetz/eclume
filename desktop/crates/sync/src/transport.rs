//! HTTP transport: a minimal interface (the protocol is tested with a scripted one) and the real
//! implementation in `ureq` with rustls.
//!
//! TLS, through [`TrustMode`]: the CA pinned by `pin.rs` (desktop with the first-run CA and mobile)
//! trusts exactly one certificate, without OS roots (`Pinned`). Without a custom CA (server with a
//! public certificate, or development `http://`), the platform verifier applies; with a manually
//! chosen CA, the native OS roots plus PEM certificates (`PlatformPlus`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use ureq::tls::{Certificate, PemItem, RootCerts, TlsConfig};

/// The URL without query string or fragment (scheme, host and path), for error and log messages: a
/// presigned URL's query carries the signature.
pub fn redact(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            parsed.set_query(None);
            parsed.set_fragment(None);
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        Err(_) => url.split(['?', '#']).next().unwrap_or_default().to_string(),
    }
}

/// Removes the full URL and its query from error text.
fn scrub(text: &str, url: &str) -> String {
    let mut text = text.replace(url, &redact(url));
    if let Some(query) = url.split_once('?').map(|(_, query)| query) {
        if !query.is_empty() {
            text = text.replace(query, "…");
        }
    }
    text
}

/// A request, with its body already in memory.
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

/// A response; any HTTP status reaches here, only network failures become errors.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// Lowercase names.
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

/// Sends a request. `Err` is a network or TLS failure; error statuses come in `Ok`.
pub trait Transport: Send + Sync {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse>;
}

/// Real transport timeouts: connecting is fast; a part (5 MiB or more) over a slow network is not.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The default total request timeout.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// Default response body read limit (upload responses are small JSON).
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

/// What the transport trusts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrustMode {
    /// OS roots (the platform verifier) plus all PEM certificates, if any: desktop with a manually
    /// chosen CA, or without a custom server CA.
    PlatformPlus(Option<PathBuf>),
    /// Only the pinned PEM certificate, without OS roots or `rustls-platform-verifier` (which
    /// requires its own JNI initialization on Android): desktop with the first-run CA and mobile. A
    /// PEM with multiple certificates is an error, never expanded trust.
    Pinned(PathBuf),
}

/// Real transport in `ureq`.
pub struct UreqTransport {
    agent: ureq::Agent,
    max_response: u64,
}

impl UreqTransport {
    /// `ca_path`: PEM with the extra trusted CA (Caddy's internal CA), in addition to OS roots.
    pub fn new(ca_path: Option<&Path>, user_agent: &str) -> Result<Self> {
        Self::with_trust(
            &TrustMode::PlatformPlus(ca_path.map(Path::to_path_buf)),
            user_agent,
            REQUEST_TIMEOUT,
        )
    }

    /// Only the CA pinned at `ca_path` ([`TrustMode::Pinned`]).
    pub fn pinned(ca_path: &Path, user_agent: &str) -> Result<Self> {
        Self::with_trust(
            &TrustMode::Pinned(ca_path.to_path_buf()),
            user_agent,
            REQUEST_TIMEOUT,
        )
    }

    /// With the given trust and total timeout (the phone's network probe uses 3 s).
    pub fn with_trust(trust: &TrustMode, user_agent: &str, timeout: Duration) -> Result<Self> {
        let tls = TlsConfig::builder()
            .root_certs(trusted_roots(trust)?)
            .build();
        Ok(Self::with_tls(tls, user_agent, timeout))
    }

    /// Changes the response body limit (the mobile app downloads the update APK here).
    pub fn com_limite(mut self, bytes: u64) -> Self {
        self.max_response = bytes;
        self
    }

    /// Without TLS verification: only to download the root CA that `pin.rs` checks by fingerprint.
    /// Never carries a credential.
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

/// The trust roots of a [`TrustMode`].
pub fn trusted_roots(trust: &TrustMode) -> Result<RootCerts> {
    match trust {
        TrustMode::PlatformPlus(ca_path) => root_certs(ca_path.as_deref()),
        TrustMode::Pinned(ca_path) => Ok(RootCerts::new_with_certs(&[pinned_cert(ca_path)?])),
    }
}

/// The sole certificate of a pinned PEM; none or multiple is an error naming the file.
pub fn pinned_cert(path: &Path) -> Result<Certificate<'static>> {
    let mut certs = read_pem_certs(path)?;
    if certs.len() != 1 {
        bail!(
            "a CA fixada em {} tem {} certificados; esperava exatamente um",
            path.display(),
            certs.len()
        );
    }
    Ok(certs.remove(0))
}

/// Trust roots: the platform verifier, or native roots plus the extra PEM.
pub fn root_certs(ca_path: Option<&Path>) -> Result<RootCerts> {
    let Some(path) = ca_path else {
        return Ok(RootCerts::PlatformVerifier);
    };
    let mut certs = read_pem_certs(path)?;
    let native = rustls_native_certs::load_native_certs();
    for error in &native.errors {
        log::warn!("OS certificate ignored: {error}");
    }
    certs.extend(
        native
            .certs
            .iter()
            .map(|der| Certificate::from_der(der.as_ref()).to_owned()),
    );
    Ok(RootCerts::new_with_certs(&certs))
}

/// Reads all certificates from a PEM; a file without any is an error.
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
        let shown = redact(&request.url);
        let http_request = builder.body(request.body).map_err(|err| {
            anyhow!(
                "requisição inválida para {shown}: {}",
                scrub(&err.to_string(), &request.url)
            )
        })?;
        let mut response = self.agent.run(http_request).map_err(|err| {
            anyhow!(
                "{} {shown} falhou: {}",
                request.method,
                scrub(&err.to_string(), &request.url)
            )
        })?;
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
            .map_err(|err| {
                anyhow!(
                    "falha ao ler a resposta de {shown}: {}",
                    scrub(&err.to_string(), &request.url)
                )
            })?;
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

    /// Self-signed test CA (CN=eclume-teste), only for the parser.
    const TEST_CA: &str = include_str!("../tests/fixtures/test-ca.pem");

    fn temp(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-sync-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn redact_removes_presigned_url_query() {
        let url = "https://s3.local/bucket/obj?X-Amz-Signature=abc123&X-Amz-Credential=k";
        assert_eq!(redact(url), "https://s3.local/bucket/obj");
        assert_eq!(redact("sem esquema?x=1"), "sem esquema");
        let transport = UreqTransport::with_trust(
            &TrustMode::PlatformPlus(None),
            "teste",
            Duration::from_secs(2),
        )
        .unwrap();
        // Closed port: the connection is refused immediately.
        let err = transport
            .send(HttpRequest::new(
                "PUT",
                "http://127.0.0.1:9/bucket/obj?X-Amz-Signature=abc123",
            ))
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(!text.contains('?') && !text.contains("abc123"), "{text}");
        assert!(text.contains("PUT http://127.0.0.1:9/bucket/obj"), "{text}");
    }

    #[test]
    fn without_extra_ca_uses_platform_verifier() {
        assert!(matches!(
            root_certs(None).unwrap(),
            RootCerts::PlatformVerifier
        ));
    }

    #[test]
    fn extra_ca_joins_os_roots() {
        let path = temp("ca.pem", TEST_CA);
        assert_eq!(read_pem_certs(&path).unwrap().len(), 1);
        let RootCerts::Specific(certs) = root_certs(Some(&path)).unwrap() else {
            panic!("expected specific roots");
        };
        assert!(!certs.is_empty());
    }

    #[test]
    fn pinned_ca_trusts_only_pem() {
        let path = temp("fixada.pem", TEST_CA);
        let RootCerts::Specific(pinned) = trusted_roots(&TrustMode::Pinned(path.clone())).unwrap()
        else {
            panic!("expected specific roots");
        };
        assert_eq!(pinned.len(), 1);
        let RootCerts::Specific(plus) =
            trusted_roots(&TrustMode::PlatformPlus(Some(path.clone()))).unwrap()
        else {
            panic!("expected specific roots");
        };
        assert!(plus.len() >= pinned.len());
        assert!(UreqTransport::pinned(&path, "eclume-android/0.1.0").is_ok());
        // Without a PEM, pinned mode does not fall back to OS roots: it is an error.
        assert!(trusted_roots(&TrustMode::Pinned(PathBuf::from("/nao/existe.pem"))).is_err());
    }

    #[test]
    fn pinned_ca_with_two_certificates_fails_and_extra_ca_adds_both() {
        let other = include_str!("../../../../server/tests/fixtures/ca-test.pem");
        let path = temp("duas.pem", &format!("{TEST_CA}{other}"));
        let Err(err) = trusted_roots(&TrustMode::Pinned(path.clone())) else {
            panic!("two certificates in pinned mode should fail");
        };
        let text = format!("{err:#}");
        assert!(text.contains("duas.pem"), "{text}");
        assert!(text.contains("2 certificados"), "{text}");
        assert!(UreqTransport::pinned(&path, "eclume-android/0.1.0").is_err());
        let RootCerts::Specific(merged) =
            trusted_roots(&TrustMode::PlatformPlus(Some(path))).unwrap()
        else {
            panic!("expected specific roots");
        };
        assert!(merged.len() >= 2);
    }

    #[test]
    fn invalid_or_missing_extra_ca_gives_clear_error() {
        let empty = temp("vazio.pem", "não é um PEM\n");
        let err = read_pem_certs(&empty).unwrap_err();
        assert!(format!("{err:#}").contains("nenhum certificado"), "{err:#}");
        let err = read_pem_certs(Path::new("/nao/existe.pem")).unwrap_err();
        assert!(
            format!("{err:#}").contains("falha ao ler a CA extra"),
            "{err:#}"
        );
    }

    #[test]
    fn response_finds_header_case_insensitively() {
        let response = HttpResponse {
            status: 200,
            headers: vec![("etag".into(), "\"abc\"".into())],
            body: Vec::new(),
        };
        assert_eq!(response.header("ETag"), Some("\"abc\""));
        assert!(response.is_success());
    }
}
