//! A conta do app (o lado do desktop da holetz/eclume#35): escolher o servidor e fixar a CA dele,
//! entrar com e-mail e senha ou com o código de pareamento, e perceber quando a CA fixada mudou —
//! trocando-a sozinho pela próxima raiz anunciada na rotação (holetz/eclume#101).
//!
//! As funções recebem a rede por [`Net`], para os testes roteirizarem as respostas; o estado do
//! app (`state.rs`) guarda o servidor escolhido e aplica o resultado.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use eclume_sync::api::ServerInfo;
use eclume_sync::transport::{Transport, TrustMode, UreqTransport, REQUEST_TIMEOUT};
use eclume_sync::{pin, Client, Devices, RetryPolicy};
use serde::Serialize;

use crate::config::{validate_web_url, Account, Config};
use crate::state::CLIENT_VERSION;

/// Onde a CA de um servidor escolhido fica até a pessoa entrar nele.
const PENDING_DIR: &str = "servidor-pendente";

/// A rede: um transporte sem verificação só para baixar a CA raiz, e o verificado.
pub trait Net: Send + Sync {
    fn insecure(&self) -> Arc<dyn Transport>;
    fn verified(&self, trust: &TrustMode) -> Result<Arc<dyn Transport>>;
}

/// A rede de verdade, em `ureq`.
pub struct RealNet;

impl Net for RealNet {
    fn insecure(&self) -> Arc<dyn Transport> {
        Arc::new(UreqTransport::insecure(CLIENT_VERSION))
    }

    fn verified(&self, trust: &TrustMode) -> Result<Arc<dyn Transport>> {
        let transport = UreqTransport::with_trust(trust, CLIENT_VERSION, REQUEST_TIMEOUT)?;
        Ok(Arc::new(transport))
    }
}

/// Em quem o app confia para falar com o servidor, pela origem do `ca_path`: a CA fixada pela
/// primeira execução confia só nela (`Pinned`); uma escolhida à mão em "Avançado" soma-se às
/// raízes do SO; sem CA (certificado público ou `http://` de dev), o verificador da plataforma.
pub fn trust_for(config_dir: &Path, ca_path: Option<&Path>) -> TrustMode {
    match ca_path {
        Some(path) if is_pinned(config_dir, Some(path)) => TrustMode::Pinned(path.to_path_buf()),
        other => TrustMode::PlatformPlus(other.map(Path::to_path_buf)),
    }
}

/// A CA baixada e conferida na primeira execução (ainda pendente) é fixada; sem ela, o sistema.
fn pending_trust(ca_path: Option<&Path>) -> TrustMode {
    match ca_path {
        Some(path) => TrustMode::Pinned(path.to_path_buf()),
        None => TrustMode::PlatformPlus(None),
    }
}

/// Como o app passou a confiar no servidor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustedBy {
    /// A CA conferiu com a impressão digital que veio com o instalador.
    Fingerprint,
    /// Endereço digitado ou anunciado no mDNS (sem autenticação): a pessoa confere a impressão
    /// digital que a tela mostra antes de entrar (TOFU).
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
    /// A pessoa conferiu a impressão digital (`FirstUse`) por [`confirm`].
    #[serde(skip)]
    pub confirmed: bool,
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

/// O endereço e a impressão digital são os que vieram com o instalador? Só eles dispensam a
/// conferência: o anúncio do mDNS não é autenticado e qualquer máquina da rede pode forjá-lo.
pub fn vouched_by_installer(
    embedded: Option<crate::config::EmbeddedServer>,
    url: &str,
    ca_sha256: Option<&str>,
) -> bool {
    let (Some(server), Some(ca_sha256)) = (embedded, ca_sha256) else {
        return false;
    };
    server.url.trim_end_matches('/') == url.trim().trim_end_matches('/')
        && server
            .ca_sha256
            .is_some_and(|expected| expected.eq_ignore_ascii_case(ca_sha256.trim()))
}

/// Fixa a CA de `url` (conferindo `expected`, quando há) e lê o descritor já com verificação.
/// Só a impressão digital `vouched` (a do instalador) dá `Fingerprint`; qualquer outra ainda é
/// conferida na baixa da CA, mas a pessoa confirma antes de entrar (`FirstUse`).
pub fn prepare(
    net: &dyn Net,
    config_dir: &Path,
    url: &str,
    expected: Option<&str>,
    vouched: bool,
) -> Result<PreparedServer> {
    let url = url.trim().trim_end_matches('/');
    validate_web_url(url)?;
    if url.starts_with("http://") {
        if !cfg!(debug_assertions) && !is_loopback(url) {
            bail!("endereço sem https: use https:// (http:// só vale em localhost)");
        }
        let info = server_info(net.verified(&pending_trust(None))?, url)?;
        return Ok(prepared(info, url, None, TrustedBy::Unencrypted, None));
    }
    match pin::fetch_root(&*net.insecure(), url, expected) {
        Ok(root) => {
            let path = pin::save(&root, &config_dir.join(PENDING_DIR))?;
            let info = server_info(net.verified(&pending_trust(Some(&path)))?, url)?;
            pin::confirm(&info, &root.sha256)?;
            let trusted_by = if expected.is_some() && vouched {
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
            let info = server_info(net.verified(&pending_trust(None))?, url)?;
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
        confirmed: false,
    }
}

/// `http://localhost` ou `http://127.0.0.1`, com ou sem porta.
fn is_loopback(url: &str) -> bool {
    matches!(host_of(url).as_str(), "localhost" | "127.0.0.1")
}

/// A pessoa conferiu a impressão digital do servidor que a tela mostra; recusa quando o servidor
/// preparado já é outro (uma escolha mais nova terminou antes).
pub fn confirm(server: &mut PreparedServer, url: &str, ca_sha256: Option<&str>) -> Result<()> {
    if server.url != url.trim().trim_end_matches('/') || server.ca_sha256.as_deref() != ca_sha256 {
        bail!("O servidor escolhido mudou; confira a impressão digital de novo");
    }
    server.confirmed = true;
    Ok(())
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
    if server.trusted_by == TrustedBy::FirstUse && !server.confirmed {
        bail!("Confira a impressão digital do servidor antes de entrar");
    }
    let transport = net.verified(&pending_trust(server.ca_path.as_deref()))?;
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
            pin::forget_next(&path)?;
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

/// A CA que o servidor serve hoje é outra que a fixada em `pinned`? Se a servida é a próxima
/// guardada por [`learn_next`] e o descritor, lido fixando-a, não a contradiz, ela vira a fixada
/// (`rename`) e a CA não conta como mudada: o sync e o updater seguem sem nova entrada.
pub fn ca_changed(net: &dyn Net, web_url: &str, pinned: &Path) -> Result<bool> {
    let pem =
        std::fs::read(pinned).with_context(|| format!("falha ao ler {}", pinned.display()))?;
    let current = pin::root_from_pem(&pem)?;
    let served = pin::fetch_root(&*net.insecure(), web_url, None)?;
    if served.sha256 == current.sha256 {
        return Ok(false);
    }
    match pin::saved_next(pinned) {
        Some(next) if next.sha256 == served.sha256 => {
            let trust = TrustMode::Pinned(pin::next_path(pinned));
            let info = server_info(net.verified(&trust)?, web_url)?;
            if pin::confirm(&info, &next.sha256).is_err() {
                return Ok(true);
            }
            pin::promote_next(pinned)?;
            log::info!(
                "CA do servidor trocada pela próxima anunciada ({})",
                next.sha256
            );
            Ok(false)
        }
        _ => Ok(true),
    }
}

/// Aprende a próxima raiz pelo descritor lido na conexão fixada em `pinned` (a raiz atual avaliza
/// a nova, sem TOFU) e a guarda ao lado da fixada ([`pin::learn_next`]). Diz se gravou uma.
pub fn learn_next(net: &dyn Net, web_url: &str, pinned: &Path) -> Result<bool> {
    let transport = net.verified(&TrustMode::Pinned(pinned.to_path_buf()))?;
    let info = server_info(Arc::clone(&transport), web_url)?;
    pin::learn_next(&*transport, web_url, &info, pinned)
}

/// O `ca_path` é a CA fixada pela primeira execução (e não uma escolhida à mão em "Avançado").
pub fn is_pinned(config_dir: &Path, ca_path: Option<&Path>) -> bool {
    ca_path.is_some_and(|path| path == config_dir.join(pin::PINNED_FILE))
}

/// Regrava a CA fixada pela primeira execução só com o primeiro certificado ([`pin::trim_saved`])
/// e diz se havia certificados a mais: sinal de que a primeira conexão pode ter sido interceptada.
/// Uma CA escolhida à mão em "Avançado" nunca é tocada.
pub fn repair_pinned(config_dir: &Path, config: &Config) -> Result<bool> {
    match config.ca_path.as_deref() {
        Some(path) if is_pinned(config_dir, Some(path)) => Ok(pin::trim_saved(path)? > 0),
        _ => Ok(false),
    }
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
    /// `<verificado|inseguro> MÉTODO caminho`; guarda a confiança com que cada transporte
    /// verificado foi criado.
    #[derive(Default)]
    pub struct ScriptNet {
        steps: Mutex<VecDeque<(String, Result<HttpResponse>)>>,
        pub trusts: Mutex<Vec<TrustMode>>,
    }

    struct Leg {
        net: Arc<ScriptNet>,
        kind: &'static str,
    }

    impl Transport for Leg {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
            let (call, response) = self
                .net
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("requisição a mais: {} {}", request.method, request.url));
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

        fn verified(&self, trust: &TrustMode) -> Result<Arc<dyn Transport>> {
            self.0.trusts.lock().unwrap().push(trust.clone());
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
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                )
                .expect(
                    "verificado POST /api/v1/devices/login",
                    body(201, credential()),
                ),
        );
        let shared = Shared(Arc::clone(&net));
        let server = prepare(&shared, &dir, &format!("{URL}/"), Some(CA_SHA256), true).unwrap();
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
        // O descritor e o login vão pelo transporte que confia só na CA baixada.
        assert_eq!(
            *net.trusts.lock().unwrap(),
            vec![
                TrustMode::Pinned(pending.clone()),
                TrustMode::Pinned(pending),
            ]
        );
    }

    #[test]
    fn pareamento_le_o_email_da_conta() {
        let dir = dir("codigo");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                )
                .expect(
                    "verificado POST /api/v1/devices/pair",
                    body(201, credential()),
                )
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
        let mut server = prepare(&shared, &dir, URL, None, false).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::FirstUse);
        let err = sign_in(&shared, &dir, &server, Login::Code("K7Q-4MX"), "PC").unwrap_err();
        assert!(
            err.to_string().contains("Confira a impressão digital"),
            "{err:#}"
        );
        let other = confirm(&mut server.clone(), "https://outro:8443", Some(CA_SHA256));
        assert!(other.is_err());
        confirm(&mut server, URL, Some(CA_SHA256)).unwrap();
        let signed = sign_in(&shared, &dir, &server, Login::Code("K7Q-4MX"), "PC").unwrap();
        assert!(net.done());
        assert_eq!(signed.account.email, "ana@exemplo.com.br");
    }

    #[test]
    fn impressao_digital_do_mdns_ainda_pede_a_conferencia() {
        let dir = dir("mdns");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                ),
        );
        let server = prepare(&Shared(net), &dir, URL, Some(CA_SHA256), false).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::FirstUse);
        assert!(!server.confirmed);
    }

    #[test]
    fn so_o_instalador_dispensa_a_conferencia() {
        let embedded = || {
            Some(crate::config::EmbeddedServer {
                url: URL.to_string(),
                ca_sha256: Some(CA_SHA256.to_string()),
            })
        };
        let upper = CA_SHA256.to_uppercase();
        assert!(vouched_by_installer(
            embedded(),
            &format!("{URL}/"),
            Some(&upper)
        ));
        assert!(!vouched_by_installer(embedded(), URL, None));
        assert!(!vouched_by_installer(
            embedded(),
            URL,
            Some(&"a".repeat(64))
        ));
        assert!(!vouched_by_installer(
            embedded(),
            "https://outro:8443",
            Some(CA_SHA256)
        ));
        assert!(!vouched_by_installer(None, URL, Some(CA_SHA256)));
    }

    #[test]
    fn impressao_digital_que_nao_confere_para_antes_de_entrar() {
        let dir = dir("diverge");
        let net =
            Arc::new(ScriptNet::default().expect("inseguro GET /downloads/eclume-root.crt", pem()));
        let err = prepare(&Shared(net), &dir, URL, Some(&"0".repeat(64)), false).unwrap_err();
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
        let err = prepare(&Shared(net), &dir, URL, None, false).unwrap_err();
        assert_eq!(err.to_string(), pin::CA_CHANGED);
    }

    #[test]
    fn sem_ca_publicada_usa_as_raizes_do_sistema() {
        let dir = dir("sistema");
        let net = Arc::new(
            ScriptNet::default()
                .expect(
                    "inseguro GET /downloads/eclume-root.crt",
                    body(404, json!({})),
                )
                .expect("verificado GET /api/v1/server", body(200, info(None))),
        );
        let shared = Shared(Arc::clone(&net));
        let server = prepare(&shared, &dir, URL, None, false).unwrap();
        assert_eq!(server.trusted_by, TrustedBy::System);
        assert_eq!(server.ca_path, None);
        assert_eq!(
            *net.trusts.lock().unwrap(),
            vec![TrustMode::PlatformPlus(None)]
        );
    }

    #[test]
    fn senha_errada_nao_grava_nada() {
        let dir = dir("recusa");
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", pem())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                )
                .expect(
                    "verificado POST /api/v1/devices/login",
                    body(401, json!({"code": "unauthorized"})),
                ),
        );
        let shared = Shared(net);
        let server = prepare(&shared, &dir, URL, Some(CA_SHA256), true).unwrap();
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
        let other = include_str!("../../../server/tests/fixtures/ca-test.pem");
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

    fn other_ca() -> Result<HttpResponse> {
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: OTHER_CA.as_bytes().to_vec(),
        })
    }

    const OTHER_CA: &str = include_str!("../../../server/tests/fixtures/ca-test.pem");

    #[test]
    fn proxima_raiz_aprendida_pela_conexao_fixada() {
        let dir = dir("proxima");
        let pinned = dir.join(pin::PINNED_FILE);
        std::fs::write(&pinned, CA).unwrap();
        let other_sha = pin::root_from_pem(OTHER_CA.as_bytes()).unwrap().sha256;
        let mut announced = info(Some(CA_SHA256));
        announced["ca_next_sha256"] = json!(other_sha);
        let net = Arc::new(
            ScriptNet::default()
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, announced.clone()),
                )
                .expect(
                    "verificado GET /downloads/eclume-root-proxima.crt",
                    other_ca(),
                )
                .expect("verificado GET /api/v1/server", body(200, announced))
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(CA_SHA256))),
                ),
        );
        let shared = Shared(Arc::clone(&net));
        assert!(learn_next(&shared, URL, &pinned).unwrap());
        assert_eq!(pin::saved_next(&pinned).unwrap().sha256, other_sha);
        assert!(!learn_next(&shared, URL, &pinned).unwrap(), "já guardada");
        assert!(!learn_next(&shared, URL, &pinned).unwrap());
        assert!(
            pin::saved_next(&pinned).is_none(),
            "sem anúncio, a próxima sai"
        );
        assert!(net.done());
        let trusts = net.trusts.lock().unwrap();
        assert!(trusts
            .iter()
            .all(|trust| *trust == TrustMode::Pinned(pinned.clone())));
    }

    #[test]
    fn troca_pela_proxima_quando_e_a_servida() {
        let dir = dir("troca-proxima");
        let pinned = dir.join(pin::PINNED_FILE);
        std::fs::write(&pinned, CA).unwrap();
        let other = pin::root_from_pem(OTHER_CA.as_bytes()).unwrap();
        pin::save_next(&other, &pinned).unwrap();
        let net = Arc::new(
            ScriptNet::default()
                .expect("inseguro GET /downloads/eclume-root.crt", other_ca())
                .expect(
                    "verificado GET /api/v1/server",
                    body(200, info(Some(&other.sha256))),
                )
                .expect("inseguro GET /downloads/eclume-root.crt", pem()),
        );
        let shared = Shared(Arc::clone(&net));
        assert!(!ca_changed(&shared, URL, &pinned).unwrap());
        let now_pinned = std::fs::read(&pinned).unwrap();
        assert_eq!(
            pin::root_from_pem(&now_pinned).unwrap().sha256,
            other.sha256
        );
        assert!(pin::saved_next(&pinned).is_none());
        assert_eq!(
            *net.trusts.lock().unwrap(),
            vec![TrustMode::Pinned(pin::next_path(&pinned))]
        );
        // Outra raiz, que não é a próxima anunciada: a CA mudou de fato.
        assert!(ca_changed(&shared, URL, &pinned).unwrap());
        assert!(net.done());
    }

    #[test]
    fn so_a_ca_fixada_com_certificado_a_mais_e_regravada() {
        let dir = dir("reparo");
        let other = include_str!("../../../server/tests/fixtures/ca-test.pem");
        let two = format!("{CA}{other}");
        let pinned = dir.join(pin::PINNED_FILE);
        let config = Config {
            ca_path: Some(pinned.clone()),
            ..Config::default()
        };
        std::fs::write(&pinned, CA).unwrap();
        assert!(!repair_pinned(&dir, &config).unwrap());
        assert_eq!(std::fs::read(&pinned).unwrap(), CA.as_bytes());

        std::fs::write(&pinned, &two).unwrap();
        assert!(repair_pinned(&dir, &config).unwrap());
        assert_eq!(std::fs::read(&pinned).unwrap(), CA.as_bytes());

        let chosen = dir.join("escolhida.pem");
        std::fs::write(&chosen, &two).unwrap();
        let config = Config {
            ca_path: Some(chosen.clone()),
            ..Config::default()
        };
        assert!(!repair_pinned(&dir, &config).unwrap());
        assert_eq!(std::fs::read(&chosen).unwrap(), two.as_bytes());
        assert!(!repair_pinned(&dir, &Config::default()).unwrap());
    }

    #[test]
    fn a_confianca_sai_da_origem_da_ca() {
        let dir = dir("confianca");
        let pinned = dir.join(pin::PINNED_FILE);
        assert_eq!(
            trust_for(&dir, Some(&pinned)),
            TrustMode::Pinned(pinned.clone())
        );
        let chosen = Path::new("/etc/ssl/escolhida.pem");
        assert_eq!(
            trust_for(&dir, Some(chosen)),
            TrustMode::PlatformPlus(Some(chosen.to_path_buf()))
        );
        assert_eq!(trust_for(&dir, None), TrustMode::PlatformPlus(None));
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
        assert_eq!(
            require(None).unwrap_err().to_string(),
            "Escolha o servidor antes de entrar"
        );
    }
}
