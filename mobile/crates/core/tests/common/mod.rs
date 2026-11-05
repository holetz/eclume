//! Support for the core tests: temporary directories and a transport scripted per route.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_mobile_core::config::Dirs;
use eclume_mobile_core::connection::Transports;
use eclume_sync::transport::{HttpRequest, HttpResponse, Transport};

/// The sync crate's self-signed test CA and its fingerprint.
pub const CA_PEM: &str =
    include_str!("../../../../../desktop/crates/sync/tests/fixtures/test-ca.pem");
pub const CA_SHA256: &str = "b36a35276dcebd4b810c47c567f5b240f638450ab9701d196c64e4e7c6eaa233";

pub type Reply = Result<HttpResponse>;

pub fn json(status: u16, body: serde_json::Value) -> Reply {
    Ok(HttpResponse {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: serde_json::to_vec(&body).unwrap(),
    })
}

pub fn text(status: u16, body: &str) -> Reply {
    Ok(HttpResponse {
        status,
        headers: Vec::new(),
        body: body.as_bytes().to_vec(),
    })
}

pub fn failure(reason: &str) -> Reply {
    Err(anyhow!("{reason}"))
}

type Route = (String, String, Box<dyn Fn() -> Reply + Send + Sync>);

/// Answers by method and path suffix (without the query); the last registered route wins. Keeps
/// the requests seen.
#[derive(Clone, Default)]
pub struct Script {
    routes: Arc<Mutex<Vec<Route>>>,
    seen: Arc<Mutex<Vec<HttpRequest>>>,
}

impl Script {
    pub fn reply(&self, method: &str, path: &str, reply: Reply) {
        let stored = reply.map_err(|e| format!("{e:#}"));
        self.reply_with(method, path, move || match &stored {
            Ok(r) => Ok(r.clone()),
            Err(e) => Err(anyhow!("{e}")),
        });
    }

    pub fn reply_with(
        &self,
        method: &str,
        path: &str,
        f: impl Fn() -> Reply + Send + Sync + 'static,
    ) {
        self.routes
            .lock()
            .unwrap()
            .push((method.into(), path.into(), Box::new(f)));
    }

    pub fn request(&self, method: &str, path: &str) -> Option<HttpRequest> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|p| p.method == method && path_of(&p.url).ends_with(path))
            .cloned()
    }

    pub fn count(&self, method: &str, path: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.method == method && path_of(&p.url).ends_with(path))
            .count()
    }
}

fn path_of(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

impl Transport for Script {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let path = path_of(&request.url).to_string();
        let method = request.method;
        self.seen.lock().unwrap().push(request);
        let routes = self.routes.lock().unwrap();
        let route = routes
            .iter()
            .rev()
            .find(|(m, c, _)| m == method && path.ends_with(c.as_str()))
            .ok_or_else(|| anyhow!("unscripted route: {method} {path}"))?;
        (route.2)()
    }
}

/// Both of the core's transports are the same script.
pub struct FakeTransports(pub Script);

impl Transports for FakeTransports {
    fn insecure(&self) -> Arc<dyn Transport> {
        Arc::new(self.0.clone())
    }

    fn pinned(&self, ca: &Path, _timeout: Duration) -> Result<Arc<dyn Transport>> {
        if !ca.exists() {
            return Err(anyhow!("pinned CA missing at {}", ca.display()));
        }
        Ok(Arc::new(self.0.clone()))
    }
}

/// Deletes the directory when the test ends.
pub struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn temp_dirs(name: &str) -> (Dirs, Cleanup) {
    let root = std::env::temp_dir().join(format!(
        "eclume-movel-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dirs = Dirs {
        data: root.join("dados"),
        no_backup: root.join("sem-backup"),
    };
    (dirs, Cleanup(root))
}
