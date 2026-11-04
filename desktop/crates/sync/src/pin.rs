//! The server CA pinned by fingerprint (holetz/eclume#35, "CA pinning by the apps").
//!
//! Caddy `tls internal` rotates the leaf certificate every ~12 h and does not send the root in the
//! chain, so the app pins the **root**: downloads `<url>/downloads/eclume-root.crt` over an
//! unverified connection (only this file), checks the SHA-256 of the first certificate's DER
//! against the expected fingerprint (from the installer, mDNS or QR) and saves **only that
//! certificate**, the only one `transport.rs` (`TrustMode::Pinned`) and the updater trust, without
//! adding it to the OS roots (holetz/eclume#102). Extra certificates in the served file never reach
//! disk. Without an expected fingerprint, it trusts the first one (TOFU) and shows it to the user.
//! The `GET /api/v1/server` descriptor, now verified, confirms what was received.
//!
//! A previously saved pinned file with multiple certificates is rewritten with only the first by
//! [`trim_saved`]; the app treats this as possible interception and asks for sign-in again
//! ([`CA_TRIMMED`]).
//!
//! Announced rotation (holetz/eclume#101): the descriptor, read over the connection pinned to the
//! current root, contains `ca_next_sha256`; the app downloads the next root over that same
//! connection ([`fetch_next`]) and saves it separately ([`save_next`], one certificate only). When
//! the server starts serving it, the app promotes it to pinned ([`promote_next`]) instead of asking
//! for sign-in again.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};
use ureq::tls::PemItem;

use crate::api::ServerInfo;
use crate::protocol::{api_error, parse_base};
use crate::transport::{HttpRequest, Transport};

/// Where the CA is published on the server.
pub const ROOT_PATH: &str = "/downloads/eclume-root.crt";
/// The pinned CA file in the app's config folder.
pub const PINNED_FILE: &str = "servidor-ca.pem";
/// Where the next root is published during rotation.
pub const NEXT_PATH: &str = "/downloads/eclume-root-proxima.crt";
/// The message when the server root is no longer the pinned one.
pub const CA_CHANGED: &str = "O certificado do servidor mudou";
/// The message when the stored pinned CA had extra certificates and was rewritten with only the
/// first: the first connection may have gone through an interceptor.
pub const CA_TRIMMED: &str = "O certificado guardado deste servidor tinha um certificado a mais: \
                              a primeira conexão pode ter sido interceptada. Entre de novo e, na \
                              web, troque a senha e desvincule a entrada antiga deste aparelho.";

const BEGIN_CERT: &[u8] = b"-----BEGIN CERTIFICATE-----";
const END_CERT: &[u8] = b"-----END CERTIFICATE-----";

/// The downloaded root and its fingerprint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootCa {
    pub pem: Vec<u8>,
    /// SHA-256 of the DER, in lowercase hex (the contract's `ca_sha256` format).
    pub sha256: String,
}

/// SHA-256 in lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A fingerprint as written by the contract: 64 lowercase hex digits. Accepts uppercase and `:`.
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

/// Each PEM certificate's DER, in order; non-certificate items are ignored.
fn certificates(pem: &[u8]) -> Vec<Vec<u8>> {
    ureq::tls::parse_pem(pem)
        .filter_map(|item| match item {
            Ok(PemItem::Certificate(cert)) => Some(cert.der().to_vec()),
            _ => None,
        })
        .collect()
}

/// The first `CERTIFICATE` block in the text, including its terminating line ending.
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

/// The first certificate's PEM (only that one) and its fingerprint. The block is cut from the
/// received text and reread: it must yield exactly one certificate, with the same DER as the first
/// in the file.
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

/// Downloads the certificate at `<url><path>` through `transport` and checks `expected`, if
/// provided.
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

/// Downloads the root from `url` through `insecure` (a transport without TLS verification, used
/// only here) and checks `expected`; without `expected`, returns the root for the user to check
/// (TOFU).
pub fn fetch_root(insecure: &dyn Transport, url: &str, expected: Option<&str>) -> Result<RootCa> {
    download(insecure, url, ROOT_PATH, expected)
}

/// Downloads the next root through `pinned` (the transport pinned to the current root, which
/// vouches for the new one) and checks the descriptor's `ca_next_sha256`.
pub fn fetch_next(pinned: &dyn Transport, url: &str, expected: &str) -> Result<RootCa> {
    download(pinned, url, NEXT_PATH, Some(expected))
}

/// Writes the root to `<config_dir>/servidor-ca.pem` and returns the path, the app's `ca_path`.
pub fn save(root: &RootCa, config_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(config_dir)
        .with_context(|| format!("falha ao criar {}", config_dir.display()))?;
    let path = config_dir.join(PINNED_FILE);
    std::fs::write(&path, &root.pem)
        .with_context(|| format!("falha ao gravar {}", path.display()))?;
    Ok(path)
}

/// Writes `pem` to `path` through a temporary file and `rename`: readers never see a partial file.
fn write_atomic(path: &Path, pem: &[u8]) -> Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".novo");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, pem).with_context(|| format!("falha ao gravar {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("falha ao substituir {}", path.display()))
}

/// Where the next root lives, beside the pinned one: `servidor-ca.pem` → `servidor-ca.proxima.pem`
/// on desktop, `ca.pem` → `ca.proxima.pem` on mobile.
pub fn next_path(pinned: &Path) -> PathBuf {
    pinned.with_extension("proxima.pem")
}

/// Writes the next root beside the pinned one at `pinned` (one certificate only) and returns its
/// path.
pub fn save_next(root: &RootCa, pinned: &Path) -> Result<PathBuf> {
    let path = next_path(pinned);
    write_atomic(&path, &root.pem)?;
    Ok(path)
}

/// The next root stored beside the pinned one at `pinned`, if readable.
pub fn saved_next(pinned: &Path) -> Option<RootCa> {
    let pem = std::fs::read(next_path(pinned)).ok()?;
    root_from_pem(&pem).ok()
}

/// Deletes the next root stored beside `pinned` (the server stopped announcing it, or the user
/// signed in again); without a file, nothing to do.
pub fn forget_next(pinned: &Path) -> Result<()> {
    let path = next_path(pinned);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("falha ao apagar {}", path.display())),
    }
}

/// Stores the next root announced by `info` (`ca_next_sha256`, in the descriptor read through
/// `transport`, pinned to the current root at `pinned`): downloads it over the same connection,
/// checks it and saves it beside the pinned one. Without an announcement, deletes the previously
/// stored next root. Reports whether a new one was saved.
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

/// Replaces the pinned root at `pinned` with the next one stored beside it (`rename`, the whole
/// file at once): the pinned transport and updater now trust only that root.
pub fn promote_next(pinned: &Path) -> Result<()> {
    let next = next_path(pinned);
    std::fs::rename(&next, pinned)
        .with_context(|| format!("falha ao substituir {}", pinned.display()))
}

/// Rewrites the pinned file at `path` with only the first certificate (temporary file + `rename`)
/// and returns how many were discarded; with only one certificate, leaves the file untouched and
/// returns 0.
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

/// Checks through the already verified descriptor that the server announces the pinned root. A
/// descriptor without `ca_sha256` (root not yet published) contradicts nothing.
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

    const CA: &str = include_str!("../tests/fixtures/test-ca.pem");
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
    fn fingerprint_of_first_certificate_der() {
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
    fn root_is_only_first_certificate() {
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
    fn save_writes_one_certificate_and_trim_saved_rewrites_old_file() {
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
            "a single certificate is left untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizes_fingerprint() {
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
    fn downloads_checks_and_saves() {
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
            "the saved PEM works as ca_path"
        );
    }

    #[test]
    fn next_root_checked_saved_and_promoted() {
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
    fn descriptor_confirms_or_reports_change() {
        confirm(&info(Some(CA_SHA256)), CA_SHA256).unwrap();
        confirm(&info(None), CA_SHA256).unwrap();
        let err = confirm(&info(Some(&"a".repeat(64))), CA_SHA256).unwrap_err();
        assert_eq!(err.to_string(), CA_CHANGED);
    }
}
