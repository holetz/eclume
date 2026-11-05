//! Contract v1 resumable upload: `POST /uploads` with `sha256` (200 `deduplicated` ends without
//! transferring anything) → `PUT` each part to the received URL → `POST /uploads/{id}/complete`.
//! Resuming means `GET /uploads/{id}`, skipping `parts_received` and requesting `part-urls` for the
//! rest.
//!
//! Each request retries with backoff for network failures, 408, 429 and 5xx; other errors (401,
//! 403, 422...) fail immediately with the problem message.

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

/// Prefix of every eclume PAT.
pub const PAT_PREFIX: &str = "eclp_";
/// The contract limits URL requests to 1000 parts.
const MAX_PART_URLS: usize = 1000;
/// Cap for a `Retry-After` sent by the server.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Retries per request.
#[derive(Clone)]
pub struct RetryPolicy {
    /// Attempts beyond the first.
    pub retries: u32,
    /// Wait before the first retry; doubles each time.
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

/// The result of an upload confirmed by the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Uploaded {
    pub recording_id: String,
    /// The server already had a recording with this hash.
    pub deduplicated: bool,
}

/// Statuses for which retrying the same request is worthwhile.
pub fn is_transient(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

/// The readable error of an unsuccessful response, with the problem's `code` and text.
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
    if response.status == 409 && code == " (upload_expired)" {
        return anyhow::Error::new(UploadExpired(message));
    }
    anyhow!(message)
}

/// The server expired the upload (409 `upload_expired`): the multipart disappeared from the bucket.
/// The uploader starts over with a new upload, once.
#[derive(Debug)]
pub struct UploadExpired(String);

impl std::fmt::Display for UploadExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UploadExpired {}

/// The server refused because the token lacks the operation's scope (403 `insufficient_scope`): a
/// server before contract 2.8.0, or a token not yet reached by migration. Callers distinguish this
/// error (`downcast_ref`) from other failures to degrade instead of giving up.
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

/// An eclume API client, with the account or device credential.
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

    /// A URL at the API's origin: carries the PAT. A presigned storage URL (another origin) must
    /// not carry it, because S3 rejects two authentication mechanisms.
    fn same_origin(&self, url: &str) -> bool {
        Url::parse(url).is_ok_and(|url| url.origin() == self.base.origin())
    }

    /// Sends with retries and backoff; returns the last response, successful or otherwise.
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse> {
        let mut attempt = 0;
        loop {
            let result = self.transport.send(request.clone());
            let retry_after = match &result {
                Ok(response) if !is_transient(response.status) => return result,
                // The interruption is intentional (the eclume network went down): do not retry.
                Err(err) if eclume_recorder::is_interrupted(err) => return result,
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
                    "{} {} returned {}; retrying in {delay:?}",
                    request.method,
                    crate::transport::redact(&request.url),
                    response.status
                ),
                Err(err) => log::warn!("{err:#}; retrying in {delay:?}"),
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

    /// Checks the PAT and address: `GET /api/v1/me`.
    pub fn check(&self) -> Result<()> {
        let request = self.authorize(HttpRequest::new("GET", self.endpoint("/me")));
        let response = self.send(&request)?;
        if response.is_success() {
            Ok(())
        } else {
            Err(api_error("falha ao conferir o PAT", &response))
        }
    }

    /// Who owns the token: `GET /api/v1/me` (the account e-mail after pairing).
    pub fn me(&self) -> Result<api::Me> {
        let request = HttpRequest::new("GET", self.endpoint("/me"));
        self.call_json("falha ao ler a conta", request)
    }

    /// The account's transcript language and server default: `GET /api/v1/me/transcription`
    /// (`recordings:read`, contract 2.20.0), so the Audio tab can name the account default.
    pub fn transcription_preference(&self) -> Result<api::TranscriptionPreference> {
        let request = HttpRequest::new("GET", self.endpoint("/me/transcription"));
        self.call_json("falha ao ler o idioma da conta", request)
    }

    /// Builds the real client (TLS from the config's `trust`, version in `User-Agent`) from the
    /// uploader config: the client uploading recordings also reads their summaries.
    pub fn from_config(config: &crate::uploader::UploaderConfig) -> Result<Self> {
        let transport = crate::transport::UreqTransport::with_trust(
            &config.trust,
            &config.client_version,
            crate::transport::REQUEST_TIMEOUT,
        )?;
        Self::new(
            Arc::new(transport),
            &config.api_url,
            &config.pat,
            RetryPolicy::default(),
        )
    }

    /// An uploaded recording's queue wait (`GET /recordings/{id}`, `job.queue` since contract
    /// 2.16.0): position changes without moving `updated_at`, so it does not come from `?since=`.
    /// `None` outside the queue, for a deleted recording or on a server before 2.16.0.
    pub fn queue_wait(&self, recording_id: &str) -> Result<Option<QueueWait>> {
        let url = self.endpoint(&format!("/recordings/{recording_id}"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        let recording: RecordingJobOnly = match response.status {
            404 => return Ok(None),
            _ if response.is_success() => parse("falha ao ler a gravação", &response)?,
            _ => return Err(api_error("falha ao ler a gravação", &response)),
        };
        Ok(recording.job.and_then(|job| job.queue))
    }

    /// A recording by id (`GET /recordings/{id}`), with `job` and `pipeline`, in listing form.
    /// `None` for a deleted recording (404). Rereads a synced folder's pending recording without
    /// listing the whole library.
    pub fn recording(&self, recording_id: &str) -> Result<Option<api::LibraryRecording>> {
        let url = self.endpoint(&format!("/recordings/{recording_id}"));
        let response = self.send(&self.authorize(HttpRequest::new("GET", url)))?;
        match response.status {
            404 => Ok(None),
            _ if response.is_success() => Ok(Some(parse("falha ao ler a gravação", &response)?)),
            _ => Err(api_error("falha ao ler a gravação", &response)),
        }
    }

    /// Traverses cursor listing pages (`limit` 200) and collects the items.
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

    /// The user's collections: `GET /api/v1/collections` (`recordings:read`).
    pub fn collections(&self) -> Result<Vec<api::CollectionInfo>> {
        self.paged(
            "falha ao listar as coleções",
            "/collections",
            &[],
            |page: api::CollectionPage| (page.items, page.next_cursor),
        )
    }

    /// Library recordings: `GET /api/v1/recordings`, only those with `updated_at >= since` when
    /// provided (the server also moves `updated_at` when a summary changes, contract 2.8.0, and
    /// when the summary step fails or is skipped, 2.17.0). Used by the mirror and outcome
    /// notifications ([`crate::outcome`]).
    pub fn library(&self, since: Option<&str>) -> Result<Vec<api::LibraryRecording>> {
        let query: Vec<(&str, &str)> = since.map(|value| ("since", value)).into_iter().collect();
        self.paged(
            "falha ao listar as gravações",
            "/recordings",
            &query,
            |page: api::LibraryPage| (page.items, page.next_cursor),
        )
    }

    /// The account's `limit` most recent recordings, in one page (`GET /api/v1/recordings` with
    /// `sort=created_desc`): the window's recent recordings panel, with each recording's `job` and
    /// `pipeline`. `limit` ranges from 1 to 200, as the contract allows.
    pub fn recent(&self, limit: u32) -> Result<Vec<api::LibraryRecording>> {
        let mut url =
            Url::parse(&self.endpoint("/recordings")).context("endereço da API inválido")?;
        url.query_pairs_mut()
            .append_pair("limit", &limit.clamp(1, 200).to_string())
            .append_pair("sort", "created_desc");
        let page: api::LibraryPage = self.call_json(
            "falha ao listar as gravações recentes",
            HttpRequest::new("GET", url.to_string()),
        )?;
        Ok(page.items)
    }

    /// A recording's current summary for the mirror: `Ok(None)` when none exists yet (404, 409
    /// without a transcript, or no completed version).
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
                            transcript_revision: current.transcript_revision,
                        }
                    })
                }))
            }
            _ => Err(api_error("falha ao ler o resumo", &response)),
        }
    }

    /// The recording's markers (`recordings:read`), in time order; the note is optional.
    pub fn markers(&self, recording_id: &str) -> Result<Vec<api::Marker>> {
        let url = self.endpoint(&format!("/recordings/{recording_id}/markers"));
        let page: api::MarkerPage =
            self.call_json("falha ao ler os marcadores", HttpRequest::new("GET", url))?;
        Ok(page.items)
    }

    /// A recording's transcript: `GET /api/v1/transcripts?recording_id=` (`transcripts:read`,
    /// granted to device credentials since contract 2.8.0). `Ok(None)` without a transcript.
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

    /// Sends a part and returns the ETag. `Ok(None)`: the presigned URL was rejected (expired) and
    /// another should be requested.
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

    /// Uploads the file and returns the confirmed recording. `resume` is the upload saved from an
    /// earlier attempt; `save_upload_id` persists the active upload (or clears it with `None`)
    /// before any part is uploaded, so the next attempt can resume. A 409 `upload_expired` on a
    /// part or `complete` clears the saved upload and starts over, once.
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
                match self.start_upload(create, save_upload_id)? {
                    Ok(upload) => upload,
                    Err(done) => return Ok(done),
                }
            }
        };
        match self.send_parts(path, create.size_bytes, &upload) {
            Err(err) if err.downcast_ref::<UploadExpired>().is_some() => {
                save_upload_id(None)?;
                match self.start_upload(create, save_upload_id)? {
                    Ok(upload) => self.send_parts(path, create.size_bytes, &upload),
                    Err(done) => Ok(done),
                }
            }
            other => other,
        }
    }

    /// Creates a new upload and saves it; `Err` carries the recording already resolved by the
    /// server (dedup).
    fn start_upload(
        &self,
        create: &UploadCreate,
        save_upload_id: &mut dyn FnMut(Option<&str>) -> Result<()>,
    ) -> Result<std::result::Result<Upload, Uploaded>> {
        let request = HttpRequest::new("POST", self.endpoint("/uploads")).json(create)?;
        let upload: Upload = self.call_json("falha ao iniciar o upload", request)?;
        if upload.status != api::status::IN_PROGRESS {
            return finished(upload).map(Err);
        }
        save_upload_id(Some(&upload.id))?;
        Ok(Ok(upload))
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

/// An upload already resolved by the server (deduplicated or completed earlier).
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

/// `Job.queue`: why transcription is waiting. The UI builds the sentence with `fraseDaEspera`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueWait {
    pub reason: String,
    #[serde(default)]
    pub ahead: Option<u32>,
    #[serde(default)]
    pub account_ahead: Option<u32>,
    #[serde(default)]
    pub estimated_start_at: Option<String>,
    #[serde(default)]
    pub resumes_at: Option<String>,
    #[serde(default)]
    pub processor: Option<ProcessorStatus>,
}

/// Whether the transcription processor is up (`ProcessorStatus`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessorStatus {
    pub online: bool,
    #[serde(default)]
    pub offline_since: Option<String>,
}

/// The part of `Recording` read by the queue wait.
#[derive(Clone, Debug, Default, serde::Deserialize)]
struct RecordingJobOnly {
    #[serde(default)]
    job: Option<RecordingJob>,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct RecordingJob {
    #[serde(default)]
    queue: Option<QueueWait>,
}

/// The part of `SummaryState` read by the mirror and the notification's Copy action.
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
    /// Version number (`summaries.version`): changes when the summary is regenerated or edited.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub agenda_type: Option<api::AgendaRef>,
    /// The transcript `revision` the summary was based on (contract 2.25.0); absent on earlier
    /// servers.
    #[serde(default)]
    pub transcript_revision: Option<u64>,
}

/// A recording's current summary for the local mirror.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibrarySummary {
    pub version: u64,
    pub agenda_type: Option<String>,
    pub content_md: String,
    pub transcript_revision: Option<u64>,
}

/// A server address: `http://` or `https://` followed by the host.
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

/// The bytes of part `number` (starting at 1): `part_size` bytes, except for the last part.
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

    /// Scripted transport: checks each request's method and path, in order, and responds.
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
            let (call, response) = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("extra request: {} {}", request.method, request.url));
            let path = request
                .url
                .split_once("://")
                .map_or("", |(_, rest)| rest.find('/').map_or("", |i| &rest[i..]));
            assert_eq!(
                format!("{} {}", request.method, path),
                call,
                "request outside script"
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
    fn new_upload_sends_parts_and_completes() {
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
    fn queue_wait_comes_from_reading_recording() {
        let script = Script::default()
            .expect(
                "GET /api/v1/recordings/r1",
                json(
                    200,
                    serde_json::json!({"id": "r1", "pipeline": [], "job": {"state": "queued", "queue": {
                        "reason": "quota_window", "ahead": null, "account_ahead": null,
                        "estimated_start_at": null, "resumes_at": "2026-10-02T09:00:00Z",
                        "processor": {"online": true, "offline_since": null}
                    }}}),
                ),
            )
            .expect(
                "GET /api/v1/recordings/r2",
                json(
                    200,
                    serde_json::json!({"id": "r2", "job": {"state": "succeeded", "queue": null}}),
                ),
            )
            .expect("GET /api/v1/recordings/r3", status(404));
        let (client, script, _) = make_client(script);
        let wait = client.queue_wait("r1").unwrap().unwrap();
        assert_eq!(wait.reason, "quota_window");
        assert_eq!(wait.resumes_at.as_deref(), Some("2026-10-02T09:00:00Z"));
        assert_eq!(wait.processor.map(|p| p.online), Some(true));
        assert_eq!(client.queue_wait("r2").unwrap(), None);
        assert_eq!(client.queue_wait("r3").unwrap(), None);
        assert!(script.seen().iter().all(|request| request
            .headers
            .contains(&("Authorization".into(), format!("Bearer {PAT}")))));
    }

    #[test]
    fn library_paginates_collections_and_recordings() {
        let recording = |id: &str, collections: &[&str]| {
            serde_json::json!({
                "id": id, "title": format!("Reunião {id}"), "status": "done",
                "recorded_at": "2026-09-18T14:00:05Z", "updated_at": "2026-09-19T10:00:00Z",
                "collection_ids": collections, "transcript_id": format!("t-{id}"),
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
                    serde_json::json!({"items": [recording("r1", &["c1", "c2"]), recording("r2", &[])], "next_cursor": null}),
                ),
            );
        let (client, script, _) = make_client(script);
        let collections = client.collections().unwrap();
        assert_eq!(
            collections
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["Clientes", "Interno"]
        );
        let recordings = client.library(Some("2026-09-18T00:00:00Z")).unwrap();
        assert_eq!(recordings.len(), 2);
        assert_eq!(recordings[0].collection_ids, ["c1", "c2"]);
        assert!(recordings[1].collection_ids.is_empty());
        assert_eq!(recordings[0].summary_state(), Some("done"));
        assert_eq!(
            recordings[0].agenda_type.as_ref().map(|a| a.name.as_str()),
            Some("Reunião de equipe")
        );
        assert!(script.seen().iter().all(|request| request
            .headers
            .contains(&("Authorization".into(), format!("Bearer {PAT}")))));
    }

    #[test]
    fn recent_reads_one_page_in_upload_order() {
        let script = Script::default().expect(
            "GET /api/v1/recordings?limit=5&sort=created_desc",
            json(
                200,
                serde_json::json!({
                    "items": [{
                        "id": "r1", "title": "Reunião", "status": "processing",
                        "job": {"state": "running", "stage": "asr", "progress": 0.5},
                        "pipeline": [{"step": "transcription", "state": "active"}]
                    }],
                    "next_cursor": "p2"
                }),
            ),
        );
        let (client, script, _) = make_client(script);
        let recent = client.recent(5).unwrap();
        assert_eq!(recent.len(), 1);
        let job = recent[0].job.as_ref().unwrap();
        assert_eq!(
            (job.stage.as_deref(), job.progress),
            (Some("asr"), Some(500))
        );
        // The next page cursor is ignored: the panel only wants the first N items.
        assert_eq!(script.seen().len(), 1);
    }

    #[test]
    fn recording_by_id_reads_listing_form_and_404_means_deleted() {
        let script = Script::default()
            .expect(
                "GET /api/v1/recordings/r1",
                json(
                    200,
                    serde_json::json!({
                        "id": "r1", "title": "Reunião", "status": "processing",
                        "updated_at": "2026-09-19T10:00:00Z",
                        "pipeline": [{"step": "transcription", "state": "active"}]
                    }),
                ),
            )
            .expect("GET /api/v1/recordings/r2", status(404));
        let (client, _, _) = make_client(script);
        let found = client.recording("r1").unwrap().unwrap();
        assert_eq!(
            (found.id.as_str(), found.status.as_str()),
            ("r1", "processing")
        );
        assert_eq!(client.recording("r2").unwrap(), None);
    }

    #[test]
    fn current_library_summary_includes_version_and_type() {
        let current = |status: &str, md: Option<&str>| {
            json(
                200,
                serde_json::json!({
                    "current": {"status": status, "content_md": md, "version": 3, "transcript_revision": 4,
                                "agenda_type": {"id": "a1", "name": "1:1"}},
                    "generated": null, "pending": null, "version_count": 3
                }),
            )
        };
        let script = Script::default()
            .expect(
                "GET /api/v1/recordings/r1/summary",
                current("done", Some("# Ata")),
            )
            .expect(
                "GET /api/v1/recordings/r2/summary",
                current("done", Some("  ")),
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
        let ready = client.current_summary("r1").unwrap().unwrap();
        assert_eq!(ready.version, 3);
        assert_eq!(ready.agenda_type.as_deref(), Some("1:1"));
        assert_eq!(ready.content_md, "# Ata");
        assert_eq!(ready.transcript_revision, Some(4));
        assert_eq!(client.current_summary("r2").unwrap(), None);
        assert_eq!(client.current_summary("r3").unwrap(), None);
        assert_eq!(client.current_summary("r4").unwrap(), None);
        assert_eq!(client.current_summary("r5").unwrap(), None);
        assert!(client.current_summary("r6").is_err());
    }

    #[test]
    fn missing_scope_is_distinct_error_and_rest_stays_generic() {
        let problem = |status: u16, code: &str| {
            json(
                status,
                serde_json::json!({"title": "Forbidden", "detail": "Este PAT não tem o escopo transcripts:read.", "code": code}),
            )
        };
        let script = Script::default()
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r1",
                problem(403, "insufficient_scope"),
            )
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r2",
                problem(403, "outro_codigo"),
            );
        let (client, _, _) = make_client(script);
        let missing = client.transcript("r1").unwrap_err();
        assert!(missing.downcast_ref::<MissingScope>().is_some());
        assert!(format!("{missing:#}").contains("insufficient_scope"));
        assert!(format!("{missing:#}").contains("transcripts:read"));
        // Only 403 with this code counts: the rest remain ordinary errors.
        assert!(client
            .transcript("r2")
            .unwrap_err()
            .downcast_ref::<MissingScope>()
            .is_none());
    }

    #[test]
    fn recording_transcript_comes_from_recording_filter() {
        let transcript = serde_json::json!({
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
                    serde_json::json!({"items": [transcript], "next_cursor": null}),
                ),
            )
            .expect(
                "GET /api/v1/transcripts?limit=200&recording_id=r2",
                json(200, serde_json::json!({"items": [], "next_cursor": null})),
            );
        let (client, _, _) = make_client(script);
        let read = client.transcript("r1").unwrap().unwrap();
        assert_eq!(
            (read.revision, read.speakers[0].label.as_str()),
            (2, "Mariana")
        );
        assert_eq!(read.segments[0].text, "Bom dia.");
        assert_eq!(read.segments[0].end_ms, 4200);
        assert!(client.transcript("r2").unwrap().is_none());
    }

    #[test]
    fn deduplicated_confirms_without_transfer() {
        let mut dedup = upload("deduplicated", vec![], &[]);
        dedup["recording_id"] = "rec-9".into();
        dedup["part_count"] = 0.into();
        let script = Script::default().expect("POST /api/v1/uploads", json(200, dedup));
        let (client, script, _) = make_client(script);
        let (path, create) = file();
        let uploaded = client
            .upload(&path, &create, None, &mut |_| panic!("nothing to save"))
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
    fn resume_skips_received_parts_and_requests_missing_urls() {
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
            .upload(&path, &create, Some("up-1"), &mut |_| {
                panic!("must not recreate")
            })
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
    fn resume_missing_or_completed_upload() {
        // Gone (expired and cleaned up): recreate from scratch.
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

        // Already completed (the app crashed after complete): confirm without uploading anything.
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

    fn expired() -> Result<HttpResponse> {
        json(
            409,
            serde_json::json!({"code": "upload_expired", "detail": "O upload expirou; comece outro."}),
        )
    }

    #[test]
    fn upload_expiring_midway_restarts_once() {
        let parts = vec![part(1, BASE), part(2, BASE), part(3, BASE)];
        let script = Script::default()
            .expect(
                "POST /api/v1/uploads",
                json(201, upload("in_progress", parts.clone(), &[])),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/1", expired())
            .expect(
                "POST /api/v1/uploads",
                json(201, upload("in_progress", parts, &[])),
            )
            .expect("PUT /api/v1/uploads/up-1/parts/1", etag("\"e1\""))
            .expect("PUT /api/v1/uploads/up-1/parts/2", etag("\"e2\""))
            .expect("PUT /api/v1/uploads/up-1/parts/3", etag("\"e3\""))
            .expect(
                "POST /api/v1/uploads/up-1/complete",
                json(201, serde_json::json!({"id": "rec-1"})),
            );
        let (client, _, _) = make_client(script);
        let (path, create) = file();
        let mut saved = Vec::new();
        let uploaded = client
            .upload(&path, &create, None, &mut |id| {
                saved.push(id.map(str::to_string));
                Ok(())
            })
            .unwrap();
        assert_eq!(uploaded.recording_id, "rec-1");
        assert_eq!(saved, vec![Some("up-1".into()), None, Some("up-1".into())]);
    }

    #[test]
    fn upload_expiring_again_at_complete_becomes_error() {
        let parts = vec![part(1, BASE), part(2, BASE), part(3, BASE)];
        let mut script = Script::default();
        for _ in 0..2 {
            script = script
                .expect(
                    "POST /api/v1/uploads",
                    json(201, upload("in_progress", parts.clone(), &[])),
                )
                .expect("PUT /api/v1/uploads/up-1/parts/1", etag("\"e1\""))
                .expect("PUT /api/v1/uploads/up-1/parts/2", etag("\"e2\""))
                .expect("PUT /api/v1/uploads/up-1/parts/3", etag("\"e3\""))
                .expect("POST /api/v1/uploads/up-1/complete", expired());
        }
        let (client, _, _) = make_client(script);
        let (path, create) = file();
        let err = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap_err();
        assert!(err.downcast_ref::<UploadExpired>().is_some(), "{err:#}");
    }

    #[test]
    fn interruption_is_not_retried() {
        let script = Script::default().expect(
            "POST /api/v1/uploads",
            Err(anyhow::Error::new(eclume_recorder::SyncInterrupted)),
        );
        let (client, script, slept) = make_client(script);
        let (path, create) = file();
        let err = client
            .upload(&path, &create, None, &mut |_| Ok(()))
            .unwrap_err();
        assert!(eclume_recorder::is_interrupted(&err), "{err:#}");
        assert_eq!(script.seen().len(), 1);
        assert!(slept.lock().unwrap().is_empty());
    }

    #[test]
    fn retries_network_and_5xx_with_backoff_and_retry_after() {
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
    fn gives_up_after_retries() {
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
    fn does_not_retry_401_and_shows_problem() {
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
    fn presigned_url_omits_pat_and_is_renewed_on_expiry() {
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
    fn file_with_changed_size_is_not_uploaded() {
        // Nothing goes to the network: the size is checked first.
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
    fn validates_address_and_pat() {
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
    fn check_validates_pat_at_me() {
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
    fn me_reads_token_account() {
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

    #[test]
    fn account_language_falls_back_to_server_default() {
        let script = Script::default()
            .expect(
                "GET /api/v1/me/transcription",
                json(
                    200,
                    serde_json::json!({"language": null, "platform_default": "pt"}),
                ),
            )
            .expect(
                "GET /api/v1/me/transcription",
                json(
                    200,
                    serde_json::json!({"language": "auto", "platform_default": "pt"}),
                ),
            );
        let (client, _, _) = make_client(script);
        assert_eq!(client.transcription_preference().unwrap().effective(), "pt");
        assert_eq!(
            client.transcription_preference().unwrap().effective(),
            "auto"
        );
    }
}
