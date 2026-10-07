//! O painel de gravações recentes do topo da janela: as últimas N gravações da conta, com a fase
//! do processamento, o progresso e o alerta quando a pessoa precisa agir.
//!
//! A fonte é dupla. As linhas da fila local que ainda não chegaram ao servidor (gravando,
//! aguardando envio, enviando, falhou o envio) vêm primeiro; depois, a página das N mais
//! recentes da conta (`GET /recordings?limit=N&sort=created_desc`), que a thread
//! `eclume-recentes` lê a cada 5 s com a janela visível e algo em andamento. Fora disso, a cada
//! 60 s, só o que mudou desde a última leitura (`?since=`, repartido com o aviso de desfechos e a
//! pasta sincronizada, ver [`crate::sync::library_since`]) é mesclado na página; a página inteira
//! volta a cada 10 min, ao cutucar o laço (envio concluído, configurações, janela aberta) e quando
//! a contagem muda. Uma leitura que falha dobra a espera até 60 s. Uma gravação enviada daqui e
//! presente na página é uma linha só, a do servidor.
//!
//! O Rust entrega códigos (fase, etapa, motivo); os rótulos são os do vocabulário compartilhado
//! (`ui/js/vocabulario.js`), aplicados pela janela.

use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use eclume_recorder::{now_ms, QueuedRecording, Status};
use eclume_sync::api::{self, LibraryRecording};
use eclume_sync::{Client, QueueWait};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// Com a janela visível e alguma linha em andamento: o progresso anda na tela.
pub const BUSY_INTERVAL: Duration = Duration::from_secs(5);
/// Fora disso, uma leitura por minuto basta para o painel estar em dia ao abrir.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(60);
/// O teto da espera depois de leituras que falham: dobra a partir do ritmo normal até aqui.
pub const ERROR_MAX_INTERVAL: Duration = Duration::from_secs(60);
/// De quanto em quanto a página inteira é relida no ritmo lento (pega o que o `?since=` não vê,
/// como a gravação apagada).
pub const FULL_READ_EVERY_MS: i64 = 10 * 60 * 1000;
/// Folga do `?since=` sobre o maior `updated_at` da página, como na pasta sincronizada.
const SINCE_MARGIN_SECS: i64 = 120;

/// Os estados da gravação que o contrato 2.20.0 conhece (`RecordingStatus`).
const KNOWN_STATUS: [&str; 5] = ["uploading", "queued", "processing", "transcribed", "failed"];
/// Os estados de etapa que o contrato 2.20.0 conhece (`PipelineStep.state`).
const KNOWN_STEP_STATES: [&str; 5] = ["pending", "active", "done", "failed", "skipped"];
/// O motivo de resumo pulado que a própria pessoa resolve no web (escolher o tipo de agenda).
const ACTIONABLE_NO_SUMMARY: [&str; 1] = ["no_agenda_type"];

/// Onde a gravação está.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// No aparelho: gravando.
    Recording,
    /// No aparelho: aguardando envio.
    Pending,
    /// No aparelho: enviando.
    Uploading,
    /// No aparelho: o envio falhou.
    UploadFailed,
    /// Enviada daqui, sem notícia do servidor (sem leitura ainda, ou fora da página).
    Uploaded,
    /// Na fila do servidor.
    Queued,
    /// Transcrevendo, com a etapa do job e o progresso.
    Transcribing,
    /// Numa etapa do pipeline depois da transcrição (tipo de agenda, campos, resumo).
    Processing,
    /// O resumo está pronto: a linha oferece Copiar resumo.
    SummaryReady,
    /// Transcrita, sem etapa de resumo.
    Transcribed,
    /// Pronta sem resumo (a etapa foi pulada, com o motivo).
    NoSummary,
    SummaryFailed,
    TranscriptionFailed,
    /// A transcrição foi cancelada pelo dono.
    Cancelled,
    /// Um estado que este app não conhece: o servidor é mais novo.
    Unknown,
}

impl Phase {
    /// Em andamento: o laço lê mais vezes enquanto há uma linha assim.
    pub fn in_progress(self) -> bool {
        matches!(
            self,
            Self::Recording
                | Self::Pending
                | Self::Uploading
                | Self::Uploaded
                | Self::Queued
                | Self::Transcribing
                | Self::Processing
        )
    }
}

/// Por que a pessoa precisa agir.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    /// O envio falhou: "Tentar agora" (`sync_now`).
    UploadFailed,
    /// A transcrição falhou sem retentativa automática: "Abrir no web".
    TranscriptionFailed,
    /// O resumo falhou: "Abrir no web" para gerar de novo.
    SummaryFailed,
    /// Pronta sem resumo por um motivo que a pessoa resolve (o tipo de agenda): "Abrir no web".
    NoSummary,
    /// Um estado que o app não conhece (como "aguardando locutores"): "Abrir no web".
    NeedsYou,
}

/// Uma linha do painel.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentItem {
    /// Chave estável da linha: o id do servidor, ou `local:<id>` antes do envio.
    pub key: String,
    pub remote_id: Option<String>,
    pub local_id: Option<String>,
    /// O título; vazio quando ninguém deu um (a janela mostra a data).
    pub title: String,
    /// Início local em ms (linhas do aparelho).
    pub started_at: Option<i64>,
    /// `created_at` do servidor.
    pub created_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub phase: Phase,
    /// A etapa em curso: do job (`asr`…) na transcrição, do pipeline (`summary`…) depois, ou a
    /// etapa do estado desconhecido.
    pub stage: Option<String>,
    /// Progresso da transcrição em milésimos (0–1000).
    pub progress: Option<u16>,
    pub attention: Option<Attention>,
    /// O motivo no vocabulário de `PipelineStep.reason`.
    pub reason: Option<String>,
    /// O texto cru: o erro do envio, o código do erro do job ou o estado desconhecido.
    pub detail: Option<String>,
    /// A espera na fila do servidor, quando o sync a leu.
    pub wait: Option<QueueWait>,
}

/// O que o comando `recent` devolve.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RecentView {
    /// Quantas linhas a pessoa pediu; `0` esconde o painel.
    pub count: u8,
    pub items: Vec<RecentItem>,
    /// Quantas linhas pedem a pessoa.
    pub needs_you: usize,
    /// Quando o servidor foi lido por último (ms), `None` antes da primeira leitura.
    pub fetched_at: Option<i64>,
    /// A falha da última leitura; o painel segue com o que sabia.
    pub error: Option<String>,
}

/// O que a fase de uma linha do servidor diz.
#[derive(Debug, PartialEq)]
struct Classified {
    phase: Phase,
    stage: Option<String>,
    progress: Option<u16>,
    attention: Option<Attention>,
    reason: Option<String>,
    detail: Option<String>,
}

impl Classified {
    fn of(phase: Phase) -> Self {
        Self {
            phase,
            stage: None,
            progress: None,
            attention: None,
            reason: None,
            detail: None,
        }
    }
}

/// A fase de uma gravação do servidor, na precedência alerta > em andamento > pronto: um
/// estado desconhecido no meio de um pipeline com resumo pronto ainda é alerta.
fn classify(recording: &LibraryRecording) -> Classified {
    if !recording.status.is_empty() && !KNOWN_STATUS.contains(&recording.status.as_str()) {
        return Classified {
            attention: Some(Attention::NeedsYou),
            detail: Some(recording.status.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    if let Some(step) = recording
        .pipeline
        .iter()
        .find(|step| !KNOWN_STEP_STATES.contains(&step.state.as_str()))
    {
        return Classified {
            stage: Some(step.step.clone()),
            attention: Some(Attention::NeedsYou),
            reason: step.reason.clone(),
            detail: Some(step.state.clone()),
            ..Classified::of(Phase::Unknown)
        };
    }
    let job = recording.job.as_ref();
    let job_state = job.map(|job| job.state.as_str());
    let error = job.and_then(|job| job.error.as_ref());
    if job_state == Some("cancelled") || error.is_some_and(|e| e.code == "cancelled") {
        return Classified::of(Phase::Cancelled);
    }
    if recording.status == "failed" || job_state == Some("failed") {
        let retryable = error.is_some_and(|e| e.retryable);
        return Classified {
            attention: (!retryable).then_some(Attention::TranscriptionFailed),
            detail: error.map(|e| e.code.clone()).filter(|c| !c.is_empty()),
            ..Classified::of(Phase::TranscriptionFailed)
        };
    }
    let summary = recording.summary_step();
    if let Some(step) = summary.filter(|step| step.state == "failed") {
        return Classified {
            attention: Some(Attention::SummaryFailed),
            reason: step.reason.clone(),
            ..Classified::of(Phase::SummaryFailed)
        };
    }
    match job_state {
        Some("queued") => return Classified::of(Phase::Queued),
        Some("running") => {
            return Classified {
                stage: job.and_then(|job| job.stage.clone()),
                progress: job.and_then(|job| job.progress),
                ..Classified::of(Phase::Transcribing)
            }
        }
        _ => {}
    }
    // Depois da transcrição: a etapa ativa, senão a primeira à espera.
    let running = recording
        .pipeline
        .iter()
        .find(|step| step.state == "active")
        .or_else(|| {
            recording
                .pipeline
                .iter()
                .find(|step| step.state == "pending")
        });
    if let Some(step) = running {
        return Classified {
            stage: Some(step.step.clone()),
            ..Classified::of(Phase::Processing)
        };
    }
    if let Some(step) = summary {
        match step.state.as_str() {
            "done" => return Classified::of(Phase::SummaryReady),
            "skipped" => {
                let actionable = step
                    .reason
                    .as_deref()
                    .is_some_and(|r| ACTIONABLE_NO_SUMMARY.contains(&r));
                return Classified {
                    attention: actionable.then_some(Attention::NoSummary),
                    reason: step.reason.clone(),
                    ..Classified::of(Phase::NoSummary)
                };
            }
            _ => {}
        }
    }
    match recording.status.as_str() {
        "transcribed" => Classified::of(Phase::Transcribed),
        "processing" => Classified::of(Phase::Processing),
        _ => Classified::of(Phase::Queued),
    }
}

/// O título dado ao parar, senão o que o servidor deu, senão o nome do arquivo importado.
fn local_title(recording: &QueuedRecording) -> String {
    recording
        .title
        .clone()
        .or_else(|| recording.server_title.clone())
        .or_else(|| recording.original_name.clone())
        .unwrap_or_default()
}

fn local_item(recording: &QueuedRecording) -> RecentItem {
    let (phase, attention) = match recording.status {
        Status::Recording => (Phase::Recording, None),
        Status::Pending => (Phase::Pending, None),
        Status::Syncing => (Phase::Uploading, None),
        Status::Failed => (Phase::UploadFailed, Some(Attention::UploadFailed)),
        Status::Synced => (Phase::Uploaded, None),
    };
    RecentItem {
        key: recording
            .remote_id
            .clone()
            .unwrap_or_else(|| format!("local:{}", recording.id)),
        remote_id: recording.remote_id.clone(),
        local_id: Some(recording.id.clone()),
        title: local_title(recording),
        started_at: Some(recording.started_at),
        created_at: None,
        duration_ms: recording.duration_ms,
        phase,
        stage: None,
        progress: None,
        attention,
        reason: None,
        detail: (recording.status == Status::Failed)
            .then(|| recording.last_error.clone())
            .flatten(),
        wait: None,
    }
}

fn remote_item(
    recording: &LibraryRecording,
    local: Option<&QueuedRecording>,
    wait: Option<&QueueWait>,
) -> RecentItem {
    let classified = classify(recording);
    let title = if recording.title.trim().is_empty() {
        local.map(local_title).unwrap_or_default()
    } else {
        recording.title.clone()
    };
    RecentItem {
        key: recording.id.clone(),
        remote_id: Some(recording.id.clone()),
        local_id: local.map(|rec| rec.id.clone()),
        title,
        started_at: local.map(|rec| rec.started_at),
        created_at: recording.created_at.clone(),
        duration_ms: local.and_then(|rec| rec.duration_ms),
        wait: (classified.phase == Phase::Queued)
            .then(|| wait.cloned())
            .flatten(),
        phase: classified.phase,
        stage: classified.stage,
        progress: classified.progress,
        attention: classified.attention,
        reason: classified.reason,
        detail: classified.detail,
    }
}

/// Junta a fila local (mais recente primeiro) e a página do servidor numa lista de no máximo
/// `count` linhas. As linhas locais ainda não enviadas vêm primeiro; uma enviada daqui que está
/// na página vira a linha do servidor. Sem leitura do servidor (`remote` `None`), as enviadas
/// aparecem como "Enviada".
pub fn build(
    local: &[QueuedRecording],
    remote: Option<&[LibraryRecording]>,
    waits: &BTreeMap<String, QueueWait>,
    count: u8,
) -> Vec<RecentItem> {
    let by_remote: HashMap<&str, &QueuedRecording> = local
        .iter()
        .filter_map(|rec| rec.remote_id.as_deref().map(|id| (id, rec)))
        .collect();
    let mut items: Vec<RecentItem> = local
        .iter()
        .filter(|rec| rec.status != Status::Synced || remote.is_none())
        .map(local_item)
        .collect();
    for recording in remote.unwrap_or_default() {
        let local = by_remote.get(recording.id.as_str()).copied();
        items.push(remote_item(recording, local, waits.get(&recording.id)));
    }
    items.truncate(usize::from(count));
    items
}

/// Se a janela está visível e alguma linha está em andamento: o ritmo rápido.
pub fn is_busy(items: &[RecentItem], visible: bool) -> bool {
    visible && items.iter().any(|item| item.phase.in_progress())
}

/// Quanto o laço espera até a próxima leitura.
pub fn interval(items: &[RecentItem], visible: bool) -> Duration {
    if is_busy(items, visible) {
        BUSY_INTERVAL
    } else {
        IDLE_INTERVAL
    }
}

/// A espera depois de `failures` leituras seguidas que falharam: o ritmo normal dobrando a cada
/// falha, até [`ERROR_MAX_INTERVAL`]. Sem falha, o ritmo normal.
pub fn error_interval(normal: Duration, failures: u32) -> Duration {
    normal
        .saturating_mul(2u32.saturating_pow(failures.min(8)))
        .min(ERROR_MAX_INTERVAL.max(normal))
}

/// Se a próxima leitura é a página inteira (e não só o que mudou): quando o laço foi cutucado,
/// no ritmo rápido (o progresso anda na tela), sem página ainda, sem `since` para pedir, com a
/// contagem trocada ou com a última página inteira velha.
pub fn read_full_page(
    cursor: Option<&str>,
    full_at: Option<i64>,
    same_count: bool,
    forced: bool,
    fast: bool,
    now: i64,
) -> bool {
    forced
        || fast
        || !same_count
        || cursor.is_none()
        || full_at.is_none_or(|at| !(0..FULL_READ_EVERY_MS).contains(&(now - at)))
}

/// Mescla na página `page` (da mais recente para a mais antiga, por criação) as gravações que
/// mudaram: troca por id as que já estavam, acrescenta as novas e mantém as `count` mais
/// recentes. Uma gravação apagada só sai na leitura da página inteira.
pub fn merge_changes(
    page: &[LibraryRecording],
    changed: &[LibraryRecording],
    count: usize,
) -> Vec<LibraryRecording> {
    let mut merged: Vec<LibraryRecording> = page
        .iter()
        .map(|item| {
            changed
                .iter()
                .find(|new| new.id == item.id)
                .unwrap_or(item)
                .clone()
        })
        .collect();
    for new in changed {
        if !merged.iter().any(|item| item.id == new.id) {
            merged.push(new.clone());
        }
    }
    let created = |item: &LibraryRecording| item.created_at.as_deref().and_then(api::instant_ms);
    // Estável: o que tem a mesma criação (ou nenhuma) fica na ordem em que estava.
    merged.sort_by_key(|item| std::cmp::Reverse(created(item)));
    merged.truncate(count);
    merged
}

/// A última leitura do servidor.
#[derive(Default)]
struct Snapshot {
    items: Option<Vec<LibraryRecording>>,
    fetched_at: Option<i64>,
    /// Quando a página inteira foi lida pela última vez, e com qual contagem.
    full_at: Option<i64>,
    count: u8,
    error: Option<String>,
}

/// O que uma leitura trouxe.
enum Read {
    /// A página inteira das `count` mais recentes.
    Page(Vec<LibraryRecording>),
    /// Só o que mudou desde o `since`.
    Changes(Vec<LibraryRecording>),
}

/// O canal para cutucar o laço e a última leitura.
pub struct RecentHandle {
    tx: Mutex<Sender<()>>,
    snapshot: Mutex<Snapshot>,
}

/// Sobe a thread `eclume-recentes` e registra o canal no app.
pub fn spawn(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(RecentHandle {
        tx: Mutex::new(tx),
        snapshot: Mutex::new(Snapshot::default()),
    });
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("eclume-recentes".into())
        .spawn(move || {
            let mut wait = Duration::ZERO;
            let mut failures: u32 = 0;
            let mut fast = false;
            // A primeira volta (espera zero) é uma leitura inteira, como um cutucão.
            let mut forced = true;
            loop {
                let woke = rx.recv_timeout(wait);
                if matches!(woke, Err(RecvTimeoutError::Disconnected)) {
                    break;
                }
                // Um cutucão (e não o fim da espera) pede a página inteira.
                forced |= woke.is_ok();
                while rx.try_recv().is_ok() {}
                match fetch(&app, forced, fast) {
                    Ok(()) => failures = 0,
                    Err(err) => {
                        failures = failures.saturating_add(1);
                        log::info!("recentes: {err:#}");
                    }
                }
                forced = false;
                crate::refresh_ui(&app);
                let visible = app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                let items = view(&app).map(|view| view.items).unwrap_or_default();
                fast = is_busy(&items, visible);
                wait = error_interval(interval(&items, visible), failures);
            }
        });
    if let Err(err) = spawned {
        log::error!("falha ao iniciar o painel de recentes: {err}");
    }
}

/// Pede uma leitura já (envio concluído, configurações salvas, a principal aberta).
pub fn nudge(app: &AppHandle) {
    if let Some(handle) = app.try_state::<RecentHandle>() {
        if let Ok(tx) = handle.tx.lock() {
            let _ = tx.send(());
        }
    }
}

/// Quantas a leitura pede: a maior das duas contagens, porque a janela e a bandeja cortam a mesma
/// lista, cada uma no seu N.
pub fn fetch_count(window: u8, tray: u8) -> u8 {
    window.max(tray)
}

/// Lê as recentes. Sem credencial ou com a janela e a bandeja escondendo as recentes, não lê
/// nada. Devagar (`fast` falso, sem `forced`), lê só o que mudou ([`read_full_page`]) e mescla na
/// página. A falha fica em `error` e o último retrato segue valendo.
fn fetch(app: &AppHandle, forced: bool, fast: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let count = fetch_count(state.recent_count()?, state.tray_recent_count()?);
    let Some(config) = state.uploader_config()? else {
        return Ok(());
    };
    if count == 0 {
        return Ok(());
    }
    let handle = app.state::<RecentHandle>();
    let now = now_ms();
    let (full, cursor) = {
        let snapshot = handle
            .snapshot
            .lock()
            .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
        let cursor = snapshot
            .items
            .as_deref()
            .and_then(|items| api::cursor_from(items, SINCE_MARGIN_SECS));
        let full = read_full_page(
            cursor.as_deref(),
            snapshot.full_at,
            snapshot.count == count,
            forced,
            fast,
            now,
        );
        (full, cursor)
    };
    let result = Client::from_config(&config).and_then(|client| match (&cursor, full) {
        (Some(since), false) => {
            crate::sync::library_since(&config, &client, since).map(Read::Changes)
        }
        _ => client.recent(u32::from(count)).map(Read::Page),
    });
    let mut snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    match result {
        Ok(read) => {
            match read {
                Read::Page(items) => {
                    snapshot.items = Some(items);
                    snapshot.full_at = Some(now);
                    snapshot.count = count;
                }
                Read::Changes(changed) => {
                    let page = snapshot.items.take().unwrap_or_default();
                    snapshot.items = Some(merge_changes(&page, &changed, usize::from(count)));
                }
            }
            snapshot.fetched_at = Some(now_ms());
            snapshot.error = None;
            Ok(())
        }
        Err(err) => {
            snapshot.error = Some(format!("{err:#}"));
            Err(err)
        }
    }
}

/// O painel como a janela o desenha.
pub fn view(app: &AppHandle) -> Result<RecentView> {
    let state = app.state::<AppState>();
    let count = state.recent_count()?;
    let local = state.recordings(u32::from(count))?;
    let waits = state.view()?.queue_waits;
    let handle = app.state::<RecentHandle>();
    let snapshot = handle
        .snapshot
        .lock()
        .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
    let items = build(&local, snapshot.items.as_deref(), &waits, count);
    Ok(RecentView {
        count,
        needs_you: items.iter().filter(|item| item.attention.is_some()).count(),
        items,
        fetched_at: snapshot.fetched_at,
        error: snapshot.error.clone(),
    })
}

/// Uma ação do submenu de uma gravação na bandeja.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayAction {
    /// "Copiar resumo", pelo id remoto.
    CopySummary(String),
    /// "Abrir no web", pelo id remoto.
    OpenWeb(String),
    /// "Tentar agora" (`sync_now`), pelo id local, que só torna o item único no menu.
    Retry(String),
}

/// Uma gravação no menu da bandeja: o rótulo pronto e as ações que valem para ela.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayEntry {
    pub key: String,
    /// "Título · Estado", com o `&` já escapado para o menu nativo.
    pub label: String,
    pub actions: Vec<TrayAction>,
}

/// A seção Recentes do menu da bandeja. O progresso e a espera ficam de fora, de propósito: o
/// menu só é reconstruído quando isto muda.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraySection {
    /// "Recentes", ou "Recentes · 1 precisa de você".
    pub header: String,
    pub entries: Vec<TrayEntry>,
}

/// O máximo de caracteres do título no menu, antes das reticências.
const TRAY_TITLE_MAX: usize = 40;

/// O andamento de uma etapa do pipeline, como o `ETAPAS` de `vocabulario.js`.
fn stage_progress(stage: &str) -> &'static str {
    match stage {
        "received" => "Enviando",
        "preprocessing" => "Pré-processando",
        "transcription" => "Transcrevendo",
        "speakers" => "Conferindo locutores",
        "agenda_type" => "Detectando o tipo",
        "fields" => "Preenchendo campos",
        "summary" => "Resumindo",
        _ => "Em andamento",
    }
}

/// O estado de uma linha em texto, com os rótulos que `recentes.js` tira do vocabulário: o menu
/// nativo não passa pela janela.
pub fn state_label(item: &RecentItem) -> &'static str {
    match item.phase {
        Phase::Recording => "Gravando",
        Phase::Pending => "Aguardando envio",
        Phase::Uploading => "Enviando",
        Phase::UploadFailed => "Falhou o envio",
        Phase::Uploaded => "Enviada",
        Phase::Queued => "Na fila",
        Phase::Transcribing => "Transcrevendo",
        Phase::Processing => item.stage.as_deref().map_or("Em andamento", stage_progress),
        Phase::SummaryReady => "Resumo pronto",
        Phase::Transcribed => "Pronta",
        Phase::NoSummary => "Pronta sem resumo",
        Phase::SummaryFailed => "O resumo falhou",
        Phase::TranscriptionFailed => "A transcrição falhou",
        Phase::Cancelled => "Cancelada",
        Phase::Unknown
            if item.stage.as_deref() == Some("speakers")
                && item.detail.as_deref() == Some("waiting") =>
        {
            "Aguardando locutores"
        }
        Phase::Unknown => NEEDS_YOU,
    }
}

const NEEDS_YOU: &str = "Precisa de você";

/// "05/10 14:02" a partir de um `AAAA-MM-DDTHH:MM:SS` local.
fn short_date(local: &str) -> Option<String> {
    let day = local.get(8..10)?;
    let month = local.get(5..7)?;
    let time = local.get(11..16)?;
    Some(format!("{day}/{month} {time}"))
}

/// O título curto da linha: o título com reticências passado do limite; sem título, a data curta
/// no fuso deste computador, como o painel; sem data, "Gravação". O `&` vira `&&`, porque o menu
/// nativo o lê como mnemônico no GTK e no Windows.
pub fn tray_title(item: &RecentItem) -> String {
    let title = item.title.trim();
    let text = if title.is_empty() {
        item.started_at
            .and_then(eclume_sync::api::rfc3339_from_ms)
            .or_else(|| item.created_at.clone())
            .and_then(|at| eclume_sync::api::local_start(&at))
            .and_then(|local| short_date(&local))
            .unwrap_or_else(|| "Gravação".to_string())
    } else if title.chars().count() > TRAY_TITLE_MAX {
        let cut: String = title.chars().take(TRAY_TITLE_MAX - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        title.to_string()
    };
    text.replace('&', "&&")
}

fn tray_entry(item: &RecentItem) -> TrayEntry {
    let state = state_label(item);
    let label = if item.attention.is_some() && state != NEEDS_YOU {
        format!("{} · {NEEDS_YOU} ({state})", tray_title(item))
    } else {
        format!("{} · {state}", tray_title(item))
    };
    let mut actions = Vec::new();
    if let Some(remote) = &item.remote_id {
        if item.phase == Phase::SummaryReady {
            actions.push(TrayAction::CopySummary(remote.clone()));
        }
        actions.push(TrayAction::OpenWeb(remote.clone()));
    }
    if item.attention == Some(Attention::UploadFailed) {
        if let Some(local) = &item.local_id {
            actions.push(TrayAction::Retry(local.clone()));
        }
    }
    TrayEntry {
        key: item.key.clone(),
        label,
        actions,
    }
}

/// A seção da bandeja a partir das linhas já cortadas no N da bandeja.
pub fn tray_section_of(items: &[RecentItem]) -> TraySection {
    let header = match items.iter().filter(|item| item.attention.is_some()).count() {
        0 => "Recentes".to_string(),
        1 => "Recentes · 1 precisa de você".to_string(),
        n => format!("Recentes · {n} precisam de você"),
    };
    TraySection {
        header,
        entries: items.iter().map(tray_entry).collect(),
    }
}

/// A seção Recentes do menu da bandeja, da mesma fila local e do mesmo retrato do painel, sem
/// leitura própria da API; `None` com `tray_recent_count` em 0. Antes da primeira leitura (ou
/// antes de a thread subir), só a fila local.
pub fn tray_section(app: &AppHandle) -> Result<Option<TraySection>> {
    let state = app.state::<AppState>();
    let count = state.tray_recent_count()?;
    if count == 0 {
        return Ok(None);
    }
    let local = state.recordings(u32::from(count))?;
    let waits = BTreeMap::new();
    let items = match app.try_state::<RecentHandle>() {
        Some(handle) => {
            let snapshot = handle
                .snapshot
                .lock()
                .map_err(|_| anyhow!("painel de recentes envenenado por um pânico"))?;
            build(&local, snapshot.items.as_deref(), &waits, count)
        }
        None => build(&local, None, &waits, count),
    };
    Ok(Some(tray_section_of(&items)))
}

/// "Copiar resumo": põe o Markdown do resumo atual na área de transferência, o mesmo que o
/// "Copiar" do aviso de resumo pronto copia.
pub fn copy_summary(app: &AppHandle, recording_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let config = state
        .uploader_config()?
        .context("Entre para copiar o resumo")?;
    let summary = Client::from_config(&config)?
        .current_summary(recording_id)?
        .context("O resumo ainda não está pronto")?;
    app.clipboard()
        .write_text(summary.content_md)
        .map_err(|err| anyhow!("falha ao copiar o resumo: {err}"))
}

/// "Abrir no web": a página da gravação no eclume web.
pub fn open_recording(app: &AppHandle, recording_id: &str) -> Result<()> {
    let url = crate::sync::recording_url(&app.state::<AppState>().web_url()?, recording_id);
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use eclume_recorder::{Kind, RecordedAtSource, Source};
    use eclume_sync::api::{JobError, JobInfo, PipelineStepInfo};

    fn step(step: &str, state: &str, reason: Option<&str>) -> PipelineStepInfo {
        PipelineStepInfo {
            step: step.into(),
            state: state.into(),
            finished_at: None,
            reason: reason.map(str::to_string),
        }
    }

    fn remota(id: &str, status: &str) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: status.into(),
            recorded_at: None,
            created_at: Some("2026-10-05T12:00:00Z".into()),
            updated_at: None,
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: vec![],
            job: None,
        }
    }

    fn com_job(mut rec: LibraryRecording, job: JobInfo) -> LibraryRecording {
        rec.job = Some(job);
        rec
    }

    fn com_etapas(mut rec: LibraryRecording, etapas: Vec<PipelineStepInfo>) -> LibraryRecording {
        rec.pipeline = etapas;
        rec
    }

    fn job(state: &str) -> JobInfo {
        JobInfo {
            state: state.into(),
            ..JobInfo::default()
        }
    }

    fn local(id: &str, status: Status, started_at: i64, remote: Option<&str>) -> QueuedRecording {
        QueuedRecording {
            id: id.into(),
            path: std::path::PathBuf::from(format!("/tmp/{id}.ogg")),
            started_at,
            ended_at: None,
            duration_ms: Some(60_000),
            bytes: None,
            status,
            interrupted: false,
            attempts: 0,
            last_error: (status == Status::Failed).then(|| "servidor fora do ar".to_string()),
            remote_id: remote.map(str::to_string),
            upload_id: None,
            sha256: None,
            next_attempt_at: None,
            synced_at: None,
            purged_at: None,
            meeting_app: None,
            kind: Kind::Meeting,
            recorded_at_source: RecordedAtSource::Capture,
            source: Source::Desktop,
            original_name: None,
            content_type: None,
            title: None,
            agenda_type_id: None,
            details_pending: false,
            server_title: None,
            language: None,
        }
    }

    #[test]
    fn fase_de_cada_estado_do_servidor() {
        let fase = |rec: &LibraryRecording| classify(rec).phase;
        assert_eq!(
            fase(&com_job(remota("a", "queued"), job("queued"))),
            Phase::Queued
        );
        let transcrevendo = classify(&com_job(
            remota("b", "processing"),
            JobInfo {
                stage: Some("asr".into()),
                progress: Some(420),
                ..job("running")
            },
        ));
        assert_eq!(
            (
                transcrevendo.phase,
                transcrevendo.stage.as_deref(),
                transcrevendo.progress
            ),
            (Phase::Transcribing, Some("asr"), Some(420))
        );
        let resumindo = classify(&com_etapas(
            com_job(remota("c", "transcribed"), job("succeeded")),
            vec![
                step("transcription", "done", None),
                step("agenda_type", "done", None),
                step("summary", "active", None),
            ],
        ));
        assert_eq!(
            (resumindo.phase, resumindo.stage.as_deref()),
            (Phase::Processing, Some("summary"))
        );
        assert_eq!(
            fase(&com_etapas(
                remota("d", "transcribed"),
                vec![step("summary", "done", None)]
            )),
            Phase::SummaryReady
        );
        assert_eq!(fase(&remota("e", "transcribed")), Phase::Transcribed);
        assert_eq!(
            fase(&com_job(remota("f", "failed"), job("cancelled"))),
            Phase::Cancelled
        );
    }

    #[test]
    fn alertas_so_onde_a_pessoa_resolve() {
        let alerta = |rec: &LibraryRecording| classify(rec).attention;
        let falhou = |retryable| {
            com_job(
                remota("a", "failed"),
                JobInfo {
                    error: Some(JobError {
                        code: "engine_error".into(),
                        retryable,
                    }),
                    ..job("failed")
                },
            )
        };
        assert_eq!(alerta(&falhou(false)), Some(Attention::TranscriptionFailed));
        assert_eq!(
            classify(&falhou(false)).detail.as_deref(),
            Some("engine_error")
        );
        // Passageira: o servidor tenta de novo.
        assert_eq!(alerta(&falhou(true)), None);
        assert_eq!(
            alerta(&com_etapas(
                remota("b", "transcribed"),
                vec![step("summary", "failed", None)]
            )),
            Some(Attention::SummaryFailed)
        );
        let pulado = |motivo| {
            com_etapas(
                remota("c", "transcribed"),
                vec![step("summary", "skipped", Some(motivo))],
            )
        };
        assert_eq!(
            alerta(&pulado("no_agenda_type")),
            Some(Attention::NoSummary)
        );
        assert_eq!(classify(&pulado("no_provider")).phase, Phase::NoSummary);
        assert_eq!(alerta(&pulado("no_provider")), None);
        assert_eq!(alerta(&pulado("cancelled")), None);
    }

    #[test]
    fn estado_desconhecido_vira_precisa_de_voce_mesmo_com_o_resumo_pronto() {
        let etapa = classify(&com_etapas(
            remota("a", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "awaiting_speakers", Some("speakers_required")),
                step("summary", "done", None),
            ],
        ));
        assert_eq!(etapa.phase, Phase::Unknown);
        assert_eq!(etapa.attention, Some(Attention::NeedsYou));
        assert_eq!(etapa.stage.as_deref(), Some("speakers"));
        assert_eq!(etapa.detail.as_deref(), Some("awaiting_speakers"));
        assert_eq!(etapa.reason.as_deref(), Some("speakers_required"));

        let status = classify(&remota("b", "awaiting_speakers"));
        assert_eq!(
            (status.phase, status.attention, status.detail.as_deref()),
            (
                Phase::Unknown,
                Some(Attention::NeedsYou),
                Some("awaiting_speakers")
            )
        );
    }

    #[test]
    fn locutores_aguardando_viram_alerta_com_a_etapa_e_o_motivo() {
        let etapa = classify(&com_etapas(
            remota("w", "transcribed"),
            vec![
                step("transcription", "done", None),
                step("speakers", "waiting", Some("unnamed_speakers")),
                step("summary", "pending", None),
            ],
        ));
        assert_eq!(etapa.phase, Phase::Unknown);
        assert_eq!(etapa.attention, Some(Attention::NeedsYou));
        assert_eq!(etapa.stage.as_deref(), Some("speakers"));
        assert_eq!(etapa.detail.as_deref(), Some("waiting"));
        assert_eq!(etapa.reason.as_deref(), Some("unnamed_speakers"));
    }

    #[test]
    fn junta_a_fila_local_e_a_pagina_sem_duplicar_e_corta_em_n() {
        let fila = vec![
            local("l-gravando", Status::Recording, 500, None),
            local("l-falhou", Status::Failed, 400, None),
            local("l-enviada", Status::Synced, 300, Some("r1")),
            local("l-velha", Status::Synced, 100, Some("r-fora")),
        ];
        let pagina = vec![
            com_job(remota("r1", "queued"), job("queued")),
            com_etapas(
                remota("r2", "transcribed"),
                vec![step("summary", "done", None)],
            ),
            remota("r3", "transcribed"),
        ];
        let mut esperas = BTreeMap::new();
        esperas.insert(
            "r1".to_string(),
            QueueWait {
                reason: "gpu_busy".into(),
                ahead: Some(2),
                account_ahead: None,
                estimated_start_at: None,
                resumes_at: None,
                processor: None,
            },
        );
        let linhas = build(&fila, Some(pagina.as_slice()), &esperas, 4);
        assert_eq!(
            linhas.iter().map(|l| l.key.as_str()).collect::<Vec<_>>(),
            ["local:l-gravando", "local:l-falhou", "r1", "r2"]
        );
        assert_eq!(linhas[1].attention, Some(Attention::UploadFailed));
        assert_eq!(linhas[1].detail.as_deref(), Some("servidor fora do ar"));
        // A enviada daqui é a linha do servidor, com o id local e a espera na fila.
        assert_eq!(linhas[2].local_id.as_deref(), Some("l-enviada"));
        assert_eq!(linhas[2].wait.as_ref().map(|w| w.ahead), Some(Some(2)));
        assert_eq!(linhas[3].phase, Phase::SummaryReady);

        // Sem leitura do servidor, as enviadas aparecem como "Enviada".
        let sem_servidor = build(&fila, None, &BTreeMap::new(), 5);
        assert_eq!(sem_servidor.len(), 4);
        assert_eq!(sem_servidor[2].phase, Phase::Uploaded);
        assert_eq!(sem_servidor[2].key, "r1");

        assert!(build(&fila, Some(pagina.as_slice()), &esperas, 0).is_empty());
    }

    #[test]
    fn a_leitura_pede_a_maior_das_duas_contagens() {
        assert_eq!(fetch_count(5, 1), 5);
        assert_eq!(fetch_count(0, 3), 3);
        assert_eq!(fetch_count(0, 0), 0);
        // A janela e a bandeja cortam a mesma lista, cada uma no seu N.
        let pagina: Vec<_> = (1..=5)
            .map(|n| remota(&format!("r{n}"), "transcribed"))
            .collect();
        let janela = build(&[], Some(pagina.as_slice()), &BTreeMap::new(), 5);
        let bandeja = build(&[], Some(pagina.as_slice()), &BTreeMap::new(), 1);
        assert_eq!(janela.len(), 5);
        assert_eq!(bandeja, janela[..1]);
    }

    fn linha(item: RecentItem) -> TrayEntry {
        tray_section_of(&[item]).entries.remove(0)
    }

    #[test]
    fn bandeja_rotula_cada_fase_e_da_as_acoes_que_valem() {
        let pronta = build(
            &[],
            Some(
                &[com_etapas(
                    remota("r1", "transcribed"),
                    vec![step("summary", "done", None)],
                )][..],
            ),
            &BTreeMap::new(),
            1,
        );
        assert_eq!(
            linha(pronta[0].clone()),
            TrayEntry {
                key: "r1".into(),
                label: "Reunião r1 · Resumo pronto".into(),
                actions: vec![
                    TrayAction::CopySummary("r1".into()),
                    TrayAction::OpenWeb("r1".into())
                ],
            }
        );

        let falhou = build(
            &[local("l1", Status::Failed, 10, None)],
            None,
            &BTreeMap::new(),
            1,
        );
        let mut falhou = falhou[0].clone();
        falhou.title = "Daily".into();
        assert_eq!(
            linha(falhou),
            TrayEntry {
                key: "local:l1".into(),
                label: "Daily · Precisa de você (Falhou o envio)".into(),
                actions: vec![TrayAction::Retry("l1".into())],
            }
        );

        let mut gravando = build(
            &[local("l2", Status::Recording, 10, None)],
            None,
            &BTreeMap::new(),
            1,
        )[0]
        .clone();
        gravando.title = "Reunião".into();
        let gravando = linha(gravando);
        assert_eq!(gravando.label, "Reunião · Gravando");
        assert!(gravando.actions.is_empty());

        let locutores = com_etapas(
            remota("r2", "transcribed"),
            vec![step("speakers", "waiting", Some("unnamed_speakers"))],
        );
        let locutores = build(&[], Some(&[locutores][..]), &BTreeMap::new(), 1);
        assert_eq!(
            linha(locutores[0].clone()).label,
            "Reunião r2 · Precisa de você (Aguardando locutores)"
        );
        let novo = build(
            &[],
            Some(&[remota("r3", "estado_novo")][..]),
            &BTreeMap::new(),
            1,
        );
        assert_eq!(linha(novo[0].clone()).label, "Reunião r3 · Precisa de você");

        let resumindo = com_etapas(
            com_job(remota("r4", "transcribed"), job("succeeded")),
            vec![step("summary", "active", None)],
        );
        let resumindo = build(&[], Some(&[resumindo][..]), &BTreeMap::new(), 1);
        assert_eq!(linha(resumindo[0].clone()).label, "Reunião r4 · Resumindo");
        assert_eq!(
            linha(resumindo[0].clone()).actions,
            [TrayAction::OpenWeb("r4".into())]
        );
    }

    #[test]
    fn bandeja_conta_os_alertas_no_cabecalho_e_ignora_o_progresso() {
        let fila = vec![
            local("a", Status::Failed, 3, None),
            local("b", Status::Failed, 2, None),
            local("c", Status::Pending, 1, None),
        ];
        let linhas = build(&fila, None, &BTreeMap::new(), 3);
        assert_eq!(
            tray_section_of(&linhas).header,
            "Recentes · 2 precisam de você"
        );
        assert_eq!(
            tray_section_of(&linhas[1..]).header,
            "Recentes · 1 precisa de você"
        );
        assert_eq!(tray_section_of(&linhas[2..]).header, "Recentes");
        assert!(tray_section_of(&[]).entries.is_empty());

        // O progresso anda sem mudar a seção: o menu não é reconstruído por ele.
        let andando = |progress| {
            com_job(
                remota("r", "processing"),
                JobInfo {
                    stage: Some("asr".into()),
                    progress: Some(progress),
                    ..job("running")
                },
            )
        };
        let antes = build(&[], Some(&[andando(100)][..]), &BTreeMap::new(), 1);
        let depois = build(&[], Some(&[andando(900)][..]), &BTreeMap::new(), 1);
        assert_ne!(antes, depois);
        assert_eq!(tray_section_of(&antes), tray_section_of(&depois));
    }

    #[test]
    fn titulo_da_bandeja_e_curto_escapa_o_e_comercial_e_cai_na_data() {
        let mut item = build(
            &[],
            Some(&[remota("r", "transcribed")][..]),
            &BTreeMap::new(),
            1,
        )[0]
        .clone();
        item.title = "P&D · revisão".into();
        assert_eq!(tray_title(&item), "P&&D · revisão");
        item.title = "a".repeat(60);
        let curto = tray_title(&item);
        assert_eq!(curto.chars().count(), TRAY_TITLE_MAX);
        assert!(curto.ends_with('…'));
        item.title = "  ".into();
        // Sem título, a data curta no fuso local, como o painel ("dd/mm hh:mm").
        let data = tray_title(&item);
        assert_eq!(data.len(), "05/10 12:00".len());
        assert_eq!(&data[2..3], "/");
        item.created_at = None;
        item.started_at = None;
        assert_eq!(tray_title(&item), "Gravação");
        assert_eq!(
            short_date("2026-10-05T14:02:09").as_deref(),
            Some("05/10 14:02")
        );
        assert_eq!(short_date("curto"), None);
    }

    #[test]
    fn le_mais_vezes_so_com_a_janela_visivel_e_algo_em_andamento() {
        let fila = vec![local("l", Status::Pending, 1, None)];
        let andando = build(&fila, Some(&[][..]), &BTreeMap::new(), 5);
        assert_eq!(interval(&andando, true), BUSY_INTERVAL);
        assert_eq!(interval(&andando, false), IDLE_INTERVAL);
        let pronta = build(
            &[],
            Some(
                &[com_etapas(
                    remota("r", "transcribed"),
                    vec![step("summary", "done", None)],
                )][..],
            ),
            &BTreeMap::new(),
            5,
        );
        assert_eq!(interval(&pronta, true), IDLE_INTERVAL);
    }

    #[test]
    fn leitura_que_falha_dobra_a_espera_ate_um_minuto_e_sem_falha_e_o_ritmo_normal() {
        let secs = Duration::from_secs;
        assert_eq!(error_interval(BUSY_INTERVAL, 0), secs(5));
        assert_eq!(error_interval(BUSY_INTERVAL, 1), secs(10));
        assert_eq!(error_interval(BUSY_INTERVAL, 2), secs(20));
        assert_eq!(error_interval(BUSY_INTERVAL, 3), secs(40));
        assert_eq!(error_interval(BUSY_INTERVAL, 4), secs(60));
        assert_eq!(error_interval(BUSY_INTERVAL, 1_000), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, 0), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, 5), secs(60));
        assert_eq!(error_interval(IDLE_INTERVAL, u32::MAX), secs(60));
    }

    #[test]
    fn a_pagina_inteira_so_no_ritmo_rapido_no_cutucao_e_a_cada_dez_minutos() {
        let since = Some("2026-10-05T12:00:00Z");
        let now = 100 * 60 * 1000;
        let recent = Some(now - 60 * 1000);
        // Devagar, com página, `since` e contagem iguais: só o que mudou.
        assert!(!read_full_page(since, recent, true, false, false, now));
        // Cutucão, ritmo rápido, contagem trocada, sem `since` ou sem página inteira anterior.
        assert!(read_full_page(since, recent, true, true, false, now));
        assert!(read_full_page(since, recent, true, false, true, now));
        assert!(read_full_page(since, recent, false, false, false, now));
        assert!(read_full_page(None, recent, true, false, false, now));
        assert!(read_full_page(since, None, true, false, false, now));
        // A página inteira de 10 min atrás já é velha; o relógio que voltou também não vale.
        assert!(read_full_page(
            since,
            Some(now - FULL_READ_EVERY_MS),
            true,
            false,
            false,
            now
        ));
        assert!(!read_full_page(
            since,
            Some(now - FULL_READ_EVERY_MS + 1),
            true,
            false,
            false,
            now
        ));
        assert!(read_full_page(
            since,
            Some(now + 1),
            true,
            false,
            false,
            now
        ));
    }

    #[test]
    fn mescla_troca_por_id_acrescenta_a_nova_e_mantem_as_mais_recentes() {
        let em = |id: &str, status: &str, created: &str| {
            let mut rec = remota(id, status);
            rec.created_at = Some(created.into());
            rec
        };
        let page = vec![
            em("c", "processing", "2026-10-05T12:03:00Z"),
            em("b", "transcribed", "2026-10-05T12:02:00Z"),
            em("a", "transcribed", "2026-10-05T12:01:00Z"),
        ];
        let changed = vec![
            // Troca a "c", que terminou.
            em("c", "transcribed", "2026-10-05T12:03:00Z"),
            // Nova, a mais recente.
            em("d", "queued", "2026-10-05T12:04:00Z"),
            // Mais antiga que a página inteira: cai fora do corte.
            em("z", "transcribed", "2026-10-05T11:00:00Z"),
        ];
        let merged = merge_changes(&page, &changed, 3);
        let seen: Vec<(&str, &str)> = merged
            .iter()
            .map(|rec| (rec.id.as_str(), rec.status.as_str()))
            .collect();
        assert_eq!(
            seen,
            [("d", "queued"), ("c", "transcribed"), ("b", "transcribed")]
        );
        // Sem mudança, a página fica como estava.
        assert_eq!(merge_changes(&page, &[], 3), page);
        // Datas comparadas como datas, não como texto ("…:05Z" vem depois de "…:05.5Z").
        let fine = vec![
            em("x", "queued", "2026-10-05T12:00:05Z"),
            em("y", "queued", "2026-10-05T12:00:05.500000Z"),
        ];
        let merged = merge_changes(&[], &fine, 2);
        assert_eq!(merged[0].id, "y");
    }
}
