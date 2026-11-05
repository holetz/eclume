//! Local network server discovery via mDNS (holetz/eclume#35): searches for `_eclume._tcp.local.`
//! for a few seconds and reads the TXT `url`, `ca`, `v` and `name` published by
//! `eclume-server announce`. The TXT parser is pure; listening uses `mdns-sd`.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent};

/// The service type announced by the server.
pub const SERVICE_TYPE: &str = "_eclume._tcp.local.";
/// How long first run waits for responses.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// A server found on the network.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Found {
    pub name: String,
    pub url: String,
    /// The root CA fingerprint; `None` until the server publishes it.
    pub ca_sha256: Option<String>,
    pub contract_version: Option<String>,
}

/// Reads an announcement: the instance (`eclume._eclume._tcp.local.`) and TXT pairs. Without `url`,
/// the announcement is unusable and ignored.
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

/// Adds a result to the list without repeating the same address.
fn merge(found: &mut Vec<Found>, item: Found) {
    match found.iter_mut().find(|f| f.url == item.url) {
        Some(existing) => *existing = item,
        None => found.push(item),
    }
}

/// Listens to the network for up to `timeout` and returns servers in response order.
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
    fn reads_announcement_txt() {
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
    fn empty_ca_and_name_from_instance() {
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
    fn announcement_without_url_is_ignored() {
        assert_eq!(parse("x._eclume._tcp.local.", &txt(&[("name", "x")])), None);
        assert_eq!(parse("x._eclume._tcp.local.", &txt(&[("url", " ")])), None);
    }

    #[test]
    fn does_not_repeat_same_address() {
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

    /// Listens to the real network; run only where a server is announcing (`--ignored`).
    #[test]
    #[ignore = "requires a server announcing on the local network"]
    fn finds_server_on_network() {
        let found = discover(DEFAULT_TIMEOUT).unwrap();
        assert!(!found.is_empty(), "no server on the network");
    }
}
