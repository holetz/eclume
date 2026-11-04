//! Apoio dos testes do núcleo: diretórios temporários e um transporte roteirizado por rota.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use eclume_mobile_core::conexao::Transportes;
use eclume_mobile_core::config::Dirs;
use eclume_sync::transport::{HttpRequest, HttpResponse, Transport};

/// A CA autoassinada de teste do crate de sync e a impressão digital dela.
pub const CA_PEM: &str =
    include_str!("../../../../../desktop/crates/sync/tests/fixtures/test-ca.pem");
pub const CA_SHA256: &str = "b36a35276dcebd4b810c47c567f5b240f638450ab9701d196c64e4e7c6eaa233";

pub type Resposta = Result<HttpResponse>;

pub fn json(status: u16, body: serde_json::Value) -> Resposta {
    Ok(HttpResponse {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: serde_json::to_vec(&body).unwrap(),
    })
}

pub fn texto(status: u16, body: &str) -> Resposta {
    Ok(HttpResponse {
        status,
        headers: Vec::new(),
        body: body.as_bytes().to_vec(),
    })
}

pub fn falha(motivo: &str) -> Resposta {
    Err(anyhow!("{motivo}"))
}

type Rota = (String, String, Box<dyn Fn() -> Resposta + Send + Sync>);

/// Responde por método e fim do caminho (sem a query); a última rota cadastrada vence. Guarda os
/// pedidos vistos.
#[derive(Clone, Default)]
pub struct Roteiro {
    rotas: Arc<Mutex<Vec<Rota>>>,
    vistos: Arc<Mutex<Vec<HttpRequest>>>,
}

impl Roteiro {
    pub fn responde(&self, metodo: &str, caminho: &str, resposta: Resposta) {
        let guardada = resposta.map_err(|e| format!("{e:#}"));
        self.responde_com(metodo, caminho, move || match &guardada {
            Ok(r) => Ok(r.clone()),
            Err(e) => Err(anyhow!("{e}")),
        });
    }

    pub fn responde_com(
        &self,
        metodo: &str,
        caminho: &str,
        f: impl Fn() -> Resposta + Send + Sync + 'static,
    ) {
        self.rotas
            .lock()
            .unwrap()
            .push((metodo.into(), caminho.into(), Box::new(f)));
    }

    pub fn pedido(&self, metodo: &str, caminho: &str) -> Option<HttpRequest> {
        self.vistos
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|p| p.method == metodo && caminho_de(&p.url).ends_with(caminho))
            .cloned()
    }

    pub fn quantos(&self, metodo: &str, caminho: &str) -> usize {
        self.vistos
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.method == metodo && caminho_de(&p.url).ends_with(caminho))
            .count()
    }
}

fn caminho_de(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

impl Transport for Roteiro {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let caminho = caminho_de(&request.url).to_string();
        let metodo = request.method;
        self.vistos.lock().unwrap().push(request);
        let rotas = self.rotas.lock().unwrap();
        let rota = rotas
            .iter()
            .rev()
            .find(|(m, c, _)| m == metodo && caminho.ends_with(c.as_str()))
            .ok_or_else(|| anyhow!("rota não roteirizada: {metodo} {caminho}"))?;
        (rota.2)()
    }
}

/// Os dois transportes do núcleo são o mesmo roteiro.
pub struct TransportesFalsos(pub Roteiro);

impl Transportes for TransportesFalsos {
    fn inseguro(&self) -> Arc<dyn Transport> {
        Arc::new(self.0.clone())
    }

    fn fixado(&self, ca: &Path, _prazo: Duration) -> Result<Arc<dyn Transport>> {
        if !ca.exists() {
            return Err(anyhow!("CA fixada ausente em {}", ca.display()));
        }
        Ok(Arc::new(self.0.clone()))
    }
}

/// Apaga o diretório ao sair do teste.
pub struct Limpa(PathBuf);

impl Drop for Limpa {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn dirs_temp(nome: &str) -> (Dirs, Limpa) {
    let raiz = std::env::temp_dir().join(format!(
        "eclume-movel-{nome}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dirs = Dirs {
        dados: raiz.join("dados"),
        sem_backup: raiz.join("sem-backup"),
    };
    (dirs, Limpa(raiz))
}
