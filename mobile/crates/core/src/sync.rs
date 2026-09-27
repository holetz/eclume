//! O sync do celular: o `sync_pending` do `eclume-recorder` com o `HttpUploader` do `eclume-sync`
//! pela CA fixada, com o andamento por parte medido no transporte, a retenção e as leituras
//! autenticadas que o app faz fora do upload (tipos de agenda e etapas no servidor).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use eclume_recorder::{now_ms, sync_pending, Queue, QueuedRecording, SyncReport, Uploader};
use eclume_sync::protocol::{api_error, RetryPolicy};
use eclume_sync::transport::{HttpRequest, HttpResponse, Transport};
use eclume_sync::{Client, HttpUploader};
use serde::{Deserialize, Serialize};

use crate::config::{Servidor, TipoDeAgenda};
use crate::rede::Andamento;

/// Quantas tentativas uma gravação tem antes de ficar parada em `failed`.
pub const MAX_TENTATIVAS: i64 = 10;
const DIA_MS: i64 = 24 * 60 * 60 * 1_000;

/// O andamento do sync em curso, lido pela UI enquanto a thread de sync escreve.
#[derive(Debug)]
pub struct Medidor {
    i: AtomicU32,
    n: AtomicU32,
    enviados: AtomicU64,
    total: AtomicU64,
    inicio: Mutex<Instant>,
    credencial_recusada: AtomicBool,
}

impl Default for Medidor {
    fn default() -> Self {
        Self {
            i: AtomicU32::new(0),
            n: AtomicU32::new(0),
            enviados: AtomicU64::new(0),
            total: AtomicU64::new(0),
            inicio: Mutex::new(Instant::now()),
            credencial_recusada: AtomicBool::new(false),
        }
    }
}

impl Medidor {
    fn comecar(&self, n: u32) {
        self.i.store(0, Ordering::Release);
        self.n.store(n, Ordering::Release);
        self.credencial_recusada.store(false, Ordering::Release);
    }

    fn proxima(&self, bytes: u64) {
        let i = self.i.fetch_add(1, Ordering::AcqRel) + 1;
        // Uma gravação que entrou na fila durante o sync aumenta o total.
        self.n.fetch_max(i, Ordering::AcqRel);
        self.enviados.store(0, Ordering::Release);
        self.total.store(bytes, Ordering::Release);
        if let Ok(mut inicio) = self.inicio.lock() {
            *inicio = Instant::now();
        }
    }

    fn enviou(&self, bytes: u64) {
        self.enviados.fetch_add(bytes, Ordering::AcqRel);
    }

    /// O servidor respondeu 401 a uma chamada autenticada durante o sync.
    pub fn credencial_recusada(&self) -> bool {
        self.credencial_recusada.load(Ordering::Acquire)
    }

    pub fn andamento(&self) -> Andamento {
        let enviados = self.enviados.load(Ordering::Acquire);
        let total = self.total.load(Ordering::Acquire);
        let segundos = self
            .inicio
            .lock()
            .map_or(0.0, |inicio| inicio.elapsed().as_secs_f64());
        Andamento {
            i: self.i.load(Ordering::Acquire),
            n: self.n.load(Ordering::Acquire),
            pct: (enviados.min(total) * 100)
                .checked_div(total)
                .map_or(0, |pct| u8::try_from(pct).unwrap_or(100)),
            bytes_s: if segundos > 0.5 {
                (enviados as f64 / segundos) as u64
            } else {
                0
            },
        }
    }
}

/// Um transporte que conta os bytes das partes enviadas (`PUT` com sucesso) e nota o 401 na
/// origem da API.
pub struct Contador {
    inner: Arc<dyn Transport>,
    medidor: Arc<Medidor>,
    origem: String,
}

impl Contador {
    pub fn new(inner: Arc<dyn Transport>, medidor: Arc<Medidor>, servidor: &Servidor) -> Self {
        Self {
            inner,
            medidor,
            origem: servidor.url.trim_end_matches('/').to_string(),
        }
    }
}

impl Transport for Contador {
    fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        let parte = (request.method == "PUT").then_some(request.body.len() as u64);
        let da_api = request.url.starts_with(&self.origem);
        let resposta = self.inner.send(request)?;
        if da_api && resposta.status == 401 {
            self.medidor
                .credencial_recusada
                .store(true, Ordering::Release);
        }
        if let (Some(bytes), true) = (parte, resposta.is_success()) {
            self.medidor.enviou(bytes);
        }
        Ok(resposta)
    }
}

/// Avisa o medidor a cada gravação que começa a subir.
struct ComAndamento<'a> {
    inner: &'a dyn Uploader,
    medidor: &'a Medidor,
}

impl Uploader for ComAndamento<'_> {
    fn upload(&self, recording: &QueuedRecording) -> Result<String> {
        self.medidor.proxima(
            recording
                .bytes
                .and_then(|b| u64::try_from(b).ok())
                .unwrap_or(0),
        );
        self.inner.upload(recording)
    }
}

/// O uploader real do celular: o cliente sobre o transporte fixado com o [`Contador`].
pub fn uploader(
    transporte: Arc<dyn Transport>,
    medidor: Arc<Medidor>,
    servidor: &Servidor,
    token: &str,
    fila: Arc<Mutex<Queue>>,
    client_version: &str,
    device_name: &str,
) -> Result<HttpUploader> {
    let contador = Arc::new(Contador::new(transporte, medidor, servidor));
    let client = Client::new(contador, &servidor.url, token, RetryPolicy::default())?;
    Ok(HttpUploader::from_client(client, fila, client_version).with_device_name(device_name))
}

/// Uma passada de sync: devolve à fila as falhas cujo prazo venceu e sobe as pendentes, uma a
/// uma, com o andamento no medidor.
pub fn sincronizar(
    fila: &Mutex<Queue>,
    uploader: &dyn Uploader,
    medidor: &Medidor,
) -> Result<SyncReport> {
    let n = {
        let fila = trancar(fila)?;
        fila.retry_due(now_ms(), MAX_TENTATIVAS)?;
        fila.counts()?.pending
    };
    medidor.comecar(n);
    sync_pending(
        fila,
        &ComAndamento {
            inner: uploader,
            medidor,
        },
    )
}

/// A retenção: apaga do celular os arquivos confirmados pelo servidor há mais de `dias`. Devolve
/// quantos saíram.
pub fn reter(fila: &Mutex<Queue>, agora_ms: i64, dias: u32) -> Result<usize> {
    apagar_sincronizadas(fila, agora_ms - i64::from(dias) * DIA_MS).map(|(n, _)| n)
}

/// "Excluir sincronizadas": apaga já todos os arquivos que o servidor confirmou. Devolve quantos
/// e quantos bytes saíram.
pub fn excluir_sincronizadas(fila: &Mutex<Queue>) -> Result<(usize, u64)> {
    apagar_sincronizadas(fila, i64::MAX)
}

/// Quantos bytes as gravações já sincronizadas ocupam no celular.
pub fn bytes_sincronizados(fila: &Mutex<Queue>) -> Result<u64> {
    Ok(trancar(fila)?
        .purge_candidates(i64::MAX)?
        .iter()
        .filter_map(|rec| rec.bytes.and_then(|b| u64::try_from(b).ok()))
        .sum())
}

fn apagar_sincronizadas(fila: &Mutex<Queue>, ate: i64) -> Result<(usize, u64)> {
    let fila = trancar(fila)?;
    let mut apagadas = 0;
    let mut bytes = 0;
    for rec in fila.purge_candidates(ate)? {
        apagar_arquivo(&rec.path)?;
        fila.mark_purged(&rec.id, now_ms())?;
        apagadas += 1;
        bytes += rec.bytes.and_then(|b| u64::try_from(b).ok()).unwrap_or(0);
    }
    Ok((apagadas, bytes))
}

/// Apaga um arquivo local; um arquivo que já não existe não é erro.
pub fn apagar_arquivo(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err).with_context(|| format!("falha ao apagar {}", path.display())),
    }
}

fn trancar(fila: &Mutex<Queue>) -> Result<std::sync::MutexGuard<'_, Queue>> {
    fila.lock()
        .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
}

/// Uma leitura autenticada da API (`GET /api/v1<caminho>`).
fn get_json<T: serde::de::DeserializeOwned>(
    transporte: &dyn Transport,
    servidor: &Servidor,
    token: &str,
    caminho: &str,
    o_que: &str,
) -> Result<T> {
    let url = format!("{}/api/v1{caminho}", servidor.url.trim_end_matches('/'));
    let resposta = transporte
        .send(HttpRequest::new("GET", url).header("Authorization", format!("Bearer {token}")))?;
    if !resposta.is_success() {
        return Err(api_error(o_que, &resposta));
    }
    serde_json::from_slice(&resposta.body).with_context(|| format!("{o_que}: resposta inválida"))
}

#[derive(Deserialize)]
struct PaginaDeTipos {
    items: Vec<TipoDaApi>,
}

#[derive(Deserialize)]
struct TipoDaApi {
    id: String,
    name: String,
}

/// Os tipos de agenda do usuário, para o cache da folha "Gravação salva".
pub fn buscar_tipos_de_agenda(
    transporte: &dyn Transport,
    servidor: &Servidor,
    token: &str,
) -> Result<Vec<TipoDeAgenda>> {
    let pagina: PaginaDeTipos = get_json(
        transporte,
        servidor,
        token,
        "/agenda-types?limit=100",
        "falha ao ler os tipos de agenda",
    )?;
    Ok(pagina
        .items
        .into_iter()
        .map(|t| TipoDeAgenda {
            id: t.id,
            nome: t.name,
        })
        .collect())
}

/// Uma etapa do processamento no servidor (`PipelineStep`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Etapa {
    pub step: String,
    pub state: String,
}

#[derive(Deserialize)]
struct GravacaoDaApi {
    #[serde(default)]
    pipeline: Vec<Etapa>,
}

/// As etapas da gravação no servidor (`GET /recordings/{id}`).
pub fn buscar_etapas(
    transporte: &dyn Transport,
    servidor: &Servidor,
    token: &str,
    remote_id: &str,
) -> Result<Vec<Etapa>> {
    let gravacao: GravacaoDaApi = get_json(
        transporte,
        servidor,
        token,
        &format!("/recordings/{remote_id}"),
        "falha ao ler a gravação no servidor",
    )?;
    Ok(gravacao.pipeline)
}
