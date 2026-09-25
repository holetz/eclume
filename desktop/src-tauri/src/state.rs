//! Estado do app: a gravação em andamento, a fila e a configuração.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Result};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig};
use eclume_recorder::{Queue, QueueCounts, QueuedRecording};
use serde::Serialize;

use crate::capture::OpenedSources;
use crate::config::{self, Config};

/// O que a bandeja mostra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppStatus {
    Idle,
    Recording,
    /// Enviando gravações ao servidor; quem liga é o sync da spec `desktop-deteccao-e-sync`.
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

/// O retrato do estado que a UI e a bandeja consomem.
#[derive(Clone, Debug, Serialize)]
pub struct StatusView {
    pub status: AppStatus,
    pub recording_id: Option<String>,
    pub recording_started_at: Option<i64>,
    pub counts: QueueCounts,
    pub web_url: String,
    /// Aviso da última ação (fonte que faltou, erro ao gravar).
    pub notice: Option<String>,
}

struct Inner {
    active: Option<ActiveRecording>,
    /// Há um início em curso (dispositivos abrindo), fora do lock.
    starting: bool,
    syncing: bool,
    config: Config,
    notice: Option<String>,
}

pub struct AppState {
    queue: Mutex<Queue>,
    recorder: RecorderConfig,
    config_path: PathBuf,
    inner: Mutex<Inner>,
}

impl AppState {
    /// Abre a fila em `data_dir`, recupera gravações interrompidas e lê a config de `config_dir`.
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
    ) -> Self {
        Self {
            queue: Mutex::new(queue),
            recorder,
            config_path,
            inner: Mutex::new(Inner {
                active: None,
                starting: false,
                syncing: false,
                config,
                notice: None,
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

    /// A fila, para o sync da spec `desktop-deteccao-e-sync` (`eclume_recorder::sync_pending`).
    pub fn queue(&self) -> &Mutex<Queue> {
        &self.queue
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
        Ok(StatusView {
            status,
            recording_id: inner.active.as_ref().map(|a| a.id().to_string()),
            recording_started_at: inner.active.as_ref().map(ActiveRecording::started_at),
            counts: self.lock_queue()?.counts()?,
            web_url: inner
                .config
                .effective_web_url(std::env::var(config::WEB_URL_ENV).ok()),
            notice: inner.notice.clone(),
        })
    }

    /// Começa a gravar com as fontes que `open` abrir.
    pub fn start_recording(&self, open: impl FnOnce() -> Result<OpenedSources>) -> Result<()> {
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
        let active = session::start(&self.recorder, &*self.lock_queue()?, opened.sources)?;
        inner.notice = (!opened.missing.is_empty())
            .then(|| format!("gravando sem {}", opened.missing.join("; ")));
        inner.active = Some(active);
        Ok(())
    }

    /// Para a gravação em andamento e a entrega à fila.
    pub fn stop_recording(&self) -> Result<QueuedRecording> {
        let mut inner = self.inner()?;
        let active = inner
            .active
            .take()
            .ok_or_else(|| anyhow!("nenhuma gravação em andamento"))?;
        let result = active.stop(&*self.lock_queue()?);
        if let Err(err) = &result {
            inner.notice = Some(format!("falha ao fechar a gravação: {err:#}"));
        }
        result
    }

    /// Inicia ou para, conforme o estado.
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

    /// Liga ou desliga o estado de sincronização (usado pelo sync da spec seguinte).
    pub fn set_syncing(&self, syncing: bool) -> Result<()> {
        self.inner()?.syncing = syncing;
        Ok(())
    }

    pub fn recordings(&self, limit: u32) -> Result<Vec<QueuedRecording>> {
        self.lock_queue()?.list(limit)
    }

    pub fn web_url(&self) -> Result<String> {
        Ok(self.view()?.web_url)
    }

    /// Troca o endereço do eclume web e o grava na config.
    pub fn set_web_url(&self, url: &str) -> Result<()> {
        config::validate_web_url(url)?;
        let mut inner = self.inner()?;
        let mut next = inner.config.clone();
        next.web_url = url.to_string();
        next.save(&self.config_path)?;
        inner.config = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use eclume_recorder::source::SineSource;
    use eclume_recorder::Status;

    use super::*;

    fn state(name: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("eclume-state-{name}-{}", std::process::id()));
        let state = AppState::new(
            Queue::open_in_memory().unwrap(),
            RecorderConfig::new(dir.join("gravacoes")),
            dir.join("config.json"),
            Config::default(),
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

    #[test]
    fn estado_alterna_entre_ocioso_gravando_e_ocioso() {
        let (state, dir) = state("alterna");
        assert_eq!(state.status().unwrap(), AppStatus::Idle);

        state.toggle_recording(|| sine_sources(60)).unwrap();
        let view = state.view().unwrap();
        assert_eq!(view.status, AppStatus::Recording);
        assert!(view.recording_id.is_some());
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
    fn estado_sincronizando_e_troca_de_endereco() {
        let (state, dir) = state("url");
        state.set_syncing(true).unwrap();
        assert_eq!(state.status().unwrap(), AppStatus::Syncing);
        assert_eq!(AppStatus::Syncing.label(), "Sincronizando");

        assert!(state.set_web_url("sem-esquema").is_err());
        state.set_web_url("https://eclume.exemplo:8443").unwrap();
        assert_eq!(
            Config::load(&dir.join("config.json")).web_url,
            "https://eclume.exemplo:8443"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
