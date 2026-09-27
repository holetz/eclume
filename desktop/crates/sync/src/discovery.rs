//! A descoberta do servidor na rede local por mDNS (holetz/eclume#35): procura
//! `_eclume._tcp.local.` por alguns segundos e lê o TXT `url`, `ca`, `v` e `name` que o
//! `eclume-server announce` publica. O parser do TXT é puro; a escuta usa o `mdns-sd`.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent};

/// O tipo de serviço anunciado pelo servidor.
pub const SERVICE_TYPE: &str = "_eclume._tcp.local.";
/// Quanto a primeira execução espera por respostas.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// Um servidor achado na rede.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Found {
    pub name: String,
    pub url: String,
    /// A impressão digital da CA raiz; `None` enquanto o servidor não a publicou.
    pub ca_sha256: Option<String>,
    pub contract_version: Option<String>,
}

/// Lê um anúncio: a instância (`eclume._eclume._tcp.local.`) e os pares do TXT. Sem `url`, o
/// anúncio não serve e é ignorado.
pub fn parse(fullname: &str, txt: &[(String, String)]) -> Option<Found> {
    let get = |key: &str| {
        txt.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim())
            .filter(|v| !v.is_empty())
    };
    let url = get("url")?.trim_end_matches('/').to_string();
    let name = get("name").map_or_else(
        || {
            fullname
                .strip_suffix(SERVICE_TYPE)
                .unwrap_or(fullname)
                .trim_end_matches('.')
                .to_string()
        },
        str::to_string,
    );
    Some(Found {
        name,
        url,
        ca_sha256: get("ca").map(str::to_ascii_lowercase),
        contract_version: get("v").map(str::to_string),
    })
}

/// Junta um achado à lista, sem repetir o mesmo endereço.
fn merge(found: &mut Vec<Found>, item: Found) {
    match found.iter_mut().find(|f| f.url == item.url) {
        Some(existing) => *existing = item,
        None => found.push(item),
    }
}

/// Escuta a rede por até `timeout` e devolve os servidores achados, na ordem em que responderam.
pub fn discover(timeout: Duration) -> Result<Vec<Found>> {
    let daemon = ServiceDaemon::new().context("falha ao abrir o mDNS")?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .context("falha ao procurar o servidor na rede")?;
    let deadline = Instant::now() + timeout;
    let mut found = Vec::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = receiver.recv_timeout(remaining) else {
            break;
        };
        if let ServiceEvent::ServiceResolved(info) = event {
            let txt: Vec<(String, String)> = info
                .txt_properties
                .iter()
                .map(|p| (p.key().to_string(), p.val_str().to_string()))
                .collect();
            if let Some(item) = parse(&info.fullname, &txt) {
                merge(&mut found, item);
            }
        }
    }
    let _ = daemon.shutdown();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn txt(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn le_o_txt_do_anuncio() {
        let ca = "3F9A1C6E0B7D24F58E1A9C3B6D0F2E4A7C5B8D1E3F6A9C2B4D7E0F1A3C5E7B9D";
        let found = parse(
            "eclume._eclume._tcp.local.",
            &txt(&[
                ("url", "https://192.168.15.199:8443/"),
                ("ca", ca),
                ("v", "2.3.0"),
                ("name", "eclume"),
            ]),
        )
        .unwrap();
        assert_eq!(
            found,
            Found {
                name: "eclume".into(),
                url: "https://192.168.15.199:8443".into(),
                ca_sha256: Some(ca.to_ascii_lowercase()),
                contract_version: Some("2.3.0".into()),
            }
        );
    }

    #[test]
    fn ca_vazia_e_nome_pela_instancia() {
        let found = parse(
            "Escritório._eclume._tcp.local.",
            &txt(&[("url", "https://eclume.lan"), ("ca", "")]),
        )
        .unwrap();
        assert_eq!(found.name, "Escritório");
        assert_eq!(found.ca_sha256, None);
        assert_eq!(found.contract_version, None);
    }

    #[test]
    fn anuncio_sem_url_e_ignorado() {
        assert_eq!(parse("x._eclume._tcp.local.", &txt(&[("name", "x")])), None);
        assert_eq!(parse("x._eclume._tcp.local.", &txt(&[("url", " ")])), None);
    }

    #[test]
    fn nao_repete_o_mesmo_endereco() {
        let mut found = Vec::new();
        let a = parse("a._eclume._tcp.local.", &txt(&[("url", "https://a")])).unwrap();
        let b = parse("b._eclume._tcp.local.", &txt(&[("url", "https://b")])).unwrap();
        let a2 = parse(
            "a._eclume._tcp.local.",
            &txt(&[("url", "https://a/"), ("ca", "ab")]),
        )
        .unwrap();
        merge(&mut found, a);
        merge(&mut found, b);
        merge(&mut found, a2);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].ca_sha256.as_deref(), Some("ab"));
    }

    /// Escuta a rede de verdade; roda só onde há um servidor anunciando (`--ignored`).
    #[test]
    #[ignore = "depende de um servidor anunciando na rede local"]
    fn acha_o_servidor_na_rede() {
        let found = discover(DEFAULT_TIMEOUT).unwrap();
        assert!(!found.is_empty(), "nenhum servidor na rede");
    }
}
