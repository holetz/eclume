//! Estado do app: a gravação em andamento (e quem a iniciou), a fila, a configuração, o PAT e a
//! detecção de reuniões.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{anyhow, bail, Result};
use eclume_detect::{Action, AppKey, AutoRecorder, Policy, Recording};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig};
use eclume_recorder::{MeetingEvent, Queue, QueueCounts, QueuedRecording};
use eclume_sync::{PatSource, PatStore, UploaderConfig};
use serde::{Deserialize, Serialize};

use crate::capture::OpenedSources;
use crate::config::{self, Config};

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
    /// A gravação em curso foi iniciada pela detecção.
    pub recording_auto: bool,
    /// App da reunião da gravação em curso.
    pub recording_app: Option<MeetingView>,
    /// Reunião detectada agora (depois do debounce).
    pub meeting: Option<MeetingView>,
    /// Pergunta "gravar esta reunião?" esperando resposta.
    pub pending_ask: Option<MeetingView>,
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
        Ok(StatusView {
            status,
            recording_id: inner.active.as_ref().map(|a| a.id().to_string()),
            recording_started_at: inner.active.as_ref().map(ActiveRecording::started_at),
            recording_auto: origin.is_some_and(|o| o.auto),
            recording_app: origin.and_then(|o| o.app).map(MeetingView::from),
            meeting: inner.auto.meeting().map(MeetingView::from),
            pending_ask: inner.auto.pending_ask().map(MeetingView::from),
            counts: self.lock_queue()?.counts()?,
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
        {
            let mut inner = self.inner()?;
            if inner.active.is_some() || inner.starting {
                bail!("já há uma gravação em andamento");
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
        let active = session::start(&self.recorder, &queue, opened.sources)?;
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

    /// Fecha a gravação que terminou sozinha (todas as fontes caíram). Devolve se fechou alguma.
    pub fn reap_finished(&self) -> Result<bool> {
        let finished = self
            .inner()?
            .active
            .as_ref()
            .is_some_and(ActiveRecording::is_finished);
        if finished {
            self.stop_recording()?;
            self.inner()?.notice = Some("a gravação parou: as fontes de áudio caíram".into());
        }
        Ok(finished)
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
                })
                .collect(),
            retention_days: config.retention_days,
            pat_source,
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

    use eclume_recorder::source::SineSource;
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

    #[test]
    fn estado_fecha_gravacao_cujas_fontes_acabaram() {
        let (state, dir) = state("colhe");
        state.start_recording(|| sine_sources(0)).unwrap();
        while !state.reap_finished().unwrap() {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(state.status().unwrap(), AppStatus::Idle);
        assert_eq!(state.view().unwrap().counts.pending, 1);
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
