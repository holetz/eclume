//! A conta do app (o lado do desktop da holetz/eclume#35): escolher o servidor e fixar a CA dele,
//! entrar com e-mail e senha ou com o código de pareamento, e perceber quando a CA fixada mudou.
//!
//! As funções recebem a rede por [`Net`], para os testes roteirizarem as respostas; o estado do
//! app (`state.rs`) guarda o servidor escolhido e aplica o resultado.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use eclume_sync::api::ServerInfo;
use eclume_sync::transport::{Transport, UreqTransport};
use eclume_sync::{pin, Client, Devices, RetryPolicy};
use serde::Serialize;

use crate::config::{validate_web_url, Account};
use crate::state::CLIENT_VERSION;

/// Onde a CA de um servidor escolhido fica até a pessoa entrar nele.
const PENDING_DIR: &str = "servidor-pendente";

/// A rede: um transporte sem verificação só para baixar a CA raiz, e o verificado.
pub trait Net: Send + Sync {
    fn insecure(&self) -> Arc<dyn Transport>;
    fn verified(&self, ca_path: Option<&Path>) -> Result<Arc<dyn Transport>>;
}

/// A rede de verdade, em `ureq`.
pub struct RealNet;

impl Net for RealNet {
    fn insecure(&self) -> Arc<dyn Transport> {
        Arc::new(UreqTransport::insecure(CLIENT_VERSION))
    }

    fn verified(&self, ca_path: Option<&Path>) -> Result<Arc<dyn Transport>> {
        Ok(Arc::new(UreqTransport::new(ca_path, CLIENT_VERSION)?))
    }
}

/// Como o app passou a confiar no servidor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustedBy {
    /// A CA conferiu com a impressão digital esperada (instalador, mDNS ou QR).
    Fingerprint,
    /// Endereço digitado sem impressão digital: a pessoa confere a que a tela mostra (TOFU).
    FirstUse,
    /// O certificado já é confiável pelo sistema (o servidor não publica CA própria).
    System,
    /// `http://`, só em desenvolvimento.
    Unencrypted,
}

/// O servidor escolhido na primeira execução, pronto para entrar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreparedServer {
    pub name: String,
    pub url: String,
    pub ca_sha256: Option<String>,
    pub trusted_by: TrustedBy,
    /// A CA baixada, ainda fora do lugar definitivo.
    #[serde(skip)]
    pub ca_path: Option<PathBuf>,
}

/// Um servidor para a primeira execução mostrar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ServerChoice {
    pub name: String,
    pub url: String,
    pub ca_sha256: Option<String>,
    /// `installer` ("Veio com este instalador") ou `network` ("Encontrado na rede").
    pub origin: &'static str,
}

/// Os servidores conhecidos: o embutido no instalador primeiro, depois os achados na rede.
pub fn server_choices(
    embedded: Option<crate::config::EmbeddedServer>,
    found: Vec<eclume_sync::discovery::Found>,
) -> Vec<ServerChoice> {
    let mut choices: Vec<ServerChoice> = embedded
        .into_iter()
        .map(|server| ServerChoice {
            name: host_of(&server.url),
            url: server.url,
            ca_sha256: server.ca_sha256,
            origin: "installer",
        })
        .collect();
    for item in found {
        if choices.iter().all(|c| c.url != item.url) {
            choices.push(ServerChoice {
                name: item.name,
                url: item.url,
                ca_sha256: item.ca_sha256,
                origin: "network",
            });
        }
    }
    choices
}

/// O host de um endereço `http(s)://host[:porta][/...]`.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', ':']).next().unwrap_or(rest);
    host.to_string()
}

/// Fixa a CA de `url` (conferindo `expected`, quando há) e lê o descritor já com verificação.
pub fn prepare(
    net: &dyn Net,
    config_dir: &Path,
    url: &str,
    expected: Option<&str>,
) -> Result<PreparedServer> {
    let url = url.trim().trim_end_matches('/');
    validate_web_url(url)?;
    if url.starts_with("http://") {
        let info = server_info(net.verified(None)?, url)?;
        return Ok(prepared(info, url, None, TrustedBy::Unencrypted, None));
    }
    match pin::fetch_root(&*net.insecure(), url, expected) {
        Ok(root) => {
            let path = pin::save(&root, &config_dir.join(PENDING_DIR))?;
            let info = server_info(net.verified(Some(&path))?, url)?;
            pin::confirm(&info, &root.sha256)?;
            let trusted_by = if expected.is_some() {
                TrustedBy::Fingerprint
            } else {
                TrustedBy::FirstUse
            };
            Ok(prepared(
                info,
                url,
                Some(root.sha256),
                trusted_by,
                Some(path),
            ))
        }
        Err(err) if expected.is_some() => Err(err),
        Err(err) => {
            log::info!("sem CA própria em {url} ({err:#}); usando as raízes do sistema");
            let info = server_info(net.verified(None)?, url)?;
            Ok(prepared(info, url, None, TrustedBy::System, None))
        }
    }
}

fn server_info(transport: Arc<dyn Transport>, url: &str) -> Result<ServerInfo> {
    Devices::new(transport, url)?.server_info()
}

fn prepared(
    info: ServerInfo,
    url: &str,
    ca_sha256: Option<String>,
    trusted_by: TrustedBy,
    ca_path: Option<PathBuf>,
) -> PreparedServer {
    PreparedServer {
        name: info.name,
        url: url.to_string(),
        ca_sha256,
        trusted_by,
        ca_path,
    }
}

/// Como a pessoa entra.
pub enum Login<'a> {
    Password { email: &'a str, password: &'a str },
    Code(&'a str),
}

/// O resultado de entrar: o que o estado grava.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedIn {
    pub secret: String,
    pub account: Account,
    pub web_url: String,
    /// A CA fixada, já em `<config_dir>/servidor-ca.pem`.
    pub ca_path: Option<PathBuf>,
}

/// Entra no servidor preparado e devolve a credencial com a conta.
pub fn sign_in(
    net: &dyn Net,
    config_dir: &Path,
    server: &PreparedServer,
    login: Login<'_>,
    device_name: &str,
) -> Result<SignedIn> {
    let transport = net.verified(server.ca_path.as_deref())?;
    let devices = Devices::new(Arc::clone(&transport), &server.url)?;
    let (credential, email) = match login {
        Login::Password { email, password } => (
            devices.login(email, password, device_name)?,
            Some(email.trim().to_string()),
        ),
        Login::Code(code) => (devices.pair(code, device_name)?, None),
    };
    let email = match email {
        Some(email) => email,
        None => {
            let retry = RetryPolicy {
                retries: 1,
                base_delay: Duration::from_millis(500),
                ..RetryPolicy::default()
            };
            Client::new(transport, &server.url, &credential.secret, retry)?
                .me()?
                .user
                .email
        }
    };
    let ca_path = match &server.ca_path {
        Some(pending) => {
            let path = config_dir.join(pin::PINNED_FILE);
            std::fs::rename(pending, &path)
                .with_context(|| format!("falha ao gravar {}", path.display()))?;
            Some(path)
        }
        None => None,
    };
    Ok(SignedIn {
        secret: credential.secret,
        account: Account {
            email,
            token_id: Some(credential.token.id),
            server_name: Some(credential.server.name),
        },
        web_url: server.url.clone(),
        ca_path,
    })
}

/// A CA que o servidor serve hoje é outra que a fixada em `pinned`?
pub fn ca_changed(net: &dyn Net, web_url: &str, pinned: &Path) -> Result<bool> {
    let pem = std::fs::read(pinned).with_context(|| format!("falha ao ler {}", pinned.display()))?;
    let pinned = pin::root_from_pem(&pem)?;
    let served = pin::fetch_root(&*net.insecure(), web_url, None)?;
    Ok(served.sha256 != pinned.sha256)
}

/// O `ca_path` é a CA fixada pela primeira execução (e não uma escolhida à mão em "Avançado").
pub fn is_pinned(config_dir: &Path, ca_path: Option<&Path>) -> bool {
    ca_path.is_some_and(|path| path == config_dir.join(pin::PINNED_FILE))
}

/// Sem servidor escolhido, não há onde entrar.
pub fn require(server: Option<PreparedServer>) -> Result<PreparedServer> {
    match server {
        Some(server) => Ok(server),
        None => bail!("Escolha o servidor antes de entrar"),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use anyhow::anyhow;
    use eclume_sync::transport::{HttpRequest, HttpResponse};
    use serde_json::json;

    use super::*;

    pub const CA: &str = include_str!("../../crates/sync/tests/fixtures/ca-teste.pem");
    pub const CA_SHA256: &str = "b36a35276dcebd4b810c47c567f5b240f638450ab9701d196c64e4e7c6eaa233";
    pub const URL: &str = "https://eclume.teste:8443";
    pub const SECRET: &str = "eclp_Vb3kQ8rT2wY6uI1oP4aS7dF0gH3jK9lZ5xC";

    /// Rede roteirizada: um roteiro só para os dois transportes, conferido em ordem por
    /// `<verificado|inseguro> MÉTODO caminho`; guarda a CA com que cada transporte verificado
    /// foi criado.
    #[derive(Default)]
    pub struct ScriptNet {
        steps: Mutex<VecDeque<(String, Result<HttpResponse>)>>,
        pub ca_paths: Mutex<Vec<Option<PathBuf>>>,
    }

    struct Leg {
        net: Arc<ScriptNet>,
        kind: &'static str,
    }

    impl Transport for Leg {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
            let (call, response) = self.net.steps.lock().unwrap().pop_front().unwrap_or_else(
                || panic!("requisição a mais: {} {}", request.method, request.url),
            );
            let path = request.url.strip_prefix(URL).unwrap_or(&request.url);
            assert_eq!(format!("{} {} {path}", self.kind, request.method), call);
            response
        }
    }

    impl ScriptNet {
        pub fn expect(self, call: &str, response: Result<HttpResponse>) -> Self {
            self.steps
                .lock()
                .unwrap()
                .push_back((call.to_string(), response));
            self
        }

        pub fn done(&self) -> bool {
            self.steps.lock().unwrap().is_empty()
        }
    }

    /// `Net` sobre um `Arc<ScriptNet>`, para os transportes guardarem o roteiro.
    pub struct Shared(pub Arc<ScriptNet>);

    impl Net for Shared {
        fn insecure(&self) -> Arc<dyn Transport> {
            Arc::new(Leg {
                net: Arc::clone(&self.0),
                kind: "inseguro",
            })
        }

        fn verified(&self, ca_path: Option<&Path>) -> Result<Arc<dyn Transport>> {
            self.0
                .ca_paths
                .lock()
                .unwrap()
                .push(ca_path.map(Path::to_path_buf));
            Ok(Arc::new(Leg {
                net: Arc::clone(&self.0),
                kind: "verificado",
            }))
        }
    }

    pub fn body(status: u16, value: serde_json::Value) -> Result<HttpResponse> {
        Ok(HttpResponse {
            status,
            headers: Vec::new(),
            body: serde_json::to_vec(&value).unwrap(),
        })
    }

    pub fn pem() -> Result<HttpResponse> {
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: CA.as_bytes().to_vec(),
        })
    }

    pub fn info(ca: Option<&str>) -> serde_json::Value {
        json!({
            "name": "eclume", "url": URL, "mcp_url": format!("{URL}/mcp"), "ca_sha256": ca,
            "version": "0.1.0", "contract_version": "2.3.0"
        })
    }

    pub fn credential() -> serde_json::Value {
        json!({
            "token": {"id": "t-1", "name": "pc", "kind": "device"},
            "secret": SECRET,
            "server": info(Some(CA_SHA256)),
        })
    }

    pub fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-conta-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn servidor_do_instalador_fixa_a_ca_e_entra_por_senha() {
        let dir = dir("senha");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect("verificado GET /api/v1/server", body(200, info(Some(CA_SHA256))))
                .expect("verificado POST /api/v1/devices/login", body(201, credential())),
        );
        let shared = Shared(Arc::clone(&net));
        let server = prepare(&shared, &dir, &format!("{URL}/"), Some(CA_SHA256)).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::Fingerprint);
        assert_eq!(server.url, URL);
        assert_eq!(server.ca_sha256.as_deref(), Some(CA_SHA256));
        let pending = server.ca_path.clone().unwrap();
        assert!(pending.starts_with(dir.join(PENDING_DIR)));

        let login = Login::Password {
            email: " ana@exemplo.com.br ",
            password: "segredo",
        };
        let signed = sign_in(&shared, &dir, &server, login, "PC-ANA").unwrap();
        assert!(net.done());
        assert_eq!(signed.secret, SECRET);
        assert_eq!(signed.web_url, URL);
        assert_eq!(signed.account.email, "ana@exemplo.com.br");
        assert_eq!(signed.account.token_id.as_deref(), Some("t-1"));
        assert_eq!(signed.account.server_name.as_deref(), Some("eclume"));
        let pinned = dir.join(pin::PINNED_FILE);
        assert_eq!(signed.ca_path.as_deref(), Some(pinned.as_path()));
        assert_eq!(std::fs::read(&pinned).unwrap(), CA.as_bytes());
        assert!(!pending.exists());
        assert!(is_pinned(&dir, signed.ca_path.as_deref()));
        // O descritor e o login vão pelo transporte verificado com a CA baixada.
        assert_eq!(
            *net.ca_paths.lock().unwrap(),
            vec![Some(pending.clone()), Some(pending)]
        );
    }

    #[test]
    fn pareamento_le_o_email_da_conta() {
        let dir = dir("codigo");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect("verificado GET /api/v1/server", body(200, info(Some(CA_SHA256))))
                .expect("verificado POST /api/v1/devices/pair", body(201, credential()))
                .expect(
                    "verificado GET /api/v1/me",
                    body(
                        200,
                        json!({"user": {"email": "ana@exemplo.com.br"},
                               "auth": {"method": "pat", "token_id": "t-1"}}),
                    ),
                ),
        );
        let shared = Shared(Arc::clone(&net));
        let server = prepare(&shared, &dir, URL, None).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::FirstUse);
        let signed = sign_in(&shared, &dir, &server, Login::Code("K7Q-4MX"), "PC").unwrap();
        assert!(net.done());
        assert_eq!(signed.account.email, "ana@exemplo.com.br");
    }

    #[test]
    fn impressao_digital_que_nao_confere_para_antes_de_entrar() {
        let dir = dir("diverge");
        let net = Arc::new(
            ScriptNet::default().expect("inseguro GET /downloads/eclume-root.crt", pem()),
        );
        let err = prepare(&Shared(net), &dir, URL, Some(&"0".repeat(64))).unwrap_err();
        assert!(format!("{err:#}").contains("não confere"), "{err:#}");
        assert!(!dir.join(pin::PINNED_FILE).exists());
    }

    #[test]
    fn descritor_com_outra_ca_acusa_a_troca() {
        let dir = dir("descritor");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(&"a".repeat(64)))),
                ),
        );
        let err = prepare(&Shared(net), &dir, URL, None).unwrap_err();
        assert_eq!(err.to_string(), pin::CA_CHANGED);
    }

    #[test]
    fn sem_ca_publicada_usa_as_raizes_do_sistema() {
        let dir = dir("sistema");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", body(404, json!({})))
                .expect("verificado GET /api/v1/server", body(200, info(None))),
        );
        let shared = Shared(Arc::clone(&net));
        let server = prepare(&shared, &dir, URL, None).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::System);
        assert_eq!(server.ca_path, None);
        assert_eq!(*net.ca_paths.lock().unwrap(), vec![None]);
    }

    #[test]
    fn senha_errada_nao_grava_nada() {
        let dir = dir("recusa");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect("verificado GET /api/v1/server", body(200, info(Some(CA_SHA256))))
                .expect(
                    "verificado POST /api/v1/devices/login",
                    body(401, json!({"code": "unauthorized"})),
                ),
        );
        let shared = Shared(net);
        let server = prepare(&shared, &dir, URL, Some(CA_SHA256)).unwrap();
        let login = Login::Password {
            email: "ana@exemplo.com.br",
            password: "errada",
        };
        let err = sign_in(&shared, &dir, &server, login, "PC").unwrap_err();
        assert_eq!(format!("{err:#}"), "E-mail ou senha incorretos");
        assert!(!dir.join(pin::PINNED_FILE).exists());
    }

    #[test]
    fn percebe_a_ca_trocada() {
        let dir = dir("trocada");
        let pinned = dir.join(pin::PINNED_FILE);
        std::fs::write(&pinned, CA).unwrap();
        let other = include_str!("../../../server/tests/fixtures/ca-teste.pem");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "inseguro GET /downloads/eclume-root.crt",
                    Ok(HttpResponse {
                        status: 200,
                        headers: Vec::new(),
                        body: other.as_bytes().to_vec(),
                    }),
                )
                .expect(
                    "inseguro GET /downloads/eclume-root.crt",
                    Err(anyhow!("rede fora")),
                ),
        );
        let shared = Shared(net);
        assert!(!ca_changed(&shared, URL, &pinned).unwrap());
        assert!(ca_changed(&shared, URL, &pinned).unwrap());
        assert!(ca_changed(&shared, URL, &pinned).is_err());
        assert!(!is_pinned(&dir, Some(Path::new("/etc/ssl/outra.pem"))));
        assert!(!is_pinned(&dir, None));
    }

    #[test]
    fn instalador_primeiro_e_sem_repetir() {
        let embedded = crate::config::EmbeddedServer {
            url: URL.into(),
            ca_sha256: Some(CA_SHA256.into()),
        };
        let found = vec![
            eclume_sync::discovery::Found {
                name: "eclume".into(),
                url: URL.into(),
                ca_sha256: Some(CA_SHA256.into()),
                contract_version: None,
            },
            eclume_sync::discovery::Found {
                name: "Escritório".into(),
                url: "https://10.0.0.2".into(),
                ca_sha256: None,
                contract_version: None,
            },
        ];
        let choices = server_choices(Some(embedded), found);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].origin, "installer");
        assert_eq!(choices[0].name, "eclume.teste");
        assert_eq!(choices[1].origin, "network");
        assert_eq!(choices[1].name, "Escritório");
        assert_eq!(require(None).unwrap_err().to_string(), "Escolha o servidor antes de entrar");
    }
}
