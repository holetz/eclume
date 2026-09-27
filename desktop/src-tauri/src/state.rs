//! Estado do app: a gravação em andamento (e quem a iniciou), a fila, a configuração, o PAT e a
//! detecção de reuniões.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use eclume_detect::{default_policy, Action, AppKey, AutoRecorder, Policy, Recording};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig, StartOptions, StopReason};
use eclume_recorder::{
    Kind, Marker, MeetingEvent, NewImport, Queue, QueueCounts, QueuedRecording, RecordedAtSource,
    METER_BARS,
};
use eclume_sync::{PatSource, PatStore, UploaderConfig};
use serde::{Deserialize, Serialize};

use crate::capture::OpenedSources;
use crate::config::{self, Config};
use crate::shortcuts::{Registration, Registrations, ShortcutAction, Shortcuts};

/// Versão que vai no `capture.client_version` e no `User-Agent`.
pub const CLIENT_VERSION: &str = concat!("eclume-desktop/", env!("CARGO_PKG_VERSION"));

/// O que a bandeja mostra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppStatus {
    Idle,
    Recording,
    /// Enviando gravações ao servidor.
    Syncing,
}

impl AppStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "Ocioso",
            Self::Recording => "Gravando",
            Self::Syncing => "Sincronizando",
        }
    }
}

/// Pedido de gravar com outra gravação em andamento.
#[derive(Debug)]
pub struct Busy;

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Já há uma gravação em andamento")
    }
}

impl std::error::Error for Busy {}

/// O que "Nova nota" fez.
#[derive(Debug)]
pub enum NoteToggle {
    Started,
    /// Parou a nota em curso, que foi para a fila.
    Stopped(Box<QueuedRecording>),
}

/// Uma gravação que terminou sozinha e foi fechada pelo reaper.
#[derive(Debug)]
pub enum Reaped {
    /// As fontes de áudio caíram.
    SourcesEnded(QueuedRecording),
    /// A nota parou no silêncio e foi para a fila.
    NoteSaved(QueuedRecording),
    /// A nota não teve voz: saiu da fila e do disco.
    NoteDiscarded,
}

/// O medidor da nota em curso, para a janela.
#[derive(Clone, Debug, Serialize)]
pub struct NoteMeter {
    pub position_ms: i64,
    /// Os últimos níveis, de 0 a 1, do mais antigo ao mais novo.
    pub levels: [f32; METER_BARS],
    /// Quanto falta de silêncio para parar, enquanto a pessoa está calada.
    pub stops_in_ms: Option<u64>,
}

/// Quem iniciou a gravação em curso.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Origin {
    /// Iniciada pela detecção (política `auto` ou resposta à pergunta).
    pub auto: bool,
    /// App da reunião, quando veio da detecção.
    pub app: Option<AppKey>,
}

impl Origin {
    pub const MANUAL: Self = Self {
        auto: false,
        app: None,
    };

    pub fn detected(app: AppKey) -> Self {
        Self {
            auto: true,
            app: Some(app),
        }
    }
}

/// Um app de reunião, como a janela o mostra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MeetingView {
    pub app: AppKey,
    pub label: &'static str,
}

impl From<AppKey> for MeetingView {
    fn from(app: AppKey) -> Self {
        Self {
            app,
            label: app.label(),
        }
    }
}

/// O retrato do estado que a UI e a bandeja consomem.
#[derive(Clone, Debug, Serialize)]
pub struct StatusView {
    pub status: AppStatus,
    pub recording_id: Option<String>,
    pub recording_started_at: Option<i64>,
    /// Reunião ou nota, na gravação em curso.
    pub recording_kind: Option<Kind>,
    /// Silêncio que encerra uma nota, em segundos; `None` é "Nunca".
    pub note_silence_s: Option<u32>,
    /// A gravação em curso foi iniciada pela detecção.
    pub recording_auto: bool,
    /// App da reunião da gravação em curso.
    pub recording_app: Option<MeetingView>,
    /// Reunião detectada agora (depois do debounce).
    pub meeting: Option<MeetingView>,
    /// Pergunta "gravar esta reunião?" esperando resposta.
    pub pending_ask: Option<MeetingView>,
    /// Marcadores da gravação em curso.
    pub marker_count: u32,
    /// O último marcador da gravação em curso, cuja nota a janela deixa editar.
    pub last_marker: Option<Marker>,
    pub counts: QueueCounts,
    pub web_url: String,
    /// Aviso da última ação (fonte que faltou, erro ao gravar).
    pub notice: Option<String>,
    /// O que impede o sync (PAT ausente) ou o último erro dele.
    pub sync_notice: Option<String>,
}

/// A política de um app, como a tela de configurações a mostra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AppPolicyView {
    pub app: AppKey,
    pub label: &'static str,
    pub policy: Policy,
    /// A política de fábrica, para "Restaurar padrões".
    pub default_policy: Policy,
}

/// As gravações que ainda ocupam este computador, para a aba Armazenamento.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageInfo {
    pub dir: PathBuf,
    pub recordings: u32,
    pub bytes: u64,
}

/// Um atalho global, como a aba Áudio o mostra.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShortcutView {
    pub action: ShortcutAction,
    pub label: &'static str,
    pub keys: String,
    /// `None` antes do primeiro registro (no app, ele acontece na abertura).
    pub registration: Option<Registration>,
    /// "Em uso por outro app" ou "Indisponível nesta sessão".
    pub problem: Option<&'static str>,
}

/// O que a tela de configurações mostra. O PAT nunca volta à janela: só de onde ele vem.
#[derive(Clone, Debug, Serialize)]
pub struct SettingsView {
    pub web_url: String,
    pub api_url: Option<String>,
    pub ca_path: Option<PathBuf>,
    pub detection_enabled: bool,
    pub apps: Vec<AppPolicyView>,
    pub retention_days: Option<u32>,
    pub pat_source: Option<PatSource>,
    pub shortcuts: Vec<ShortcutView>,
}

/// O que a tela de configurações manda ao salvar.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SettingsInput {
    pub web_url: String,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub ca_path: Option<String>,
    pub detection_enabled: bool,
    #[serde(default)]
    pub policies: BTreeMap<AppKey, Policy>,
    pub retention_days: Option<u32>,
    /// PAT novo; vazio ou ausente mantém o guardado.
    #[serde(default)]
    pub pat: Option<String>,
    /// Esquecer o PAT guardado.
    #[serde(default)]
    pub clear_pat: bool,
    /// Atalhos novos; ausente mantém os de hoje.
    #[serde(default)]
    pub shortcuts: Option<Shortcuts>,
}

struct Inner {
    active: Option<ActiveRecording>,
    /// Quem iniciou `active`.
    origin: Option<Origin>,
    /// Há um início em curso (dispositivos abrindo), fora do lock.
    starting: bool,
    syncing: bool,
    config: Config,
    auto: AutoRecorder,
    notice: Option<String>,
    sync_notice: Option<String>,
    /// Como ficou o registro de cada atalho global.
    shortcut_registrations: Registrations,
    /// O pedido de cancelamento da importação em curso, se houver uma.
    importing: Option<Arc<AtomicBool>>,
}

impl Inner {
    fn recording(&self) -> Recording {
        match self.origin {
            None => Recording::Idle,
            Some(origin) if origin.auto => Recording::Auto,
            Some(_) => Recording::Manual,
        }
    }
}

pub struct AppState {
    queue: Arc<Mutex<Queue>>,
    recorder: RecorderConfig,
    config_path: PathBuf,
    pat: PatStore,
    inner: Mutex<Inner>,
}

/// Id de um arquivo importado: o instante da importação e um sufixo, como o das gravações.
fn import_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}-i{:04x}",
        now.as_millis(),
        (now.subsec_nanos() ^ std::process::id()) & 0xffff
    )
}

/// Texto vazio (ou só espaços) vira `None`.
fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl AppState {
    /// Abre a fila em `data_dir`, recupera gravações interrompidas e lê a config e o PAT de
    /// `config_dir`.
    pub fn open(data_dir: &Path, config_dir: &Path) -> Result<Self> {
        let queue = Queue::open(&data_dir.join("queue.sqlite"))?;
        let recovered = session::recover(&queue)?;
        let config_path = config_dir.join("config.json");
        let config = Config::load(&config_path);
        let state = Self::new(
            queue,
            RecorderConfig::new(data_dir.join("gravacoes")),
            config_path,
            config,
            PatStore::new(config_dir),
        );
        if !recovered.is_empty() {
            state.inner()?.notice = Some(format!(
                "{} gravação(ões) interrompida(s) recuperada(s)",
                recovered.len()
            ));
        }
        Ok(state)
    }

    pub fn new(
        queue: Queue,
        recorder: RecorderConfig,
        config_path: PathBuf,
        config: Config,
        pat: PatStore,
    ) -> Self {
        Self {
            queue: Arc::new(Mutex::new(queue)),
            recorder,
            config_path,
            pat,
            inner: Mutex::new(Inner {
                active: None,
                origin: None,
                starting: false,
                syncing: false,
                config,
                auto: AutoRecorder::default(),
                notice: None,
                sync_notice: None,
                shortcut_registrations: Registrations::new(),
                importing: None,
            }),
        }
    }

    fn inner(&self) -> Result<MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| anyhow!("estado do app envenenado por um pânico"))
    }

    fn lock_queue(&self) -> Result<MutexGuard<'_, Queue>> {
        self.queue
            .lock()
            .map_err(|_| anyhow!("fila envenenada por um pânico"))
    }

    /// A fila, para o laço de sync (`eclume_recorder::sync_pending`).
    pub fn queue(&self) -> &Mutex<Queue> {
        &self.queue
    }

    /// A fila compartilhada, para o uploader guardar o estado de retomada nela.
    pub fn shared_queue(&self) -> Arc<Mutex<Queue>> {
        Arc::clone(&self.queue)
    }

    pub fn status(&self) -> Result<AppStatus> {
        let inner = self.inner()?;
        Ok(if inner.active.is_some() {
            AppStatus::Recording
        } else if inner.syncing {
            AppStatus::Syncing
        } else {
            AppStatus::Idle
        })
    }

    pub fn view(&self) -> Result<StatusView> {
        let status = self.status()?;
        let inner = self.inner()?;
        let origin = inner.active.as_ref().and(inner.origin);
        let queue = self.lock_queue()?;
        let markers = match &inner.active {
            Some(active) => queue.markers(active.id())?,
            None => Vec::new(),
        };
        Ok(StatusView {
            status,
            recording_id: inner.active.as_ref().map(|a| a.id().to_string()),
            recording_started_at: inner.active.as_ref().map(ActiveRecording::started_at),
            recording_kind: inner.active.as_ref().map(ActiveRecording::kind),
            note_silence_s: inner.config.note_silence_s,
            recording_auto: origin.is_some_and(|o| o.auto),
            recording_app: origin.and_then(|o| o.app).map(MeetingView::from),
            meeting: inner.auto.meeting().map(MeetingView::from),
            pending_ask: inner.auto.pending_ask().map(MeetingView::from),
            marker_count: u32::try_from(markers.len()).unwrap_or(u32::MAX),
            last_marker: markers.into_iter().max_by_key(|m| m.created_at),
            counts: queue.counts()?,
            web_url: inner
                .config
                .effective_web_url(std::env::var(config::WEB_URL_ENV).ok()),
            notice: inner.notice.clone(),
            sync_notice: inner.sync_notice.clone(),
        })
    }

    /// Começa uma gravação manual com as fontes que `open` abrir; a pergunta pendente de uma
    /// reunião detectada sai da tela.
    pub fn start_recording(&self, open: impl FnOnce() -> Result<OpenedSources>) -> Result<()> {
        self.start_recording_as(Origin::MANUAL, open)?;
        self.inner()?.auto.on_manual_start();
        Ok(())
    }

    /// Começa a gravar, registrando quem iniciou e, se veio da detecção, o app da reunião.
    pub fn start_recording_as(
        &self,
        origin: Origin,
        open: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<()> {
        self.start(origin, StartOptions::MEETING, open)
    }

    /// "Nova nota": começa uma nota (só o microfone, parada pelo silêncio configurado) ou para a
    /// nota em curso. Com outra gravação em andamento, é [`Busy`].
    pub fn toggle_note(
        &self,
        open_mic: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<NoteToggle> {
        let silence = {
            let inner = self.inner()?;
            match &inner.active {
                Some(active) if active.kind() == Kind::Note => None,
                Some(_) => return Err(Busy.into()),
                None if inner.starting => return Err(Busy.into()),
                None => Some(inner.config.note_silence_s),
            }
        };
        let Some(silence) = silence else {
            return self
                .stop_recording()
                .map(|r| NoteToggle::Stopped(Box::new(r)));
        };
        let options = StartOptions::note(silence.map(|s| Duration::from_secs(u64::from(s))));
        self.start(Origin::MANUAL, options, open_mic)?;
        self.inner()?.auto.on_manual_start();
        Ok(NoteToggle::Started)
    }

    /// Marca o instante atual da gravação em curso: a posição no áudio, e não o relógio.
    pub fn add_marker(&self, note: Option<String>) -> Result<Marker> {
        let inner = self.inner()?;
        let active = inner
            .active
            .as_ref()
            .ok_or_else(|| anyhow!("nenhuma gravação em andamento"))?;
        let at_ms = active.progress().position_ms();
        self.lock_queue()?
            .add_marker(active.id(), at_ms, note.as_deref())
    }

    /// Troca a nota de um marcador enquanto a gravação não subiu.
    pub fn set_marker_note(&self, client_id: &str, note: Option<String>) -> Result<Marker> {
        self.lock_queue()?
            .set_marker_note(client_id, note.as_deref())
    }

    /// O medidor da nota em curso; `None` sem nota.
    pub fn note_meter(&self) -> Result<Option<NoteMeter>> {
        let inner = self.inner()?;
        Ok(inner
            .active
            .as_ref()
            .filter(|active| active.kind() == Kind::Note)
            .map(|active| {
                let progress = active.progress();
                NoteMeter {
                    position_ms: progress.position_ms(),
                    levels: progress.meter(),
                    stops_in_ms: progress.stops_in_ms(),
                }
            }))
    }

    fn start(
        &self,
        origin: Origin,
        options: StartOptions,
        open: impl FnOnce() -> Result<OpenedSources>,
    ) -> Result<()> {
        {
            let mut inner = self.inner()?;
            if inner.active.is_some() || inner.starting {
                return Err(Busy.into());
            }
            inner.starting = true;
        }
        // Abrir dispositivos pode levar segundos: sem segurar o estado, para a janela e a
        // bandeja seguirem respondendo enquanto isso.
        let opened = open();
        let mut inner = self.inner()?;
        inner.starting = false;
        let opened = match opened {
            Ok(opened) => opened,
            Err(err) => {
                inner.notice = Some(format!("{err:#}"));
                return Err(err);
            }
        };
        let queue = self.lock_queue()?;
        let active = session::start(&self.recorder, &queue, opened.sources, options)?;
        if let Some(app) = origin.app {
            queue.set_meeting_app(active.id(), app.meeting_app())?;
        }
        drop(queue);
        inner.notice = (!opened.missing.is_empty())
            .then(|| format!("gravando sem {}", opened.missing.join("; ")));
        inner.active = Some(active);
        inner.origin = Some(origin);
        Ok(())
    }

    /// Para a gravação em andamento e a entrega à fila.
    pub fn stop_recording(&self) -> Result<QueuedRecording> {
        let mut inner = self.inner()?;
        let active = inner
            .active
            .take()
            .ok_or_else(|| anyhow!("nenhuma gravação em andamento"))?;
        inner.origin = None;
        let result = active.stop(&*self.lock_queue()?);
        if let Err(err) = &result {
            inner.notice = Some(format!("falha ao fechar a gravação: {err:#}"));
        }
        result
    }

    /// Inicia (manual) ou para, conforme o estado.
    pub fn toggle_recording(&self, open: impl FnOnce() -> Result<OpenedSources>) -> Result<()> {
        if self.inner()?.active.is_some() {
            self.stop_recording().map(|_| ())
        } else {
            self.start_recording(open)
        }
    }

    /// Fecha a gravação que terminou sozinha: fontes que caíram, ou a nota que parou no
    /// silêncio. A nota sem voz sai da fila e do disco.
    pub fn reap_finished(&self) -> Result<Option<Reaped>> {
        let reason = {
            let inner = self.inner()?;
            match inner.active.as_ref() {
                Some(active) if active.is_finished() => active.progress().stop_reason(),
                _ => return Ok(None),
            }
        };
        let recording = self.stop_recording()?;
        Ok(Some(match reason {
            Some(StopReason::Silence) => Reaped::NoteSaved(recording),
            Some(StopReason::NoSpeech) => {
                self.lock_queue()?.discard(&recording.id)?;
                if let Err(err) = std::fs::remove_file(&recording.path) {
                    log::warn!("falha ao apagar {}: {err}", recording.path.display());
                }
                log::info!("nota {} descartada: sem voz", recording.id);
                Reaped::NoteDiscarded
            }
            _ => {
                self.inner()?.notice = Some("a gravação parou: as fontes de áudio caíram".into());
                Reaped::SourcesEnded(recording)
            }
        }))
    }

    /// Um evento do detector, pela máquina de gravação automática; o chamador executa a ação.
    pub fn on_meeting_event(&self, event: &MeetingEvent) -> Result<Action> {
        let mut inner = self.inner()?;
        let recording = inner.recording();
        let Inner { auto, config, .. } = &mut *inner;
        Ok(auto.on_event(event, &config.detection, recording))
    }

    /// A resposta à pergunta de reunião detectada; o chamador executa a ação.
    pub fn answer_meeting(&self, record: bool) -> Result<Action> {
        let mut inner = self.inner()?;
        let recording = inner.recording();
        Ok(inner.auto.answer(record, recording))
    }

    /// Liga ou desliga o estado de sincronização.
    pub fn set_syncing(&self, syncing: bool) -> Result<()> {
        self.inner()?.syncing = syncing;
        Ok(())
    }

    /// O que impede o sync, ou o último erro dele (`None` quando tudo andou).
    pub fn set_sync_notice(&self, notice: Option<String>) -> Result<()> {
        self.inner()?.sync_notice = notice;
        Ok(())
    }

    /// O que o uploader precisa; `None` sem PAT configurado.
    pub fn uploader_config(&self) -> Result<Option<UploaderConfig>> {
        let Some((pat, _)) = self.pat.load()? else {
            return Ok(None);
        };
        let inner = self.inner()?;
        Ok(Some(UploaderConfig {
            api_url: inner.config.effective_api_url(
                std::env::var(config::API_URL_ENV).ok(),
                std::env::var(config::WEB_URL_ENV).ok(),
            ),
            pat,
            ca_path: inner.config.ca_path.clone(),
            client_version: CLIENT_VERSION.to_string(),
        }))
    }

    /// Dias que o arquivo local fica depois da confirmação (`None`: para sempre).
    pub fn retention_days(&self) -> Result<Option<u32>> {
        Ok(self.inner()?.config.retention_days)
    }

    /// Se a detecção de reuniões está ligada.
    pub fn detection_enabled(&self) -> Result<bool> {
        Ok(self.inner()?.config.detection.enabled)
    }

    /// Os atalhos globais da config.
    pub fn shortcuts(&self) -> Result<Shortcuts> {
        Ok(self.inner()?.config.shortcuts.clone())
    }

    /// Guarda como ficou o registro dos atalhos, para a aba Áudio.
    pub fn set_shortcut_registrations(&self, registrations: Registrations) -> Result<()> {
        self.inner()?.shortcut_registrations = registrations;
        Ok(())
    }

    /// Marca o início de uma importação; só uma por vez.
    pub fn begin_import(&self) -> Result<Arc<AtomicBool>> {
        let mut inner = self.inner()?;
        if inner.importing.is_some() {
            bail!("Já há uma importação em andamento");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        inner.importing = Some(Arc::clone(&cancel));
        Ok(cancel)
    }

    /// Pede o cancelamento da importação em curso.
    pub fn cancel_import(&self) -> Result<()> {
        if let Some(cancel) = &self.inner()?.importing {
            cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn end_import(&self) {
        if let Ok(mut inner) = self.inner() {
            inner.importing = None;
        }
    }

    /// Converte `src` para `gravacoes/` (ou o copia) e o põe na fila, já pendente, com
    /// `source: upload`. `recorded_at` é o início confirmado ou digitado na janela.
    pub fn import_file(
        &self,
        src: &Path,
        recorded_at: i64,
        recorded_at_source: RecordedAtSource,
        cancel: &AtomicBool,
        progress: impl FnMut(f32),
    ) -> Result<QueuedRecording> {
        let probe = eclume_import::probe(src)?;
        if !probe.has_audio {
            bail!("{} não tem áudio", src.display());
        }
        let id = import_id();
        let converted = eclume_import::convert(src, &self.recorder.dir, &id, cancel, progress)?;
        let original_name = src
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone());
        let duration_ms = converted.duration_ms.or(probe.duration_ms).unwrap_or(0);
        let queue = self.lock_queue()?;
        queue.begin_import(&NewImport {
            id: &id,
            path: &converted.path,
            recorded_at,
            recorded_at_source,
            original_name: &original_name,
            content_type: (!converted.converted).then_some(converted.content_type.as_str()),
            duration_ms: i64::try_from(duration_ms).unwrap_or(i64::MAX),
            bytes: i64::try_from(converted.bytes).unwrap_or(i64::MAX),
        })?;
        queue
            .get(&id)?
            .ok_or_else(|| anyhow!("importação {id} sumiu da fila"))
    }

    /// A pasta das gravações.
    pub fn data_dir(&self) -> &Path {
        &self.recorder.dir
    }

    /// Quantas gravações (e quantos bytes) ainda estão na pasta local; os `.part` de uma
    /// conversão em curso não contam.
    pub fn storage_info(&self) -> Result<StorageInfo> {
        let mut info = StorageInfo {
            dir: self.recorder.dir.clone(),
            recordings: 0,
            bytes: 0,
        };
        let entries = match std::fs::read_dir(&self.recorder.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(info),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let entry = entry?;
            let meta = entry.metadata()?;
            let partial = entry.path().extension().is_some_and(|e| e == "part");
            if meta.is_file() && !partial {
                info.recordings += 1;
                info.bytes += meta.len();
            }
        }
        Ok(info)
    }

    pub fn recordings(&self, limit: u32) -> Result<Vec<QueuedRecording>> {
        self.lock_queue()?.list(limit)
    }

    pub fn web_url(&self) -> Result<String> {
        Ok(self.view()?.web_url)
    }

    pub fn settings(&self) -> Result<SettingsView> {
        let pat_source = self.pat.load()?.map(|(_, source)| source);
        let inner = self.inner()?;
        let config = &inner.config;
        Ok(SettingsView {
            web_url: config.web_url.clone(),
            api_url: config.api_url.clone(),
            ca_path: config.ca_path.clone(),
            detection_enabled: config.detection.enabled,
            apps: AppKey::ALL
                .into_iter()
                .map(|app| AppPolicyView {
                    app,
                    label: app.label(),
                    policy: config.detection.policy(app),
                    default_policy: default_policy(app),
                })
                .collect(),
            retention_days: config.retention_days,
            pat_source,
            shortcuts: ShortcutAction::ALL
                .into_iter()
                .map(|action| {
                    let registration = inner.shortcut_registrations.get(&action).copied();
                    ShortcutView {
                        action,
                        label: action.label(),
                        keys: config.shortcuts.get(action).to_string(),
                        registration,
                        problem: registration.and_then(Registration::label),
                    }
                })
                .collect(),
        })
    }

    /// Valida e grava a configuração e o PAT. Devolve a ação da detecção (tirar a pergunta
    /// pendente quando a política dela mudou).
    pub fn save_settings(&self, input: SettingsInput) -> Result<Action> {
        let mut next = self.inner()?.config.clone();
        next.web_url = input.web_url.trim().to_string();
        next.api_url = non_empty(input.api_url);
        next.ca_path = non_empty(input.ca_path).map(PathBuf::from);
        next.detection.enabled = input.detection_enabled;
        next.detection.policies = input.policies;
        next.retention_days = input.retention_days;
        if let Some(shortcuts) = input.shortcuts {
            next.shortcuts = Shortcuts {
                record: shortcuts.record.trim().to_string(),
                note: shortcuts.note.trim().to_string(),
                marker: shortcuts.marker.trim().to_string(),
            };
        }
        next.validate()?;

        if input.clear_pat {
            self.pat.clear()?;
        } else if let Some(pat) = non_empty(input.pat) {
            if self.pat.save(&pat)? == PatSource::File {
                self.inner()?.notice = Some(
                    "chaveiro do sistema indisponível: o PAT ficou num arquivo só seu, no \
                     diretório de configuração"
                        .into(),
                );
            }
        }
        next.save(&self.config_path)?;
        let mut inner = self.inner()?;
        let action = inner.auto.on_config_change(&next.detection);
        inner.config = next;
        Ok(action)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use anyhow::bail;
    use eclume_recorder::source::{ScriptedSource, SineSource};
    use eclume_recorder::Status;

    use super::*;

    /// Chaveiro indisponível: o PAT vai ao arquivo, como numa sessão sem Secret Service.
    struct NoKeyring;

    impl eclume_sync::pat::SecretBackend for NoKeyring {
        fn get(&self) -> Result<Option<String>> {
            bail!("sem chaveiro")
        }
        fn set(&self, _: &str) -> Result<()> {
            bail!("sem chaveiro")
        }
        fn delete(&self) -> Result<()> {
            Ok(())
        }
    }

    fn state(name: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("eclume-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = AppState::new(
            Queue::open_in_memory().unwrap(),
            RecorderConfig::new(dir.join("gravacoes")),
            dir.join("config.json"),
            Config::default(),
            PatStore::with_backend(dir.join("pat"), Box::new(NoKeyring), None),
        );
        (state, dir)
    }

    fn sine_sources(seconds: u64) -> Result<OpenedSources> {
        Ok(OpenedSources {
            sources: vec![Box::new(SineSource::new(
                48_000,
                440.0,
                0.3,
                Duration::from_secs(seconds),
            ))],
            missing: vec!["áudio do sistema: teste".into()],
        })
    }

    fn settings_input(state: &AppState) -> SettingsInput {
        let view = state.settings().unwrap();
        SettingsInput {
            web_url: view.web_url,
            api_url: view.api_url,
            ca_path: None,
            detection_enabled: view.detection_enabled,
            policies: BTreeMap::new(),
            retention_days: view.retention_days,
            pat: None,
            clear_pat: false,
            shortcuts: None,
        }
    }

    #[test]
    fn estado_alterna_entre_ocioso_gravando_e_ocioso() {
        let (state, dir) = state("alterna");
        assert_eq!(state.status().unwrap(), AppStatus::Idle);

        state.toggle_recording(|| sine_sources(60)).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.status, AppStatus::Recording);
        assert!(view.recording_id.is_some());
        assert!(!view.recording_auto);
        assert_eq!(
            view.notice.as_deref(),
            Some("gravando sem áudio do sistema: teste")
        );
        assert!(state.start_recording(|| sine_sources(1)).is_err());

        state.toggle_recording(|| sine_sources(1)).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.status, AppStatus::Idle);
        assert_eq!(view.counts.pending, 1);
        assert_eq!(state.recordings(10).unwrap()[0].status, Status::Pending);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Espera o reaper fechar a gravação que terminou sozinha.
    fn reap(state: &AppState) -> Reaped {
        for _ in 0..4_000 {
            if let Some(reaped) = state.reap_finished().unwrap() {
                return reaped;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("a gravação não terminou sozinha");
    }

    /// Um microfone sintético: fala por `speech_ms` e depois silêncio, até `total_ms`.
    fn mic(speech_ms: u64, total_ms: u64) -> Result<OpenedSources> {
        let chunks = (0..total_ms / 10).map(move |i| {
            let t = i * 10;
            Some(
                (0..160u64)
                    .map(|n| {
                        if t < speech_ms && t % 300 < 200 {
                            0.3 * (2.0 * std::f32::consts::PI * 220.0 * (t * 16 + n) as f32
                                / 16_000.0)
                                .sin()
                        } else {
                            0.0
                        }
                    })
                    .collect(),
            )
        });
        Ok(OpenedSources {
            sources: vec![Box::new(ScriptedSource::new(16_000, chunks))],
            missing: Vec::new(),
        })
    }

    #[test]
    fn estado_fecha_gravacao_cujas_fontes_acabaram() {
        let (state, dir) = state("colhe");
        state.start_recording(|| sine_sources(0)).unwrap();
        assert!(matches!(reap(&state), Reaped::SourcesEnded(_)));
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(state.view().unwrap().counts.pending, 1);
        assert!(state.reap_finished().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nota_para_no_silencio_e_vai_para_a_fila_como_nota() {
        let (state, dir) = state("nota");
        state.inner().unwrap().config = Config {
            note_silence_s: Some(2),
            ..Config::default()
        };
        assert!(matches!(
            state.toggle_note(|| mic(1_000, 60_000)).unwrap(),
            NoteToggle::Started
        ));
        let view = state.view().unwrap();
        assert_eq!(view.recording_kind, Some(Kind::Note));
        assert_eq!(view.note_silence_s, Some(2));
        assert!(state.note_meter().unwrap().is_some());

        let Reaped::NoteSaved(recording) = reap(&state) else {
            panic!("a nota devia parar no silêncio");
        };
        assert_eq!(recording.kind, Kind::Note);
        assert!(recording.path.exists());
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert!(state.note_meter().unwrap().is_none());
        assert_eq!(state.recordings(10).unwrap()[0].kind, Kind::Note);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nota_sem_voz_e_descartada_da_fila_e_do_disco() {
        let (state, dir) = state("nota-muda");
        state.toggle_note(|| mic(0, 60_000)).unwrap();
        let path = state.recorder.dir.clone();
        assert!(matches!(reap(&state), Reaped::NoteDiscarded));
        assert!(state.recordings(10).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(path).unwrap().count(), 0);
        assert_eq!(state.view().unwrap().notice, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nova_nota_de_novo_para_a_nota_e_nunca_descarta() {
        let (state, dir) = state("nota-manual");
        state.toggle_note(|| mic(0, 600_000)).unwrap();
        let NoteToggle::Stopped(recording) = state.toggle_note(|| mic(0, 1)).unwrap() else {
            panic!("a segunda Nova nota devia parar a primeira");
        };
        assert_eq!(recording.kind, Kind::Note);
        assert_eq!(state.recordings(10).unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn marcadores_na_posicao_do_audio_com_nota_editavel() {
        let (state, dir) = state("marcadores");
        assert!(
            state.add_marker(None).is_err(),
            "sem gravação não há marcador"
        );
        state.start_recording(|| sine_sources(60)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let first = state.add_marker(None).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let second = state
            .add_marker(Some("decisão do orçamento".into()))
            .unwrap();
        assert!(first.at_ms > 0);
        assert!(
            second.at_ms > first.at_ms,
            "{} ≤ {}",
            second.at_ms,
            first.at_ms
        );

        let view = state.view().unwrap();
        assert_eq!(view.marker_count, 2);
        assert_eq!(view.last_marker.as_ref(), Some(&second));
        let edited = state
            .set_marker_note(&first.client_id, Some("ação".into()))
            .unwrap();
        assert_eq!(edited.note.as_deref(), Some("ação"));

        let recording = state.stop_recording().unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.marker_count, 0);
        assert!(view.last_marker.is_none());
        let saved = state
            .queue()
            .lock()
            .unwrap()
            .markers(&recording.id)
            .unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].note.as_deref(), Some("ação"));
        // Enquanto não subiu, a nota ainda muda.
        state.set_marker_note(&second.client_id, None).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nova_nota_durante_uma_reuniao_e_ocupado() {
        let (state, dir) = state("nota-ocupado");
        state.start_recording(|| sine_sources(60)).unwrap();
        let err = state.toggle_note(|| mic(0, 1)).unwrap_err();
        assert!(err.is::<Busy>());
        assert_eq!(err.to_string(), "Já há uma gravação em andamento");
        assert_eq!(state.view().unwrap().recording_kind, Some(Kind::Meeting));
        assert!(state.note_meter().unwrap().is_none());
        state.stop_recording().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn estado_sem_fontes_registra_o_aviso() {
        let (state, _dir) = state("sem-fontes");
        assert!(state.start_recording(|| bail!("nenhuma fonte")).is_err());
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(
            state.view().unwrap().notice.as_deref(),
            Some("nenhuma fonte")
        );
        assert!(state.stop_recording().is_err());
    }

    #[test]
    fn gravacao_da_deteccao_guarda_o_app_e_para_no_fim_da_reuniao() {
        let (state, dir) = state("auto");
        let started = MeetingEvent::Started {
            app: "teams".into(),
        };
        // Política padrão: perguntar.
        assert_eq!(
            state.on_meeting_event(&started).unwrap(),
            Action::Ask(AppKey::Teams)
        );
        let view = state.view().unwrap();
        assert_eq!(view.pending_ask.map(|a| a.app), Some(AppKey::Teams));
        assert_eq!(view.meeting.map(|m| m.label), Some("Microsoft Teams"));

        assert_eq!(
            state.answer_meeting(true).unwrap(),
            Action::Start(AppKey::Teams)
        );
        state
            .start_recording_as(Origin::detected(AppKey::Teams), || sine_sources(60))
            .unwrap();
        let view = state.view().unwrap();
        assert!(view.recording_auto);
        assert_eq!(view.recording_app.map(|a| a.app), Some(AppKey::Teams));
        assert!(view.pending_ask.is_none());

        assert_eq!(
            state.on_meeting_event(&MeetingEvent::Ended).unwrap(),
            Action::Stop
        );
        let recording = state.stop_recording().unwrap();
        assert_eq!(recording.meeting_app.as_deref(), Some("teams"));
        assert!(!state.view().unwrap().recording_auto);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn gravacao_manual_tira_a_pergunta_e_nao_para_com_a_reuniao() {
        let (state, dir) = state("manual");
        state
            .on_meeting_event(&MeetingEvent::Started { app: "zoom".into() })
            .unwrap();
        state.start_recording(|| sine_sources(60)).unwrap();
        assert!(state.view().unwrap().pending_ask.is_none());
        assert_eq!(
            state.on_meeting_event(&MeetingEvent::Ended).unwrap(),
            Action::None
        );
        let recording = state.stop_recording().unwrap();
        assert_eq!(recording.meeting_app, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn configuracoes_gravam_config_e_pat_e_validam() {
        let (state, dir) = state("config");
        assert!(state.uploader_config().unwrap().is_none());
        assert_eq!(state.settings().unwrap().pat_source, None);

        let mut input = settings_input(&state);
        input.web_url = "https://eclume.exemplo:8443".into();
        input.api_url = Some("  ".into());
        input.retention_days = Some(0);
        input.policies.insert(AppKey::Zoom, Policy::Auto);
        input.pat = Some("eclp_segredo".into());
        assert_eq!(state.save_settings(input).unwrap(), Action::None);

        let saved = Config::load(&dir.join("config.json"));
        assert_eq!(saved.web_url, "https://eclume.exemplo:8443");
        assert_eq!(saved.api_url, None);
        assert_eq!(saved.retention_days, Some(0));
        assert_eq!(saved.detection.policy(AppKey::Zoom), Policy::Auto);
        let settings = state.settings().unwrap();
        assert_eq!(settings.pat_source, Some(PatSource::File));
        assert!(!serde_json::to_string(&settings)
            .unwrap()
            .contains("eclp_segredo"));
        assert!(state.view().unwrap().notice.unwrap().contains("chaveiro"));
        let uploader = state.uploader_config().unwrap().unwrap();
        assert_eq!(uploader.pat, "eclp_segredo");
        assert_eq!(uploader.client_version, CLIENT_VERSION);

        let mut bad = settings_input(&state);
        bad.web_url = "sem-esquema".into();
        assert!(state.save_settings(bad).is_err());
        let mut bad_pat = settings_input(&state);
        bad_pat.pat = Some("ghp_x".into());
        assert!(state.save_settings(bad_pat).is_err());

        let mut clear = settings_input(&state);
        clear.clear_pat = true;
        state.save_settings(clear).unwrap();
        assert!(state.uploader_config().unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn configuracoes_trocam_os_atalhos_e_mostram_o_registro() {
        let (state, dir) = state("atalhos");
        let view = state.settings().unwrap();
        assert_eq!(view.shortcuts.len(), 3);
        assert_eq!(view.shortcuts[0].keys, Shortcuts::default().record);
        assert_eq!(view.shortcuts[0].registration, None);

        let mut input = settings_input(&state);
        input.shortcuts = Some(Shortcuts {
            marker: " Ctrl+Alt+J ".into(),
            ..Shortcuts::default()
        });
        state.save_settings(input).unwrap();
        assert_eq!(state.shortcuts().unwrap().marker, "Ctrl+Alt+J");
        assert_eq!(
            Config::load(&dir.join("config.json")).shortcuts.marker,
            "Ctrl+Alt+J"
        );

        let mut repeated = settings_input(&state);
        repeated.shortcuts = Some(Shortcuts {
            note: "Ctrl+Alt+J".into(),
            marker: "Ctrl+Alt+J".into(),
            ..Shortcuts::default()
        });
        assert!(state.save_settings(repeated).is_err());
        assert_eq!(state.shortcuts().unwrap().note, Shortcuts::default().note);

        state
            .set_shortcut_registrations(Registrations::from([
                (ShortcutAction::Record, Registration::Registered),
                (ShortcutAction::Note, Registration::InUse),
                (ShortcutAction::Marker, Registration::Unavailable),
            ]))
            .unwrap();
        let problems: Vec<_> = state
            .settings()
            .unwrap()
            .shortcuts
            .into_iter()
            .map(|s| s.problem)
            .collect();
        assert_eq!(
            problems,
            [
                None,
                Some("Em uso por outro app"),
                Some("Indisponível nesta sessão")
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/import/tests/fixtures")
            .join(name)
    }

    #[test]
    fn importar_converte_e_poe_na_fila_como_upload() {
        let (state, dir) = state("importa");
        let cancel = state.begin_import().unwrap();
        assert!(state.begin_import().is_err(), "uma importação por vez");
        let mut steps = Vec::new();
        let recording = state
            .import_file(
                &fixture("tom.mp3"),
                1_789_826_520_000,
                RecordedAtSource::User,
                &cancel,
                |f| steps.push(f),
            )
            .unwrap();
        state.end_import();
        assert_eq!(steps.last(), Some(&1.0));
        assert_eq!(recording.status, Status::Pending);
        assert_eq!(recording.source, eclume_recorder::Source::Upload);
        assert_eq!(recording.kind, Kind::Meeting);
        assert_eq!(recording.recorded_at_source, RecordedAtSource::User);
        assert_eq!(recording.started_at, 1_789_826_520_000);
        assert_eq!(recording.original_name.as_deref(), Some("tom"));
        assert_eq!(recording.content_type, None);
        assert!(recording.path.starts_with(dir.join("gravacoes")));
        assert!(recording.path.exists());
        assert!(recording.duration_ms.unwrap() > 1_900);

        let avi = state
            .import_file(
                &fixture("tom.avi"),
                0,
                RecordedAtSource::FileMetadata,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        assert_eq!(avi.content_type.as_deref(), Some("video/x-msvideo"));
        assert_eq!(state.view().unwrap().counts.pending, 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn importar_sem_audio_ou_cancelado_nao_entra_na_fila() {
        let (state, dir) = state("importa-nao");
        let err = state
            .import_file(
                &fixture("sem-audio.mp4"),
                0,
                RecordedAtSource::User,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap_err();
        assert!(err.to_string().contains("não tem áudio"), "{err}");

        let cancel = state.begin_import().unwrap();
        state.cancel_import().unwrap();
        let err = state
            .import_file(
                &fixture("tom.wav"),
                0,
                RecordedAtSource::User,
                &cancel,
                |_| {},
            )
            .unwrap_err();
        assert!(err.is::<eclume_import::Cancelled>());
        state.end_import();
        assert!(state.begin_import().is_ok());
        assert!(state.recordings(10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn armazenamento_conta_as_gravacoes_da_pasta_local() {
        let (state, dir) = state("armazenamento");
        let vazio = state.storage_info().unwrap();
        assert_eq!((vazio.recordings, vazio.bytes), (0, 0));
        assert_eq!(vazio.dir, dir.join("gravacoes"));
        std::fs::create_dir_all(state.data_dir()).unwrap();
        std::fs::write(state.data_dir().join("a.ogg"), [0u8; 100]).unwrap();
        std::fs::write(state.data_dir().join("b.avi"), [0u8; 50]).unwrap();
        std::fs::write(state.data_dir().join("c.ogg.part"), [0u8; 999]).unwrap();
        let info = state.storage_info().unwrap();
        assert_eq!((info.recordings, info.bytes), (2, 150));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn configuracoes_trazem_a_politica_de_fabrica() {
        let (state, _dir) = state("fabrica");
        let apps = state.settings().unwrap().apps;
        assert_eq!(apps.len(), 7);
        let outro = apps.iter().find(|a| a.app == AppKey::Outro).unwrap();
        assert_eq!(outro.default_policy, Policy::Ignore);
        let teams = apps.iter().find(|a| a.app == AppKey::Teams).unwrap();
        assert_eq!(teams.default_policy, Policy::Ask);
    }

    #[test]
    fn mudar_a_politica_tira_a_pergunta_pendente() {
        let (state, dir) = state("politica");
        state
            .on_meeting_event(&MeetingEvent::Started { app: "meet".into() })
            .unwrap();
        let mut input = settings_input(&state);
        input.policies.insert(AppKey::Meet, Policy::Ignore);
        assert_eq!(state.save_settings(input).unwrap(), Action::Dismiss);
        assert!(state.view().unwrap().pending_ask.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn estado_sincronizando_e_aviso_do_sync() {
        let (state, _dir) = state("sync");
        state.set_syncing(true).unwrap();
        assert_eq!(state.status().unwrap(), AppStatus::Syncing);
        assert_eq!(AppStatus::Syncing.label(), "Sincronizando");
        state.set_sync_notice(Some("sem PAT".into())).unwrap();
        assert_eq!(
            state.view().unwrap().sync_notice.as_deref(),
            Some("sem PAT")
        );
        assert_eq!(state.retention_days().unwrap(), Some(7));
        assert!(state.detection_enabled().unwrap());
    }
}
