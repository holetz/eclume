//! A ligação do aparelho (holetz/eclume#35): o descritor público `GET /server`, o login por
//! e-mail e senha (`POST /devices/login`) e a troca do código de pareamento
//! (`POST /devices/pair`). As três rotas são públicas; a credencial que voltam é um token `eclp_`
//! de dispositivo, guardado no mesmo cofre do PAT.
//!
//! Sem retentativa: é uma ação da pessoa, e o erro vira texto na hora.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use url::Url;

use crate::api::{DeviceCredential, DeviceLogin, DevicePair, Problem, ServerInfo};
use crate::protocol::{api_error, parse, parse_base};
use crate::transport::{HttpRequest, HttpResponse, Transport};

/// O `platform` do contrato para este sistema.
pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// O nome deste computador: o `device_name` da credencial e do `capture` do upload.
pub fn device_name() -> String {
    gethostname::gethostname()
        .into_string()
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "computador".into())
}

/// As rotas públicas de ligação do aparelho num servidor.
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

    /// O descritor do servidor: nome, endereço e impressão digital da CA raiz.
    pub fn server_info(&self) -> Result<ServerInfo> {
        let what = "falha ao ler o descritor do servidor";
        let response = self.send(HttpRequest::new("GET", self.endpoint("/server")))?;
        if !response.is_success() {
            return Err(api_error(what, &response));
        }
        parse(what, &response)
    }

    /// Entra com e-mail e senha e recebe a credencial deste aparelho.
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
        self.credential(request)
    }

    /// Troca o código de pareamento (6 caracteres, com ou sem hífen) pela credencial.
    pub fn pair(&self, code: &str, device_name: &str) -> Result<DeviceCredential> {
        let body = DevicePair {
            code: code.trim(),
            device_name,
            platform: platform(),
        };
        let request = HttpRequest::new("POST", self.endpoint("/devices/pair")).json(&body)?;
        self.credential(request)
    }

    fn credential(&self, request: HttpRequest) -> Result<DeviceCredential> {
        let response = self.send(request)?;
        if response.is_success() {
            return parse("falha ao entrar", &response);
        }
        Err(sign_in_error(&response))
    }
}

/// O texto de uma recusa do login ou do pareamento.
fn sign_in_error(response: &HttpResponse) -> anyhow::Error {
    let problem: Problem = serde_json::from_slice(&response.body).unwrap_or_default();
    match (response.status, problem.code.as_deref()) {
        (401, Some("invalid_pairing_code")) => anyhow!("Código inválido ou vencido"),
        (401, _) => anyhow!("E-mail ou senha incorretos"),
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
    fn login_manda_o_aparelho_e_devolve_a_credencial() {
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
    fn pareamento_troca_o_codigo() {
        let script = Script::default().expect("POST /api/v1/devices/pair", json(201, credential()));
        let (devices, script) = devices(script);
        devices.pair(" K7Q-4MX ", "NOTEBOOK-ANA").unwrap();
        let body = sent(&script, 0);
        assert_eq!(body["code"], "K7Q-4MX");
        assert_eq!(body["platform"], platform());
    }

    #[test]
    fn recusas_viram_texto() {
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
        assert!(text(devices.login("a@b.c", "x", "pc")).contains("validation_failed"));
    }

    #[test]
    fn descritor_do_servidor() {
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
    fn endereco_invalido() {
        let transport: Arc<dyn Transport> = Arc::new(Script::default());
        assert!(Devices::new(Arc::clone(&transport), "ftp://x").is_err());
        assert!(Devices::new(transport, "192.168.15.199").is_err());
    }
}
