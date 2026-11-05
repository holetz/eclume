//! Device connection (holetz/eclume#35): the public descriptor `GET /server`, e-mail and password
//! sign-in (`POST /devices/login`) and pairing code exchange (`POST /devices/pair`). All three
//! routes are public; the credential they return is an `eclp_` device token, stored in the same
//! vault as the PAT.
//!
//! The QR the web shows for the phone (`pair_url`) is read by [`parse_pair_url`].
//!
//! No retries: this is a user action, and the error becomes text immediately.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use url::Url;

use crate::api::{DeviceCredential, DeviceLogin, DevicePair, Problem, ServerInfo};
use crate::protocol::{api_error, parse, parse_base};
use crate::transport::{HttpRequest, HttpResponse, Transport};

/// The contract's `platform` for this system.
pub fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// This computer's name: the credential's `device_name` and the upload's `capture`.
pub fn device_name() -> String {
    gethostname::gethostname()
        .into_string()
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "computador".into())
}

/// The pairing QR content: `<url>/parear?codigo=<code>&ca=<ca_sha256>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairUrl {
    /// The server address without a trailing slash.
    pub url: String,
    pub code: String,
    /// The root CA fingerprint; without it (root not yet published), the app checks manually.
    pub ca_sha256: Option<String>,
}

/// Reads pairing QR text. The text comes from the camera and is untrusted: only `https://…/parear`
/// with a 6-character `codigo` and 64-hex-digit `ca` passes.
pub fn parse_pair_url(text: &str) -> Result<PairUrl> {
    let invalid = || anyhow!("Este código não é um pareamento do eclume");
    let parsed = Url::parse(text.trim()).map_err(|_| invalid())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || parsed.path().trim_end_matches('/') != "/parear"
    {
        return Err(invalid());
    }
    let query = |key: &str| {
        parsed
            .query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let code: String = query("codigo")
        .ok_or_else(invalid)?
        .chars()
        .filter(|c| *c != '-')
        .collect();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(invalid());
    }
    let ca_sha256 = query("ca")
        .filter(|ca| !ca.is_empty())
        .map(|ca| crate::pin::normalize_fingerprint(&ca))
        .transpose()
        .map_err(|_| invalid())?;
    let mut base = parsed.clone();
    base.set_path("");
    base.set_query(None);
    base.set_fragment(None);
    Ok(PairUrl {
        url: base.as_str().trim_end_matches('/').to_string(),
        code: code.to_ascii_uppercase(),
        ca_sha256,
    })
}

/// The public device connection routes on a server.
pub struct Devices {
    transport: Arc<dyn Transport>,
    base: Url,
}

impl Devices {
    pub fn new(transport: Arc<dyn Transport>, url: &str) -> Result<Self> {
        Ok(Self {
            transport,
            base: parse_base(url)?,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.base.as_str().trim_end_matches('/'))
    }

    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        self.transport.send(request).with_context(|| {
            format!(
                "não foi possível falar com o servidor em {}",
                self.base.as_str().trim_end_matches('/')
            )
        })
    }

    /// The server descriptor: name, address and root CA fingerprint.
    pub fn server_info(&self) -> Result<ServerInfo> {
        let what = "falha ao ler o descritor do servidor";
        let response = self.send(HttpRequest::new("GET", self.endpoint("/server")))?;
        if !response.is_success() {
            return Err(api_error(what, &response));
        }
        parse(what, &response)
    }

    /// Signs in with e-mail and password and receives this device's credential.
    pub fn login(
        &self,
        email: &str,
        password: &str,
        device_name: &str,
    ) -> Result<DeviceCredential> {
        let body = DeviceLogin {
            email: email.trim(),
            password,
            device_name,
            platform: platform(),
        };
        let request = HttpRequest::new("POST", self.endpoint("/devices/login")).json(&body)?;
        self.credential(request, "E-mail ou senha incorretos")
    }

    /// Exchanges the pairing code (6 characters, with or without a hyphen) for the credential.
    pub fn pair(&self, code: &str, device_name: &str) -> Result<DeviceCredential> {
        let body = DevicePair {
            code: code.trim(),
            device_name,
            platform: platform(),
        };
        let request = HttpRequest::new("POST", self.endpoint("/devices/pair")).json(&body)?;
        self.credential(request, "Código inválido ou vencido")
    }

    /// `rejected` is the text for a 401: password or code rejected.
    fn credential(&self, request: HttpRequest, rejected: &str) -> Result<DeviceCredential> {
        let response = self.send(request)?;
        if response.is_success() {
            return parse("falha ao entrar", &response);
        }
        Err(sign_in_error(&response, rejected))
    }
}

/// The text for a sign-in or pairing rejection.
fn sign_in_error(response: &HttpResponse, rejected: &str) -> anyhow::Error {
    let problem: Problem = serde_json::from_slice(&response.body).unwrap_or_default();
    match (response.status, problem.code.as_deref()) {
        (401, _) => anyhow!("{rejected}"),
        (403, Some("notice_required")) => {
            anyhow!("Aceite o aviso de responsabilidade na web do eclume e entre de novo aqui")
        }
        (429, _) => match response
            .header("retry-after")
            .and_then(|value| value.trim().parse::<u64>().ok())
        {
            Some(secs) => anyhow!("Muitas tentativas; tente em {secs} s"),
            None => anyhow!("Muitas tentativas; tente de novo em instantes"),
        },
        _ => api_error("falha ao entrar", response),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json as value;

    use super::*;
    use crate::protocol::script::{json, Script};

    const BASE: &str = "https://eclume.test:8443/";

    fn credential() -> serde_json::Value {
        value!({
            "token": {
                "id": "01928f3a-1c00-7a00-8000-000000000703", "name": "notebook",
                "kind": "device", "platform": "windows",
                "scopes": ["recordings:read", "recordings:write"], "prefix": "eclp_Vb3k",
                "created_at": "2026-09-27T14:02:00Z", "last_used_at": null,
                "expires_at": null, "revoked_at": null
            },
            "secret": "eclp_Vb3kQ8rT2wY6uI1oP4aS7dF0gH3jK9lZ5xC",
            "server": {
                "name": "eclume", "url": "https://192.168.15.199:8443",
                "mcp_url": "https://192.168.15.199:8443/mcp", "ca_sha256": null,
                "version": "0.1.0", "contract_version": "2.3.0"
            }
        })
    }

    #[test]
    fn valid_and_invalid_pairing_qr() {
        let ca = "3f9a1c6e0b7d24f58e1a9c3b6d0f2e4a7c5b8d1e3f6a9c2b4d7e0f1a3c5e7b9d";
        let pair = parse_pair_url(&format!(
            "https://192.168.15.199:8443/parear?codigo=k7q-4mx&ca={}",
            ca.to_ascii_uppercase()
        ))
        .unwrap();
        assert_eq!(
            pair,
            PairUrl {
                url: "https://192.168.15.199:8443".into(),
                code: "K7Q4MX".into(),
                ca_sha256: Some(ca.into()),
            }
        );
        let without_ca = parse_pair_url("https://eclume.test/parear?codigo=K7Q4MX").unwrap();
        assert_eq!(without_ca.ca_sha256, None);
        for invalid_qr in [
            "http://eclume.test/parear?codigo=K7Q4MX",
            "https://eclume.test/entrar?codigo=K7Q4MX",
            "https://eclume.test/parear?codigo=K7Q",
            "https://eclume.test/parear",
            "https://eclume.test/parear?codigo=K7Q4MX&ca=xyz",
            "javascript:alert(1)",
            "não é url",
        ] {
            assert!(parse_pair_url(invalid_qr).is_err(), "{invalid_qr}");
        }
    }

    #[test]
    fn contract_platform() {
        assert!(["windows", "macos", "linux", "android", "ios"].contains(&platform()));
    }

    fn devices(script: Script) -> (Devices, Arc<Script>) {
        let script = Arc::new(script);
        let devices = Devices::new(Arc::clone(&script) as Arc<dyn Transport>, BASE).unwrap();
        (devices, script)
    }

    fn problem(status: u16, code: &str, retry_after: Option<&str>) -> Result<HttpResponse> {
        let mut response = json(
            status,
            value!({"title": "x", "status": status, "code": code}),
        )?;
        if let Some(secs) = retry_after {
            response.headers.push(("retry-after".into(), secs.into()));
        }
        Ok(response)
    }

    fn sent(script: &Script, index: usize) -> serde_json::Value {
        serde_json::from_slice(&script.seen()[index].body).unwrap()
    }

    #[test]
    fn login_sends_device_and_returns_credential() {
        let script =
            Script::default().expect("POST /api/v1/devices/login", json(201, credential()));
        let (devices, script) = devices(script);
        let cred = devices
            .login(" ana@exemplo.com.br ", "segredo", "NOTEBOOK-ANA")
            .unwrap();
        assert!(cred.secret.starts_with("eclp_"));
        assert_eq!(cred.token.id, "01928f3a-1c00-7a00-8000-000000000703");
        assert_eq!(cred.server.url, "https://192.168.15.199:8443");
        assert_eq!(cred.server.ca_sha256, None);
        assert_eq!(
            sent(&script, 0),
            value!({
                "email": "ana@exemplo.com.br", "password": "segredo",
                "device_name": "NOTEBOOK-ANA", "platform": platform()
            })
        );
    }

    #[test]
    fn pairing_exchanges_code() {
        let script = Script::default().expect("POST /api/v1/devices/pair", json(201, credential()));
        let (devices, script) = devices(script);
        devices.pair(" K7Q-4MX ", "NOTEBOOK-ANA").unwrap();
        let body = sent(&script, 0);
        assert_eq!(body["code"], "K7Q-4MX");
        assert_eq!(body["platform"], platform());
    }

    #[test]
    fn rejections_become_text() {
        let script = Script::default()
            .expect(
                "POST /api/v1/devices/login",
                problem(401, "unauthorized", None),
            )
            .expect(
                "POST /api/v1/devices/pair",
                problem(401, "invalid_pairing_code", None),
            )
            .expect(
                "POST /api/v1/devices/login",
                problem(429, "rate_limited", Some("42")),
            )
            .expect(
                "POST /api/v1/devices/pair",
                problem(429, "rate_limited", None),
            )
            .expect(
                "POST /api/v1/devices/login",
                problem(403, "notice_required", None),
            )
            .expect(
                "POST /api/v1/devices/pair",
                problem(401, "unauthorized", None),
            )
            .expect(
                "POST /api/v1/devices/login",
                problem(422, "validation_failed", None),
            );
        let (devices, _) = devices(script);
        let text = |result: Result<DeviceCredential>| format!("{:#}", result.unwrap_err());
        assert_eq!(
            text(devices.login("a@b.c", "x", "pc")),
            "E-mail ou senha incorretos"
        );
        assert_eq!(
            text(devices.pair("AAAAAA", "pc")),
            "Código inválido ou vencido"
        );
        assert_eq!(
            text(devices.login("a@b.c", "x", "pc")),
            "Muitas tentativas; tente em 42 s"
        );
        assert_eq!(
            text(devices.pair("AAAAAA", "pc")),
            "Muitas tentativas; tente de novo em instantes"
        );
        assert_eq!(
            text(devices.login("a@b.c", "x", "pc")),
            "Aceite o aviso de responsabilidade na web do eclume e entre de novo aqui"
        );
        assert_eq!(
            text(devices.pair("AAAAAA", "pc")),
            "Código inválido ou vencido"
        );
        assert!(text(devices.login("a@b.c", "x", "pc")).contains("validation_failed"));
    }

    #[test]
    fn server_descriptor() {
        let script = Script::default()
            .expect(
                "GET /api/v1/server",
                json(200, credential()["server"].clone()),
            )
            .expect("GET /api/v1/server", Err(anyhow!("conexão recusada")));
        let (devices, _) = devices(script);
        let info = devices.server_info().unwrap();
        assert_eq!(info.name, "eclume");
        assert_eq!(info.contract_version, "2.3.0");
        let err = format!("{:#}", devices.server_info().unwrap_err());
        assert!(
            err.contains("não foi possível falar com o servidor em https://eclume.test:8443"),
            "{err}"
        );
    }

    #[test]
    fn invalid_address() {
        let transport: Arc<dyn Transport> = Arc::new(Script::default());
        assert!(Devices::new(Arc::clone(&transport), "ftp://x").is_err());
        assert!(Devices::new(transport, "192.168.15.199").is_err());
    }
}
