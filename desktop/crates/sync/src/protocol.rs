//! O upload resumível do contrato v1: `POST /uploads` com o `sha256` (200 `deduplicated` encerra
//! sem transferir nada) → `PUT` de cada parte na URL recebida → `POST /uploads/{id}/complete`.
//! Retomar é `GET /uploads/{id}`, pular `parts_received` e pedir `part-urls` do que falta.
//!
//! Cada requisição tem retentativa com backoff para falha de rede, 408, 429 e 5xx; o resto dos
//! erros (401, 403, 422...) falha na hora com a mensagem do problem.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use url::Url;

use crate::api::{
    self, CompletedPart, PartUrl, PartUrls, PartUrlsRequest, Problem, Upload, UploadComplete,
    UploadCreate,
};
use crate::transport::{HttpRequest, HttpResponse, Transport};

/// Prefixo de todo PAT do eclume.
pub const PAT_PREFIX: &str = "eclp_";
/// O contrato limita a 1000 partes por pedido de URLs.
const MAX_PART_URLS: usize = 1000;
/// Teto para um `Retry-After` que o servidor mandar.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Retentativas por requisição.
#[derive(Clone)]
pub struct RetryPolicy {
    /// Tentativas além da primeira.
    pub retries: u32,
    /// Espera antes da primeira retentativa; dobra a cada uma.
    pub base_delay: Duration,
    pub sleep: Arc<dyn Fn(Duration) + Send + Sync>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            retries: 3,
            base_delay: Duration::from_secs(1),
            sleep: Arc::new(std::thread::sleep),
        }
    }
}

/// O resultado de um upload confirmado pelo servidor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Uploaded {
    pub recording_id: String,
    /// O servidor já tinha uma gravação com este hash.
    pub deduplicated: bool,
}

/// Status em que vale tentar de novo a mesma requisição.
pub fn is_transient(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

/// O erro legível de uma resposta sem sucesso, com o `code` e o texto do problem.
pub fn api_error(what: &str, response: &HttpResponse) -> anyhow::Error {
    let problem: Problem = serde_json::from_slice(&response.body).unwrap_or_default();
    let code = problem
        .code
        .map(|code| format!(" ({code})"))
        .unwrap_or_default();
    let text = problem
        .detail
        .or(problem.title)
        .map(|text| format!(": {text}"))
        .unwrap_or_default();
    let message = format!(
        "{what}: o servidor respondeu {}{code}{text}",
        response.status
    );
    if response.status == 403 && code == " (insufficient_scope)" {
        return anyhow::Error::new(MissingScope::new(message));
    }
    anyhow!(message)
}

/// O servidor recusou porque o token não tem o escopo da operação (403 `insufficient_scope`): um
/// servidor anterior ao contrato 2.8.0, ou um token que a migração ainda não alcançou. Quem chama
/// distingue este erro (`downcast_ref`) de uma falha qualquer para degradar em vez de desistir.
#[derive(Debug)]
pub struct MissingScope {
    message: String,
}

impl MissingScope {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for MissingScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MissingScope {}

/// Cliente da API do eclume por PAT.
pub struct Client {
    transport: Arc<dyn Transport>,
    base: Url,
    token: String,
    retry: RetryPolicy,
}

impl Client {
    pub fn new(
        transport: Arc<dyn Transport>,
        api_url: &str,
        token: &str,
        retry: RetryPolicy,
    ) -> Result<Self> {
        let base = parse_base(api_url)?;
        let token = token.trim();
        if !token.starts_with(PAT_PREFIX) || token.len() <= PAT_PREFIX.len() {
            bail!("PAT inválido: um PAT do eclume começa com {PAT_PREFIX}");
        }
        Ok(Self {
            transport,
            base,
            token: token.to_string(),
            retry,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.base.as_str().trim_end_matches('/'))
    }

    fn authorize(&self, request: HttpRequest) -> HttpRequest {
        request.header("Authorization", format!("Bearer {}", self.token))
    }

    /// URL na mesma origem da API: leva o PAT. Uma URL pré-assinada do armazenamento (outra
    /// origem) não pode levar, porque o S3 recusa dois mecanismos de autenticação.
    fn same_origin(&self, url: &str) -> bool {
        Url::parse(url).is_ok_and(|url| url.origin() == self.base.origin())
    }

    /// Envia com retentativa e backoff; devolve a última resposta, de sucesso ou não.
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse> {
        let mut attempt = 0;
        loop {
            let result = self.transport.send(request.clone());
            let retry_after = match &result {
                Ok(response) if !is_transient(response.status) => return result,
                Ok(response) => response
                    .header("retry-after")
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .map(|secs| Duration::from_secs(secs).min(MAX_RETRY_AFTER)),
                Err(_) => None,
            };
            if attempt >= self.retry.retries {
                return result;
            }
            let delay = retry_after.unwrap_or(self.retry.base_delay * 2_u32.pow(attempt));
            match &result {
                Ok(response) => log::warn!(
                    "{} {} respondeu {}; nova tentativa em {delay:?}",
                    request.method,
                    request.url,
                    response.status
                ),
                Err(err) => log::warn!("{err:#}; nova tentativa em {delay:?}"),
            }
            (self.retry.sleep)(delay);
            attempt += 1;
        }
    }

    fn call_json<T: DeserializeOwned>(&self, what: &str, request: HttpRequest) -> Result<T> {
        let response = self.send(&self.authorize(request))?;
        if !response.is_success() {
            return Err(api_error(what, &response));
        }
        parse(what, &response)
    }

    /// Confere o PAT e o endereço: `GET /api/v1/me`.
    pub fn check(&self) -> Result<()> {
        let request = self.authorize(HttpRequest::new("GET", self.endpoint("/me")));
        let response = self.send(&request)?;
        if response.is_success() {
            Ok(())
        } else {
            Err(api_error("falha ao conferir o PAT", &response))
        }
    }

    /// Quem é o dono do token: `GET /api/v1/me` (o e-mail da conta depois do pareamento).
    pub fn me(&self) -> Result<api::Me> {
        let request = HttpRequest::new("GET", self.endpoint("/me"));
        self.call_json("falha ao ler a conta", request)
    }

    /// Monta o cliente real (TLS com a CA extra, a versão no `User-Agent`) a partir da config do
    /// uploader: o mesmo que sobe as gravações lê o resumo delas.
    pub fn from_config(config: &crate::uploader::UploaderConfig) -> Result<Self> {
        let transport = crate::transport::UreqTransport::new(
            config.ca_path.as_deref(),
            &config.client_version,
        )?;
        Self::new(
            Arc::new(transport),
            &config.api_url,
            &config.pat,
            RetryPolicy::default(),
        )
    }

    /// O resumo de uma gravação enviada: `GET /api/v1/recordings/{id}/summary`, para o aviso de
    /// resumo pronto (a credencial de dispositivo tem `summaries:read` desde o contrato 2.6.0).
    /// Primeiro a etapa `summary` da gravação (`GET /recordings/{id}`): pulada ou falha, não há o
    /// que avisar; pendente ou em curso, espera sem ler o resumo. Só com ela `done` lê o resumo.
    pub fn summary(&self, recording_id: &str) -> Result<SummaryPoll> {
        let url = self.endpoint(&format!("/recordings/{recording_id}"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        match response.status {
            404 => return Ok(SummaryPoll::Gone),
            _ if response.is_success() => {
                let recording: RecordingPipeline = parse("falha ao ler a gravação", &response)?;
                match recording.summary_step() {
                    Some("failed" | "skipped") => return Ok(SummaryPoll::Gone),
                    Some("done") => {}
                    _ => return Ok(SummaryPoll::Waiting),
                }
            }
            _ => return Err(api_error("falha ao ler a gravação", &response)),
        }
        let url = self.endpoint(&format!("/recordings/{recording_id}/summary"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        match response.status {
            // A gravação saiu do servidor: não há o que avisar.
            404 => Ok(SummaryPoll::Gone),
            // Sem transcrição ainda.
            409 => Ok(SummaryPoll::Waiting),
            _ if response.is_success() => {
                let state: SummaryState = parse("falha ao ler o resumo", &response)?;
                Ok(state.poll())
            }
            _ => Err(api_error("falha ao ler o resumo", &response)),
        }
    }

    /// Percorre as páginas de uma listagem por cursor (`limit` 200) e junta os itens.
    fn paged<P, T>(
        &self,
        what: &str,
        path: &str,
        query: &[(&str, &str)],
        split: impl Fn(P) -> (Vec<T>, Option<String>),
    ) -> Result<Vec<T>>
    where
        P: DeserializeOwned,
    {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut url = Url::parse(&self.endpoint(path)).context("endereço da API inválido")?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs.append_pair("limit", "200");
                for (key, value) in query {
                    pairs.append_pair(key, value);
                }
                if let Some(cursor) = &cursor {
                    pairs.append_pair("cursor", cursor);
                }
            }
            let page: P = self.call_json(what, HttpRequest::new("GET", url.to_string()))?;
            let (mut batch, next) = split(page);
            items.append(&mut batch);
            match next {
                Some(next) if !next.is_empty() => cursor = Some(next),
                _ => return Ok(items),
            }
        }
    }

    /// As Collections do usuário: `GET /api/v1/collections` (`recordings:read`).
    pub fn collections(&self) -> Result<Vec<api::CollectionInfo>> {
        self.paged(
            "falha ao listar as coleções",
            "/collections",
            &[],
            |page: api::CollectionPage| (page.items, page.next_cursor),
        )
    }

    /// As gravações da biblioteca: `GET /api/v1/recordings`, só as com `updated_at >= since`
    /// quando dado (o servidor move `updated_at` também quando um resumo muda, contrato 2.8.0).
    pub fn library(&self, since: Option<&str>) -> Result<Vec<api::LibraryRecording>> {
        let query: Vec<(&str, &str)> = since.map(|value| ("since", value)).into_iter().collect();
        self.paged(
            "falha ao listar as gravações",
            "/recordings",
            &query,
            |page: api::LibraryPage| (page.items, page.next_cursor),
        )
    }

    /// O resumo atual de uma gravação para o espelho: `Ok(None)` quando ainda não há (404, 409
    /// sem transcrição, ou nenhuma versão concluída).
    pub fn current_summary(&self, recording_id: &str) -> Result<Option<LibrarySummary>> {
        let url = self.endpoint(&format!("/recordings/{recording_id}/summary"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        match response.status {
            404 | 409 => Ok(None),
            _ if response.is_success() => {
                let state: SummaryState = parse("falha ao ler o resumo", &response)?;
                Ok(state.current.and_then(|current| {
                    let markdown = current.content_md?;
                    (current.status == "done" && !markdown.trim().is_empty()).then(|| {
                        LibrarySummary {
                            version: current.version,
                            agenda_type: current.agenda_type.map(|agenda| agenda.name),
                            content_md: markdown,
                        }
                    })
                }))
            }
            _ => Err(api_error("falha ao ler o resumo", &response)),
        }
    }

    /// A transcrição de uma gravação: `GET /api/v1/transcripts?recording_id=` (`transcripts:read`,
    /// que a credencial de dispositivo tem desde o contrato 2.8.0). `Ok(None)` sem transcrição.
    pub fn transcript(&self, recording_id: &str) -> Result<Option<api::Transcript>> {
        let transcripts = self.paged(
            "falha ao ler a transcrição",
            "/transcripts",
            &[("recording_id", recording_id)],
            |page: api::TranscriptPage| (page.items, page.next_cursor),
        )?;
        Ok(transcripts.into_iter().next())
    }

    fn get_upload(&self, upload_id: &str) -> Result<Option<Upload>> {
        let url = self.endpoint(&format!("/uploads/{upload_id}"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        match response.status {
            404 | 410 => Ok(None),
            _ if response.is_success() => parse("falha ao ler o upload", &response).map(Some),
            _ => Err(api_error("falha ao ler o upload", &response)),
        }
    }

    fn part_urls(&self, upload_id: &str, numbers: &[u32]) -> Result<Vec<PartUrl>> {
        let mut urls = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(MAX_PART_URLS) {
            let request = HttpRequest::new(
                "POST",
                self.endpoint(&format!("/uploads/{upload_id}/part-urls")),
            )
            .json(&PartUrlsRequest {
                part_numbers: chunk.to_vec(),
            })?;
            let page: PartUrls = self.call_json("falha ao pedir as URLs das partes", request)?;
            urls.extend(page.parts);
        }
        Ok(urls)
    }

    /// Envia uma parte e devolve o ETag. `Ok(None)`: a URL pré-assinada foi recusada (expirou) e
    /// vale pedir outra.
    fn put_part(&self, part: &PartUrl, body: &[u8]) -> Result<Option<String>> {
        let mut request = HttpRequest::new("PUT", part.url.clone()).body(body.to_vec());
        for (name, value) in &part.headers {
            request = request.header(name.clone(), value.clone());
        }
        let same_origin = self.same_origin(&part.url);
        if same_origin {
            request = self.authorize(request);
        }
        let response = self.send(&request)?;
        let what = format!("falha ao enviar a parte {}", part.part_number);
        if response.is_success() {
            let etag = response
                .header("etag")
                .ok_or_else(|| anyhow!("{what}: resposta sem ETag"))?;
            return Ok(Some(etag.to_string()));
        }
        if !same_origin && response.status == 403 {
            return Ok(None);
        }
        Err(api_error(&what, &response))
    }

    /// Sobe o arquivo e devolve a gravação confirmada. `resume` é o upload guardado de uma
    /// tentativa anterior; `save_upload_id` persiste o upload em curso (ou o limpa, com `None`)
    /// antes de qualquer parte subir, para a próxima tentativa retomar.
    pub fn upload(
        &self,
        path: &Path,
        create: &UploadCreate,
        resume: Option<&str>,
        save_upload_id: &mut dyn FnMut(Option<&str>) -> Result<()>,
    ) -> Result<Uploaded> {
        let actual = std::fs::metadata(path)
            .with_context(|| format!("falha ao ler {}", path.display()))?
            .len();
        if actual != create.size_bytes {
            bail!(
                "o arquivo {} mudou de tamanho ({actual} bytes, esperado {})",
                path.display(),
                create.size_bytes
            );
        }
        let previous = match resume {
            Some(upload_id) => self.get_upload(upload_id)?,
            None => None,
        };
        let upload = match previous {
            Some(upload) if upload.status == api::status::IN_PROGRESS => upload,
            Some(upload) if upload.recording_id.is_some() => return finished(upload),
            _ => {
                if resume.is_some() {
                    save_upload_id(None)?;
                }
                let request = HttpRequest::new("POST", self.endpoint("/uploads")).json(create)?;
                let upload: Upload = self.call_json("falha ao iniciar o upload", request)?;
                if upload.status != api::status::IN_PROGRESS {
                    return finished(upload);
                }
                save_upload_id(Some(&upload.id))?;
                upload
            }
        };
        self.send_parts(path, create.size_bytes, &upload)
    }

    fn send_parts(&self, path: &Path, size: u64, upload: &Upload) -> Result<Uploaded> {
        let mut etags: BTreeMap<u32, String> = upload
            .parts_received
            .iter()
            .map(|part| (part.part_number, part.etag.clone()))
            .collect();
        let missing: Vec<u32> = (1..=upload.part_count)
            .filter(|n| !etags.contains_key(n))
            .collect();
        let mut urls: HashMap<u32, PartUrl> = upload
            .parts
            .iter()
            .filter(|part| missing.contains(&part.part_number))
            .map(|part| (part.part_number, part.clone()))
            .collect();
        let lacking: Vec<u32> = missing
            .iter()
            .copied()
            .filter(|n| !urls.contains_key(n))
            .collect();
        if !lacking.is_empty() {
            for part in self.part_urls(&upload.id, &lacking)? {
                urls.insert(part.part_number, part);
            }
        }

        let mut file =
            File::open(path).with_context(|| format!("falha ao abrir {}", path.display()))?;
        for number in missing {
            let body = read_part(&mut file, number, upload.part_size, size)?;
            let part = urls
                .remove(&number)
                .ok_or_else(|| anyhow!("o servidor não deu URL para a parte {number}"))?;
            let etag = match self.put_part(&part, &body)? {
                Some(etag) => etag,
                None => {
                    let fresh = self
                        .part_urls(&upload.id, &[number])?
                        .into_iter()
                        .next()
                        .ok_or_else(|| anyhow!("o servidor não renovou a URL da parte {number}"))?;
                    self.put_part(&fresh, &body)?.ok_or_else(|| {
                        anyhow!("a parte {number} foi recusada mesmo com a URL renovada")
                    })?
                }
            };
            etags.insert(number, etag);
        }

        let complete = UploadComplete {
            parts: etags
                .into_iter()
                .map(|(part_number, etag)| CompletedPart { part_number, etag })
                .collect(),
        };
        let request = HttpRequest::new(
            "POST",
            self.endpoint(&format!("/uploads/{}/complete", upload.id)),
        )
        .json(&complete)?;
        let recording: api::Recording = self.call_json("falha ao concluir o upload", request)?;
        Ok(Uploaded {
            recording_id: recording.id,
            deduplicated: false,
        })
    }
}

/// Um upload que o servidor já resolveu (deduplicado ou concluído antes).
fn finished(upload: Upload) -> Result<Uploaded> {
    let recording_id = upload.recording_id.ok_or_else(|| {
        anyhow!(
            "o upload {} terminou em {} sem gravação",
            upload.id,
            upload.status
        )
    })?;
    Ok(Uploaded {
        recording_id,
        deduplicated: upload.status == api::status::DEDUPLICATED,
    })
}

/// O que o aviso de resumo pronto faz com uma gravação.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SummaryPoll {
    /// O resumo atual ficou pronto: o Markdown dele.
    Ready(String),
    /// Ainda transcrevendo ou resumindo: perguntar de novo depois.
    Waiting,
    /// Não vai haver resumo para avisar (gravação apagada, etapa pulada ou que falhou).
    Gone,
}

/// A parte da `Recording` que o aviso lê: o estado da etapa `summary` do pipeline.
#[derive(Clone, Debug, Default, serde::Deserialize)]
struct RecordingPipeline {
    #[serde(default)]
    pipeline: Vec<PipelineStep>,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct PipelineStep {
    step: String,
    state: String,
}

impl RecordingPipeline {
    fn summary_step(&self) -> Option<&str> {
        self.pipeline
            .iter()
            .find(|step| step.step == "summary")
            .map(|step| step.state.as_str())
    }
}

/// A parte do `SummaryState` que o aviso lê.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct SummaryState {
    #[serde(default)]
    pub current: Option<SummaryVersion>,
    #[serde(default)]
    pub pending: Option<SummaryVersion>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct SummaryVersion {
    pub status: String,
    #[serde(default)]
    pub content_md: Option<String>,
    /// Número da versão (`summaries.version`): muda quando o resumo é refeito ou editado.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub agenda_type: Option<api::AgendaRef>,
}

/// O resumo atual de uma gravação para o espelho local.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibrarySummary {
    pub version: u64,
    pub agenda_type: Option<String>,
    pub content_md: String,
}

impl SummaryState {
    /// Com a etapa `summary` já `done`: pronto com o Markdown da versão atual; sem ela (uma
    /// geração nova em curso), espera.
    pub fn poll(self) -> SummaryPoll {
        match self.current {
            Some(SummaryVersion {
                status,
                content_md: Some(markdown),
                ..
            }) if status == "done" && !markdown.trim().is_empty() => SummaryPoll::Ready(markdown),
            _ => SummaryPoll::Waiting,
        }
    }
}

/// Um endereço de servidor: `http://` ou `https://` seguido do host.
pub fn parse_base(url: &str) -> Result<Url> {
    let base = Url::parse(url.trim()).with_context(|| format!("endereço inválido: {url}"))?;
    if !matches!(base.scheme(), "http" | "https") || base.host().is_none() {
        bail!("endereço inválido: use http:// ou https:// seguido do host");
    }
    Ok(base)
}

pub(crate) fn parse<T: DeserializeOwned>(what: &str, response: &HttpResponse) -> Result<T> {
    serde_json::from_slice(&response.body)
        .with_context(|| format!("{what}: resposta fora do contrato"))
}

/// Os bytes da parte `number` (a partir de 1): `part_size` bytes, menos a última.
fn read_part(file: &mut File, number: u32, part_size: u64, size: u64) -> Result<Vec<u8>> {
    let offset = u64::from(number - 1) * part_size;
    if offset >= size {
        bail!("a parte {number} passa do fim do arquivo");
    }
    let len = usize::try_from(part_size.min(size - offset))?;
    let mut body = vec![0; len];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut body)?;
    Ok(body)
}

#[cfg(test)]
pub(crate) mod script {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use anyhow::Result;

    use crate::transport::{HttpRequest, HttpResponse, Transport};

    /// Transporte roteirizado: confere método e caminho de cada requisição, em ordem, e responde.
    #[derive(Default)]
    pub struct Script {
        steps: Mutex<VecDeque<(String, Result<HttpResponse>)>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl Script {
        pub fn expect(self, call: &str, response: Result<HttpResponse>) -> Self {
            self.steps
                .lock()
                .unwrap()
                .push_back((call.to_string(), response));
            self
        }

        pub fn seen(&self) -> Vec<HttpRequest> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl Transport for Script {
        fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
            let (call, response) =
                self.steps.lock().unwrap().pop_front().unwrap_or_else(|| {
                    panic!("requisição a mais: {} {}", request.method, request.url)
                });
            let path = request
                .url
                .split_once("://")
                .map_or("", |(_, rest)| rest.find('/').map_or("", |i| &rest[i..]));
            assert_eq!(
                format!("{} {}", request.method, path),
                call,
                "requisição fora do roteiro"
            );
            self.seen.lock().unwrap().push(request);
            response
        }
    }

    pub fn json(status: u16, body: serde_json::Value) -> Result<HttpResponse> {
        Ok(HttpResponse {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&body).unwrap(),
        })
    }

    pub fn etag(value: &str) -> Result<HttpResponse> {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("etag".into(), value.into())],
            body: Vec::new(),
        })
    }

    pub fn status(code: u16) -> Result<HttpResponse> {
        json(code, serde_json::json!({}))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::script::{etag, json, status, Script};
    use super::*;
    use crate::api::Capture;
    use eclume_recorder::{Kind, RecordedAtSource, Source};

    const BASE: &str = "https://eclume.test:8443";
    const PAT: &str = "eclp_teste";

    fn part(n: u32, base: &str) -> serde_json::Value {
        serde_json::json!({
            "part_number": n, "method": "PUT",
            "url": format!("{base}/api/v1/uploads/up-1/parts/{n}"),
            "headers": {"Content-Type": "application/octet-stream"},
            "expires_at": "2026-09-24T15:00:00Z"
        })
    }

    fn upload(
        status: &str,
        parts: Vec<serde_json::Value>,
        received: &[(u32, &str)],
    ) -> serde_json::Value {
        serde_json::json!({
            "id": "up-1", "status": status, "filename": "g.ogg", "content_type": "audio/ogg",
            "size_bytes": 12, "sha256": "ab", "part_size": 5, "part_count": 3,
            "parts_received": received.iter().map(|(n, e)| serde_json::json!({
                "part_number": n, "etag": e, "size_bytes": 5
            })).collect::<Vec<_>>(),
            "parts": parts, "recording_id": null,
            "expires_at": "2026-09-25T00:00:00Z", "created_at": "2026-09-24T00:00:00Z",
            "campo_novo": "o cliente ignora"
        })
    }

    fn file() -> (std::path::PathBuf, UploadCreate) {
        let dir = std::env::temp_dir().join(format!("eclume-proto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{:?}.ogg", std::thread::current().id()));
        std::fs::write(&path, b"aaaaabbbbbcc").unwrap();
        let create = UploadCreate {
            filename: "g.ogg".into(),
            content_type: "audio/ogg; codecs=opus".into(),
            size_bytes: 12,
            sha256: "ab".into(),
            title: None,
            recorded_at: None,
            recorded_at_source: RecordedAtSource::Capture,
            kind: Kind::Meeting,
            agenda_type_id: None,
            markers: Vec::new(),
            duration_ms: Some(1_000),
            language: None,
            source: Source::Desktop,
            capture: Capture {
                meeting_app: Some("teams".into()),
                device_name: None,
                client_version: "eclume-desktop/0.1.0".into(),
            },
        };
        (path, create)
    }

    fn make_client(script: Script) -> (Client, Arc<Script>, Arc<Mutex<Vec<Duration>>>) {
        let script = Arc::new(script);
        let slept = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&slept);
        let retry = RetryPolicy {
            sleep: Arc::new(move |d| log.lock().unwrap().push(d)),
            ..RetryPolicy::default()
        };
        let client =
            Client::new(Arc::clone(&script) as Arc<dyn Transport>, BASE, PAT, retry).unwrap();
        (client, script, slept)
    }

    fn body_json(request: &HttpRequest) -> serde_json::Value {
        serde_json::from_slice(&request.body).unwrap()
    }

    #[test]
    fn upload_novo_sobe_as_partes_e_conclui() {
        let script = Script::default()
            .expect(
                "POST /api/v1/uploads",
                json(
                    201,
                    upload(
                        "in_progress",
                        vec![part(1, BASE), part(2, BASE), part(3, BASE)],
                        &[],
                    ),
                ),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/1", etag("\"e1\""))
            .expect("PUT /api/v1/uploads/up-1/parts/2", etag("\"e2\""))
            .expect("PUT /api/v1/uploads/up-1/parts/3", etag("\"e3\""))
            .expect(
                "POST /api/v1/uploads/up-1/complete",
                json(201, serde_json::json!({"id": "rec-1", "status": "queued"})),
            );
        let (client, script, _) = make_client(script);
        let (path, create) = file();
        let mut saved = Vec::new();
        let uploaded = client
            .upload(&path, &create, None, &mut |id| {
                saved.push(id.map(str::to_string));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            uploaded,
            Uploaded {
                recording_id: "rec-1".into(),
                deduplicated: false
            }
        );
        assert_eq!(saved, vec![Some("up-1".to_string())]);

        let seen = script.seen();
        let create_body = body_json(&seen[0]);
        assert_eq!(create_body["sha256"], "ab");
        assert_eq!(create_body["capture"]["meeting_app"], "teams");
        assert_eq!(create_body["source"], "desktop");
        assert_eq!(seen[1].body, b"aaaaa");
        assert_eq!(seen[2].body, b"bbbbb");
        assert_eq!(seen[3].body, b"cc");
        for request in &seen {
            assert!(request
                .headers
                .contains(&("Authorization".into(), format!("Bearer {PAT}"))));
        }
        assert!(seen[1]
            .headers
            .contains(&("Content-Type".into(), "application/octet-stream".into())));
        assert_eq!(
            body_json(&seen[4]),
            serde_json::json!({"parts": [
                {"part_number": 1, "etag": "\"e1\""},
                {"part_number": 2, "etag": "\"e2\""},
                {"part_number": 3, "etag": "\"e3\""}
            ]})
        );
    }

    #[test]
    fn resumo_pronto_espera_ou_desiste() {
        let versao = |status: &str, md: Option<&str>| serde_json::json!({"status": status, "content_md": md, "version": 1});
        let gravacao = |resumo: &str| {
            let etapas: Vec<_> = [
                "received",
                "preprocessing",
                "transcription",
                "fields",
                "agenda_type",
                "summary",
            ]
            .iter()
            .map(|step| {
                let state = if *step == "summary" { resumo } else { "done" };
                serde_json::json!({"step": step, "state": state})
            })
            .collect();
            json(200, serde_json::json!({"id": "r", "pipeline": etapas}))
        };
        let script = Script::default()
            .expect("GET /api/v1/recordings/r1", gravacao("done"))
            .expect(
                "GET /api/v1/recordings/r1/summary",
                json(
                    200,
                    serde_json::json!({
                        "current": versao("done", Some("# Ata\n\n- decisão")),
                        "generated": null, "pending": null, "version_count": 1
                    }),
                ),
            )
            .expect("GET /api/v1/recordings/r2", gravacao("active"))
            .expect("GET /api/v1/recordings/r3", gravacao("failed"))
            .expect("GET /api/v1/recordings/r4", gravacao("skipped"))
            .expect("GET /api/v1/recordings/r5", gravacao("pending"))
            .expect("GET /api/v1/recordings/r6", status(404))
            .expect("GET /api/v1/recordings/r7", gravacao("done"))
            .expect(
                "GET /api/v1/recordings/r7/summary",
                json(
                    200,
                    serde_json::json!({
                        "current": null, "generated": null,
                        "pending": versao("running", None), "version_count": 1
                    }),
                ),
            );
        let (client, script, _) = make_client(script);
        assert_eq!(
            client.summary("r1").unwrap(),
            SummaryPoll::Ready("# Ata\n\n- decisão".into())
        );
        assert_eq!(client.summary("r2").unwrap(), SummaryPoll::Waiting);
        assert_eq!(client.summary("r3").unwrap(), SummaryPoll::Gone);
        // Sem provedor ou sem tipo de pauta, o resumo é pulado: nada a esperar por 24 h.
        assert_eq!(client.summary("r4").unwrap(), SummaryPoll::Gone);
        assert_eq!(client.summary("r5").unwrap(), SummaryPoll::Waiting);
        assert_eq!(client.summary("r6").unwrap(), SummaryPoll::Gone);
        assert_eq!(client.summary("r7").unwrap(), SummaryPoll::Waiting);
        let seen = script.seen();
        // Enquanto a etapa não fica `done`, o resumo nem é pedido.
        assert_eq!(seen.len(), 9);
        assert!(seen.iter().all(|request| request
            .headers
            .contains(&("Authorization".into(), format!("Bearer {PAT}")))));
    }

    #[test]
    fn biblioteca_pagina_colecoes_e_gravacoes() {
        let gravacao = |id: &str, colecoes: &[&str]| {
            serde_json::json!({
                "id": id, "title": format!("Reunião {id}"), "status": "done",
                "recorded_at": "2026-09-18T14:00:05Z", "updated_at": "2026-09-19T10:00:00Z",
                "collection_ids": colecoes, "transcript_id": format!("t-{id}"),
                "agenda_type": {"id": "a1", "name": "Reunião de equipe", "origin": "auto"},
                "pipeline": [{"step": "summary", "state": "done"}]
            })
        };
        let script = Script::default()
            .expect(
                "GET /api/v1/collections?limit=200",
                json(
                    200,
                    serde_json::json!({"items": [{"id": "c1", "name": "Clientes"}], "next_cursor": "p2"}),
                ),
            )
            .expect(
                "GET /api/v1/collections?limit=200&cursor=p2",
                json(
                    200,
                    serde_json::json!({"items": [{"id": "c2", "name": "Interno"}], "next_cursor": null}),
                ),
            )
            .expect(
                "GET /api/v1/recordings?limit=200&since=2026-09-18T00%3A00%3A00Z",
                json(
                    200,
                    serde_json::json!({"items": [gravacao("r1", &["c1", "c2"]), gravacao("r2", &[])], "next_cursor": null}),
                ),
            );
        let (client, script, _) = make_client(script);
        let colecoes = client.collections().unwrap();
        assert_eq!(
            colecoes.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["Clientes", "Interno"]
        );
        let gravacoes = client.library(Some("2026-09-18T00:00:00Z")).unwrap();
        assert_eq!(gravacoes.len(), 2);
        assert_eq!(gravacoes[0].collection_ids, ["c1", "c2"]);
        assert!(gravacoes[1].collection_ids.is_empty());
        assert_eq!(gravacoes[0].summary_state(), Some("done"));
        assert_eq!(
            gravacoes[0].agenda_type.as_ref().map(|a| a.name.as_str()),
            Some("Reunião de equipe")
        );
        assert!(script.seen().iter().all(|request| request
            .headers
            .contains(&("Authorization".into(), format!("Bearer {PAT}")))));
    }

    #[test]
    fn resumo_atual_da_biblioteca_traz_versao_e_tipo() {
        let atual = |status: &str, md: Option<&str>| {
            json(
                200,
                serde_json::json!({
                    "current": {"status": status, "content_md": md, "version": 3,
                                "agenda_type": {"id": "a1", "name": "1:1"}},
                    "generated": null, "pending": null, "version_count": 3
                }),
            )
        };
        let script = Script::default()
            .expect(
                "GET /api/v1/recordings/r1/summary",
                atual("done", Some("# Ata")),
            )
            .expect(
                "GET /api/v1/recordings/r2/summary",
                atual("done", Some("  ")),
            )
            .expect(
                "GET /api/v1/recordings/r3/summary",
                json(
                    200,
                    serde_json::json!({"current": null, "pending": null, "version_count": 0}),
                ),
            )
            .expect("GET /api/v1/recordings/r4/summary", status(409))
            .expect("GET /api/v1/recordings/r5/summary", status(404))
            .expect("GET /api/v1/recordings/r6/summary", status(403));
        let (client, _, _) = make_client(script);
        let pronto = client.current_summary("r1").unwrap().unwrap();
        assert_eq!(pronto.version, 3);
        assert_eq!(pronto.agenda_type.as_deref(), Some("1:1"));
        assert_eq!(pronto.content_md, "# Ata");
        assert_eq!(client.current_summary("r2").unwrap(), None);
        assert_eq!(client.current_summary("r3").unwrap(), None);
        assert_eq!(client.current_summary("r4").unwrap(), None);
        assert_eq!(client.current_summary("r5").unwrap(), None);
        assert!(client.current_summary("r6").is_err());
    }

    #[test]
    fn falta_de_escopo_e_um_erro_distinguivel_e_o_resto_segue_generico() {
        let problema = |status: u16, code: &str| {
            json(
                status,
                serde_json::json!({"title": "Forbidden", "detail": "Este PAT não tem o escopo transcripts:read.", "code": code}),
            )
        };
        let script = Script::default()
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r1",
                problema(403, "insufficient_scope"),
            )
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r2",
                problema(403, "outro_codigo"),
            );
        let (client, _, _) = make_client(script);
        let falta = client.transcript("r1").unwrap_err();
        assert!(falta.downcast_ref::<MissingScope>().is_some());
        assert!(format!("{falta:#}").contains("insufficient_scope"));
        assert!(format!("{falta:#}").contains("transcripts:read"));
        // Só 403 com esse código conta: o resto segue erro comum.
        assert!(client
            .transcript("r2")
            .unwrap_err()
            .downcast_ref::<MissingScope>()
            .is_none());
    }

    #[test]
    fn transcricao_da_gravacao_vem_do_filtro_por_gravacao() {
        let transcricao = serde_json::json!({
            "id": "t1", "recording_id": "r1", "title": "Alinhamento", "language": "pt",
            "recorded_at": "2026-09-18T14:00:05Z", "duration_ms": 61000, "revision": 2,
            "speakers": [{"id": "S1", "label": "Mariana"}],
            "segments": [{"id": "g1", "speaker_id": "S1", "start_ms": 0, "end_ms": 4200, "text": "Bom dia."}]
        });
        let script = Script::default()
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r1",
                json(
                    200,
                    serde_json::json!({"items": [transcricao], "next_cursor": null}),
                ),
            )
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r2",
                json(200, serde_json::json!({"items": [], "next_cursor": null})),
            );
        let (client, _, _) = make_client(script);
        let lida = client.transcript("r1").unwrap().unwrap();
        assert_eq!(
            (lida.revision, lida.speakers[0].label.as_str()),
            (2, "Mariana")
        );
        assert_eq!(lida.segments[0].text, "Bom dia.");
        assert_eq!(lida.segments[0].end_ms, 4200);
        assert!(client.transcript("r2").unwrap().is_none());
    }

    #[test]
    fn deduplicado_confirma_sem_transferir() {
        let mut dedup = upload("deduplicated", vec![], &[]);
        dedup["recording_id"] = "rec-9".into();
        dedup["part_count"] = 0.into();
        let script = Script::default().expect("POST /api/v1/uploads", json(200, dedup));
        let (client, script, _) = make_client(script);
        let (path, create) = file();
        let uploaded = client
            .upload(&path, &create, None, &mut |_| panic!("nada a guardar"))
            .unwrap();
        assert_eq!(
            uploaded,
            Uploaded {
                recording_id: "rec-9".into(),
                deduplicated: true
            }
        );
        assert_eq!(script.seen().len(), 1);
    }

    #[test]
    fn retomada_pula_as_partes_recebidas_e_pede_urls_das_que_faltam() {
        let script = Script::default()
            .expect(
                "GET /api/v1/uploads/up-1",
                json(
                    200,
                    upload("in_progress", vec![], &[(1, "\"e1\""), (3, "\"e3\"")]),
                ),
            )
            .expect(
                "POST /api/v1/uploads/up-1/part-urls",
                json(200, serde_json::json!({"parts": [part(2, BASE)]})),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/2", etag("\"e2\""))
            .expect(
                "POST /api/v1/uploads/up-1/complete",
                json(201, serde_json::json!({"id": "rec-1"})),
            );
        let (client, script, _) = make_client(script);
        let (path, create) = file();
        let uploaded = client
            .upload(&path, &create, Some("up-1"), &mut |_| panic!("não recria"))
            .unwrap();
        assert_eq!(uploaded.recording_id, "rec-1");
        let seen = script.seen();
        assert_eq!(
            body_json(&seen[1]),
            serde_json::json!({"part_numbers": [2]})
        );
        assert_eq!(seen[2].body, b"bbbbb");
        assert_eq!(body_json(&seen[3])["parts"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn retomada_de_upload_sumido_ou_concluido() {
        // Sumiu (expirou e foi limpo): recria do zero.
        let mut dedup = upload("deduplicated", vec![], &[]);
        dedup["recording_id"] = "rec-2".into();
        let script = Script::default()
            .expect("GET /api/v1/uploads/up-1", status(404))
            .expect("POST /api/v1/uploads", json(200, dedup));
        let (client, _, _) = make_client(script);
        let (path, create) = file();
        let mut saved = Vec::new();
        let uploaded = client
            .upload(&path, &create, Some("up-1"), &mut |id| {
                saved.push(id.map(str::to_string));
                Ok(())
            })
            .unwrap();
        assert_eq!(uploaded.recording_id, "rec-2");
        assert_eq!(saved, vec![None]);

        // Já concluído (o app caiu depois do complete): confirma sem subir nada.
        let mut done = upload("completed", vec![], &[]);
        done["recording_id"] = "rec-3".into();
        let script = Script::default().expect("GET /api/v1/uploads/up-1", json(200, done));
        let (client, _, _) = make_client(script);
        let uploaded = client
            .upload(&path, &create, Some("up-1"), &mut |_| Ok(()))
            .unwrap();
        assert_eq!(
            uploaded,
            Uploaded {
                recording_id: "rec-3".into(),
                deduplicated: false
            }
        );
    }

    #[test]
    fn retenta_rede_e_5xx_com_backoff_e_retry_after() {
        let mut dedup = upload("deduplicated", vec![], &[]);
        dedup["recording_id"] = "rec-4".into();
        let script = Script::default()
            .expect("POST /api/v1/uploads", Err(anyhow!("conexão recusada")))
            .expect("POST /api/v1/uploads", status(503))
            .expect(
                "POST /api/v1/uploads",
                Ok(HttpResponse {
                    status: 429,
                    headers: vec![("retry-after".into(), "7".into())],
                    body: Vec::new(),
                }),
            )
            .expect("POST /api/v1/uploads", json(200, dedup));
        let (client, _, slept) = make_client(script);
        let (path, create) = file();
        let uploaded = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(uploaded.recording_id, "rec-4");
        assert_eq!(
            *slept.lock().unwrap(),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(7)
            ]
        );
    }

    #[test]
    fn desiste_depois_das_retentativas() {
        let script = Script::default()
            .expect("POST /api/v1/uploads", status(502))
            .expect("POST /api/v1/uploads", status(502))
            .expect("POST /api/v1/uploads", status(502))
            .expect("POST /api/v1/uploads", status(502));
        let (client, _, slept) = make_client(script);
        let (path, create) = file();
        let err = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap_err();
        assert!(format!("{err:#}").contains("502"), "{err:#}");
        assert_eq!(slept.lock().unwrap().len(), 3);
    }

    #[test]
    fn nao_retenta_401_e_mostra_o_problem() {
        let script = Script::default().expect(
            "POST /api/v1/uploads",
            json(401, serde_json::json!({"title": "Não autenticado", "detail": "PAT revogado.", "code": "unauthorized"})),
        );
        let (client, _, slept) = make_client(script);
        let (path, create) = file();
        let err = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "falha ao iniciar o upload: o servidor respondeu 401 (unauthorized): PAT revogado."
        );
        assert!(slept.lock().unwrap().is_empty());
    }

    #[test]
    fn url_pre_assinada_vai_sem_pat_e_e_renovada_quando_expira() {
        let storage = "https://minio.test:9000";
        let script = Script::default()
            .expect(
                "POST /api/v1/uploads",
                json(
                    201,
                    upload(
                        "in_progress",
                        vec![part(1, storage), part(2, storage), part(3, storage)],
                        &[],
                    ),
                ),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/1", etag("\"e1\""))
            .expect("PUT /api/v1/uploads/up-1/parts/2", status(403))
            .expect(
                "POST /api/v1/uploads/up-1/part-urls",
                json(200, serde_json::json!({"parts": [part(2, storage)]})),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/2", etag("\"e2\""))
            .expect("PUT /api/v1/uploads/up-1/parts/3", etag("\"e3\""))
            .expect(
                "POST /api/v1/uploads/up-1/complete",
                json(201, serde_json::json!({"id": "rec-5"})),
            );
        let (client, script, _) = make_client(script);
        let (path, create) = file();
        let uploaded = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(uploaded.recording_id, "rec-5");
        for put in script.seen().iter().filter(|r| r.method == "PUT") {
            assert!(put.headers.iter().all(|(name, _)| name != "Authorization"));
        }
    }

    #[test]
    fn arquivo_que_mudou_de_tamanho_nao_sobe() {
        // Nada vai à rede: o tamanho é conferido antes.
        let script = Script::default();
        let (client, _, _) = make_client(script);
        let (path, mut create) = file();
        create.size_bytes = 99;
        let err = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap_err();
        assert!(format!("{err:#}").contains("mudou de tamanho"), "{err:#}");
    }

    #[test]
    fn valida_endereco_e_pat() {
        let transport: Arc<dyn Transport> = Arc::new(Script::default());
        assert!(Client::new(
            Arc::clone(&transport),
            "ftp://x",
            PAT,
            RetryPolicy::default()
        )
        .is_err());
        assert!(Client::new(
            Arc::clone(&transport),
            "https://x",
            "ghp_abc",
            RetryPolicy::default()
        )
        .is_err());
        assert!(Client::new(
            Arc::clone(&transport),
            "https://x",
            "eclp_",
            RetryPolicy::default()
        )
        .is_err());
        let client = Client::new(
            transport,
            "https://x:8443/",
            " eclp_abc \n",
            RetryPolicy::default(),
        )
        .unwrap();
        assert_eq!(client.endpoint("/me"), "https://x:8443/api/v1/me");
        assert!(client.same_origin("https://x:8443/api/v1/uploads/1/parts/1"));
        assert!(!client.same_origin("https://x:9000/bucket/obj"));
    }

    #[test]
    fn check_confere_o_pat_em_me() {
        let script = Script::default()
            .expect("GET /api/v1/me", json(200, serde_json::json!({"id": "u"})))
            .expect(
                "GET /api/v1/me",
                json(403, serde_json::json!({"code": "insufficient_scope"})),
            );
        let (client, _, _) = make_client(script);
        client.check().unwrap();
        let err = client.check().unwrap_err();
        assert!(format!("{err:#}").contains("insufficient_scope"), "{err:#}");
    }

    #[test]
    fn me_le_a_conta_do_token() {
        let script = Script::default().expect(
            "GET /api/v1/me",
            json(
                200,
                serde_json::json!({
                    "user": {"id": "u", "email": "ana@exemplo.com.br", "name": "Ana"},
                    "auth": {"method": "pat", "scopes": [], "token_id": "t-1"},
                    "notice_required": false
                }),
            ),
        );
        let (client, script, _) = make_client(script);
        let me = client.me().unwrap();
        assert_eq!(me.user.email, "ana@exemplo.com.br");
        assert_eq!(me.auth.token_id.as_deref(), Some("t-1"));
        assert!(script.seen()[0]
            .headers
            .contains(&("Authorization".into(), format!("Bearer {PAT}"))));
    }
}
