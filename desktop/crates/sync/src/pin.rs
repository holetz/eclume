//! A CA do servidor fixada pela impressão digital (holetz/eclume#35, "Fixação da CA pelos apps").
//!
//! O Caddy `tls internal` troca o certificado folha a cada ~12 h e não envia a raiz na cadeia, por
//! isso o app fixa a **raiz**: baixa `<url>/downloads/eclume-root.crt` numa conexão sem
//! verificação (só esse arquivo), confere o SHA-256 do DER do primeiro certificado com a impressão
//! digital esperada (do instalador, do mDNS ou do QR) e grava **só esse certificado**, o único em
//! que o `transport.rs` (`TrustMode::Pinned`) e o updater confiam, sem somá-lo às raízes do SO
//! (holetz/eclume#102). Certificados a mais no arquivo servido nunca chegam ao disco. Sem impressão
//! digital esperada, confia na primeira (TOFU) e a mostra à pessoa. O descritor
//! `GET /api/v1/server`, já com verificação, confirma o que veio.
//!
//! Um arquivo fixado gravado antes com mais de um certificado é regravado só com o primeiro por
//! [`trim_saved`]; o app trata o caso como possível interceptação e pede nova entrada
//! ([`CA_TRIMMED`]).
//!
//! Rotação anunciada (holetz/eclume#101): o descritor, lido pela conexão fixada na raiz atual,
//! traz `ca_next_sha256`; o app baixa a próxima raiz por essa mesma conexão ([`fetch_next`]) e a
//! guarda à parte ([`save_next`], um certificado só). Quando o servidor passa a servi-la, o app a
//! promove a fixada ([`promote_next`]) em vez de pedir nova entrada.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use ureq::tls::PemItem;

use crate::api::ServerInfo;
use crate::protocol::{api_error, parse_base};
use crate::transport::{HttpRequest, Transport};

/// Onde a CA fica publicada no servidor.
pub const ROOT_PATH: &str = "/downloads/eclume-root.crt";
/// O arquivo da CA fixada, na pasta de configuração do app.
pub const PINNED_FILE: &str = "servidor-ca.pem";
/// Onde a próxima raiz fica publicada durante a rotação.
pub const NEXT_PATH: &str = "/downloads/eclume-root-proxima.crt";
/// A mensagem quando a raiz do servidor não é mais a fixada.
pub const CA_CHANGED: &str = "O certificado do servidor mudou";
/// A mensagem quando a CA fixada guardada tinha certificados a mais e foi regravada só com o
/// primeiro: a primeira conexão pode ter passado por um interceptador.
pub const CA_TRIMMED: &str = "O certificado guardado deste servidor tinha um certificado a mais: \
                              a primeira conexão pode ter sido interceptada. Entre de novo e, na \
                              web, troque a senha e desvincule a entrada antiga deste aparelho.";

const BEGIN_CERT: &[u8] = b"-----BEGIN CERTIFICATE-----";
const END_CERT: &[u8] = b"-----END CERTIFICATE-----";

/// A raiz baixada e a sua impressão digital.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootCa {
    pub pem: Vec<u8>,
    /// SHA-256 do DER, em hex minúsculo (o formato do `ca_sha256` do contrato).
    pub sha256: String,
}

/// SHA-256 em hex minúsculo.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Uma impressão digital como o contrato escreve: 64 hex minúsculos. Aceita maiúsculas e `:`.
pub fn normalize_fingerprint(value: &str) -> Result<String> {
    let hex: String = value
        .trim()
        .chars()
        .filter(|c| *c != ':')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("impressão digital inválida: esperava o SHA-256 em 64 caracteres hexadecimais");
    }
    Ok(hex)
}

/// O DER de cada certificado do PEM, na ordem; itens que não são certificado são ignorados.
fn certificates(pem: &[u8]) -> Vec<Vec<u8>> {
    ureq::tls::parse_pem(pem)
        .filter_map(|item| match item {
            Ok(PemItem::Certificate(cert)) => Some(cert.der().to_vec()),
            _ => None,
        })
        .collect()
}

/// O primeiro bloco `CERTIFICATE` do texto, com o fim de linha que o encerra.
fn first_block(pem: &[u8]) -> Option<&[u8]> {
    let start = find(pem, BEGIN_CERT)?;
    let end = start + find(&pem[start..], END_CERT)? + END_CERT.len();
    let rest = &pem[end..];
    let newline = if rest.starts_with(b"\r\n") {
        2
    } else {
        usize::from(rest.starts_with(b"\n"))
    };
    Some(&pem[start..end + newline])
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// O PEM do primeiro certificado (só ele) e a sua impressão digital. O bloco é recortado do texto
/// recebido e relido: tem de dar exatamente um certificado, o mesmo DER do primeiro do arquivo.
pub fn root_from_pem(pem: &[u8]) -> Result<RootCa> {
    let not_pem = || anyhow!("a CA do servidor não é um certificado PEM");
    let der = certificates(pem).into_iter().next().ok_or_else(not_pem)?;
    let block = first_block(pem).ok_or_else(not_pem)?;
    if certificates(block) != [der.as_slice()] {
        bail!("a CA do servidor não pôde ser separada do primeiro certificado do arquivo");
    }
    Ok(RootCa {
        pem: block.to_vec(),
        sha256: sha256_hex(&der),
    })
}

/// Baixa o certificado em `<url><path>` por `transport` e confere com `expected`, se houver.
fn download(
    transport: &dyn Transport,
    url: &str,
    path: &str,
    expected: Option<&str>,
) -> Result<RootCa> {
    let base = parse_base(url)?;
    let address = format!("{}{path}", base.as_str().trim_end_matches('/'));
    let response = transport
        .send(HttpRequest::new("GET", address.clone()))
        .with_context(|| format!("não foi possível falar com o servidor em {base}"))?;
    if !response.is_success() {
        return Err(api_error("falha ao baixar a CA do servidor", &response));
    }
    let root = root_from_pem(&response.body)?;
    if let Some(expected) = expected {
        if root.sha256 != normalize_fingerprint(expected)? {
            bail!(
                "a CA em {address} não confere com a impressão digital esperada; \
                 confira o endereço com quem administra o servidor"
            );
        }
    }
    Ok(root)
}

/// Baixa a raiz de `url` por `insecure` (um transporte sem verificação de TLS, usado só aqui) e
/// confere com `expected`; sem `expected`, devolve a raiz para a pessoa conferir (TOFU).
pub fn fetch_root(insecure: &dyn Transport, url: &str, expected: Option<&str>) -> Result<RootCa> {
    download(insecure, url, ROOT_PATH, expected)
}

/// Baixa a próxima raiz por `pinned` (o transporte fixado na raiz atual, que avaliza a nova) e
/// confere com o `ca_next_sha256` do descritor.
pub fn fetch_next(pinned: &dyn Transport, url: &str, expected: &str) -> Result<RootCa> {
    download(pinned, url, NEXT_PATH, Some(expected))
}

/// Grava a raiz em `<config_dir>/servidor-ca.pem` e devolve o caminho, o `ca_path` do app.
pub fn save(root: &RootCa, config_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("falha ao criar {}", config_dir.display()))?;
    let path = config_dir.join(PINNED_FILE);
    std::fs::write(&path, &root.pem)
        .with_context(|| format!("falha ao gravar {}", path.display()))?;
    Ok(path)
}

/// Grava `pem` em `path` por um temporário e `rename`: quem lê nunca vê o arquivo pela metade.
fn write_atomic(path: &Path, pem: &[u8]) -> Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".novo");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, pem).with_context(|| format!("falha ao gravar {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("falha ao substituir {}", path.display()))
}

/// Onde a próxima raiz fica, ao lado da fixada: `servidor-ca.pem` → `servidor-ca.proxima.pem` no
/// desktop, `ca.pem` → `ca.proxima.pem` no celular.
pub fn next_path(pinned: &Path) -> PathBuf {
    pinned.with_extension("proxima.pem")
}

/// Grava a próxima raiz ao lado da fixada em `pinned` (um certificado só) e devolve o caminho.
pub fn save_next(root: &RootCa, pinned: &Path) -> Result<PathBuf> {
    let path = next_path(pinned);
    write_atomic(&path, &root.pem)?;
    Ok(path)
}

/// A próxima raiz guardada ao lado da fixada em `pinned`, se houver uma legível.
pub fn saved_next(pinned: &Path) -> Option<RootCa> {
    let pem = std::fs::read(next_path(pinned)).ok()?;
    root_from_pem(&pem).ok()
}

/// Apaga a próxima raiz guardada ao lado de `pinned` (o servidor deixou de anunciá-la, ou a
/// pessoa entrou de novo); sem arquivo, nada a fazer.
pub fn forget_next(pinned: &Path) -> Result<()> {
    let path = next_path(pinned);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("falha ao apagar {}", path.display())),
    }
}

/// Guarda a próxima raiz que `info` anuncia (`ca_next_sha256`, no descritor lido por `transport`,
/// fixado na raiz atual em `pinned`): baixa-a pela mesma conexão, confere e grava ao lado da
/// fixada. Sem anúncio, apaga a próxima guardada antes. Diz se gravou uma nova.
pub fn learn_next(
    transport: &dyn Transport,
    url: &str,
    info: &ServerInfo,
    pinned: &Path,
) -> Result<bool> {
    let Some(announced) = info.ca_next_sha256.as_deref() else {
        forget_next(pinned)?;
        return Ok(false);
    };
    let next = normalize_fingerprint(announced)?;
    if saved_next(pinned).is_some_and(|saved| saved.sha256 == next) {
        return Ok(false);
    }
    let root = fetch_next(transport, url, &next)?;
    save_next(&root, pinned)?;
    Ok(true)
}

/// Troca a fixada em `pinned` pela próxima guardada ao lado (`rename`, o arquivo inteiro de uma
/// vez): o transporte fixado e o updater passam a confiar só nela.
pub fn promote_next(pinned: &Path) -> Result<()> {
    let next = next_path(pinned);
    std::fs::rename(&next, pinned)
        .with_context(|| format!("falha ao substituir {}", pinned.display()))
}

/// Regrava o arquivo fixado em `path` só com o primeiro certificado (temporário + `rename`) e
/// devolve quantos descartou; com um certificado só, o arquivo não é tocado e devolve 0.
pub fn trim_saved(path: &Path) -> Result<usize> {
    let pem = std::fs::read(path).with_context(|| format!("falha ao ler {}", path.display()))?;
    let total = certificates(&pem).len();
    if total <= 1 {
        return Ok(0);
    }
    let root = root_from_pem(&pem).with_context(|| format!("CA inválida em {}", path.display()))?;
    write_atomic(path, &root.pem)?;
    Ok(total - 1)
}

/// Confere, pelo descritor lido já com verificação, que o servidor anuncia a raiz fixada. Um
/// descritor sem `ca_sha256` (raiz ainda não publicada) não contradiz nada.
pub fn confirm(info: &ServerInfo, pinned: &str) -> Result<()> {
    match info.ca_sha256.as_deref() {
        Some(announced) if normalize_fingerprint(announced)? != pinned => bail!(CA_CHANGED),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::script::{json, Script};
    use crate::transport::HttpResponse;

    const CA: &str = include_str!("../tests/fixtures/ca-teste.pem");
    const CA_SHA256: &str = "b36a35276dcebd4b810c47c567f5b240f638450ab9701d196c64e4e7c6eaa233";
    const OTHER_CA: &str = include_str!("../../../../server/tests/fixtures/ca-test.pem");

    fn pem(body: &str) -> Result<HttpResponse> {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".into(), "application/x-x509-ca-cert".into())],
            body: body.as_bytes().to_vec(),
        })
    }

    fn info(ca: Option<&str>) -> ServerInfo {
        ServerInfo {
            name: "eclume".into(),
            url: "https://eclume.test:8443".into(),
            ca_sha256: ca.map(str::to_string),
            ca_next_sha256: None,
            version: "0.1.0".into(),
            contract_version: "2.3.0".into(),
        }
    }

    #[test]
    fn impressao_digital_do_der_do_primeiro_certificado() {
        let root = root_from_pem(CA.as_bytes()).unwrap();
        assert_eq!(root.sha256, CA_SHA256);
        let two = format!("{CA}{CA}");
        assert_eq!(root_from_pem(two.as_bytes()).unwrap().sha256, CA_SHA256);
        assert!(root_from_pem(b"<html>login</html>").is_err());
    }

    fn crlf(pem: &str) -> String {
        pem.replace("\r\n", "\n").replace('\n', "\r\n")
    }

    #[test]
    fn a_raiz_e_so_o_primeiro_certificado() {
        let lf = CA.replace("\r\n", "\n");
        for body in [
            format!("{CA}{OTHER_CA}"),
            format!("texto antes do bloco\n{lf}{OTHER_CA}"),
            crlf(&format!("{CA}{OTHER_CA}")),
        ] {
            let root = root_from_pem(body.as_bytes()).unwrap();
            assert_eq!(root.sha256, CA_SHA256);
            assert_eq!(certificates(&root.pem).len(), 1, "{body}");
            assert!(root.pem.starts_with(BEGIN_CERT));
        }
        let other_first = format!("{OTHER_CA}{CA}");
        assert_ne!(
            root_from_pem(other_first.as_bytes()).unwrap().sha256,
            CA_SHA256
        );
    }

    #[test]
    fn save_grava_um_certificado_e_trim_saved_regrava_o_antigo() {
        let dir = std::env::temp_dir().join(format!("eclume-pin-trim-{}", std::process::id()));
        let two = format!("{CA}{OTHER_CA}");
        let root = root_from_pem(two.as_bytes()).unwrap();
        let path = save(&root, &dir).unwrap();
        assert_eq!(crate::transport::read_pem_certs(&path).unwrap().len(), 1);
        assert_eq!(trim_saved(&path).unwrap(), 0);

        std::fs::write(&path, &two).unwrap();
        assert_eq!(trim_saved(&path).unwrap(), 1);
        let kept = std::fs::read(&path).unwrap();
        assert_eq!(certificates(&kept).len(), 1);
        assert_eq!(root_from_pem(&kept).unwrap().sha256, CA_SHA256);
        assert_eq!(trim_saved(&path).unwrap(), 0);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            kept,
            "um certificado só não é tocado"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normaliza_a_impressao_digital() {
        let colons = CA_SHA256
            .to_uppercase()
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(normalize_fingerprint(&colons).unwrap(), CA_SHA256);
        assert!(normalize_fingerprint("abc").is_err());
        assert!(normalize_fingerprint(&"z".repeat(64)).is_err());
    }

    #[test]
    fn baixa_confere_e_grava() {
        let script = Script::default()
            .expect("GET /downloads/eclume-root.crt", pem(CA))
            .expect("GET /downloads/eclume-root.crt", pem(CA))
            .expect("GET /downloads/eclume-root.crt", pem(CA))
            .expect(
                "GET /downloads/eclume-root.crt",
                json(404, serde_json::json!({})),
            );
        let url = "https://eclume.test:8443/";
        let root = fetch_root(&script, url, Some(&CA_SHA256.to_uppercase())).unwrap();
        assert_eq!(root.sha256, CA_SHA256);

        let tofu = fetch_root(&script, url, None).unwrap();
        assert_eq!(tofu.sha256, CA_SHA256);

        let err = fetch_root(&script, url, Some(&"0".repeat(64))).unwrap_err();
        assert!(format!("{err:#}").contains("não confere"), "{err:#}");
        assert!(fetch_root(&script, url, None).is_err());

        let dir = std::env::temp_dir().join(format!("eclume-pin-{}", std::process::id()));
        let path = save(&root, &dir).unwrap();
        assert_eq!(path.file_name().unwrap(), PINNED_FILE);
        assert_eq!(std::fs::read(&path).unwrap(), CA.as_bytes());
        assert_eq!(
            crate::transport::read_pem_certs(&path).unwrap().len(),
            1,
            "o PEM gravado serve de ca_path"
        );
    }

    #[test]
    fn proxima_raiz_conferida_guardada_e_promovida() {
        let dir = std::env::temp_dir().join(format!("eclume-pin-proxima-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pinned = save(&root_from_pem(OTHER_CA.as_bytes()).unwrap(), &dir).unwrap();
        assert_eq!(next_path(&pinned), dir.join("servidor-ca.proxima.pem"));
        assert_eq!(next_path(Path::new("ca.pem")), Path::new("ca.proxima.pem"));

        let script = Script::default()
            .expect("GET /downloads/eclume-root-proxima.crt", pem(CA))
            .expect("GET /downloads/eclume-root-proxima.crt", pem(CA));
        let url = "https://eclume.test:8443/";
        let err = fetch_next(&script, url, &"0".repeat(64)).unwrap_err();
        assert!(format!("{err:#}").contains("não confere"), "{err:#}");
        let next = fetch_next(&script, url, CA_SHA256).unwrap();

        assert!(saved_next(&pinned).is_none());
        save_next(&next, &pinned).unwrap();
        assert_eq!(saved_next(&pinned).unwrap().sha256, CA_SHA256);
        promote_next(&pinned).unwrap();
        let promoted = std::fs::read(&pinned).unwrap();
        assert_eq!(root_from_pem(&promoted).unwrap().sha256, CA_SHA256);
        assert_eq!(certificates(&promoted).len(), 1);
        assert!(saved_next(&pinned).is_none());

        forget_next(&pinned).unwrap();
        save_next(&next, &pinned).unwrap();
        forget_next(&pinned).unwrap();
        assert!(!next_path(&pinned).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn descritor_confirma_ou_acusa_a_troca() {
        confirm(&info(Some(CA_SHA256)), CA_SHA256).unwrap();
        confirm(&info(None), CA_SHA256).unwrap();
        let err = confirm(&info(Some(&"a".repeat(64))), CA_SHA256).unwrap_err();
        assert_eq!(err.to_string(), CA_CHANGED);
    }
}
