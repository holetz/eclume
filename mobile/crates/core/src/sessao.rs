//! A sessão de gravação do celular, sobre o `eclume-recorder`: gravar, pausar sem fechar o
//! microfone, marcar pelo tempo de áudio, parar deixando a folha "Gravação salva" segurar o sync
//! e salvar título e tipo de agenda. A queda do processo é acertada por `recuperar` na abertura
//! seguinte ("A gravação fica salva se o celular desligar").

use std::sync::{Mutex, MutexGuard};

use anyhow::{anyhow, bail, Context, Result};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig, StartOptions};
use eclume_recorder::{AudioSource, Marker, Queue, QueuedRecording};
use serde::Serialize;

/// A gravação em curso, como a UI e a notificação a mostram.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EstadoSessao {
    pub id: String,
    /// Início, em ms Unix.
    pub iniciada_em: i64,
    /// O tempo de áudio (sem as pausas).
    pub audio_ms: i64,
    /// Nível RMS de 0 a 1.
    pub nivel: f32,
    pub pausada: bool,
    pub marcadores: Vec<Marker>,
}

/// A sessão: no máximo uma gravação por vez.
#[derive(Default)]
pub struct Sessao {
    ativa: Option<ActiveRecording>,
}

fn trancar(fila: &Mutex<Queue>) -> Result<MutexGuard<'_, Queue>> {
    fila.lock()
        .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
}

impl Sessao {
    pub fn gravando(&self) -> bool {
        self.ativa.is_some()
    }

    /// Começa a gravar a fonte (o microfone, ou uma fonte sintética nos testes). Devolve o id.
    pub fn gravar(
        &mut self,
        config: &RecorderConfig,
        fila: &Mutex<Queue>,
        fonte: Box<dyn AudioSource>,
    ) -> Result<String> {
        if self.ativa.is_some() {
            bail!("Já há uma gravação em andamento");
        }
        let ativa = session::start(config, &*trancar(fila)?, vec![fonte], StartOptions::MEETING)?;
        let id = ativa.id().to_string();
        self.ativa = Some(ativa);
        Ok(id)
    }

    fn ativa(&self) -> Result<&ActiveRecording> {
        self.ativa.as_ref().context("nenhuma gravação em andamento")
    }

    pub fn pausar(&self) -> Result<()> {
        self.ativa()?.set_paused(true);
        Ok(())
    }

    pub fn continuar(&self) -> Result<()> {
        self.ativa()?.set_paused(false);
        Ok(())
    }

    /// Marca o instante atual no áudio, na hora; a nota pode vir depois por [`Self::anotar`].
    pub fn marcar(&self, fila: &Mutex<Queue>, nota: Option<&str>) -> Result<Marker> {
        let ativa = self.ativa()?;
        trancar(fila)?.add_marker(ativa.id(), ativa.audio_ms(), nota)
    }

    /// A nota de um marcador (vazia apaga), enquanto a gravação não subiu.
    pub fn anotar(fila: &Mutex<Queue>, client_id: &str, nota: Option<&str>) -> Result<Marker> {
        trancar(fila)?.set_marker_note(client_id, nota)
    }

    /// Para, fecha o arquivo e entrega à fila (com `details_pending`, se a config pede).
    pub fn parar(&mut self, fila: &Mutex<Queue>) -> Result<QueuedRecording> {
        let ativa = self.ativa.take().context("nenhuma gravação em andamento")?;
        ativa.stop(&*trancar(fila)?)
    }

    /// A gravação terminou sozinha (o microfone caiu): o chamador a fecha com [`Self::parar`].
    pub fn terminou_sozinha(&self) -> bool {
        self.ativa
            .as_ref()
            .is_some_and(ActiveRecording::is_finished)
    }

    /// Título e tipo de agenda da folha "Gravação salva" ("Pular" passa os dois vazios).
    pub fn salvar(
        fila: &Mutex<Queue>,
        id: &str,
        titulo: Option<&str>,
        tipo_de_agenda_id: Option<&str>,
    ) -> Result<()> {
        trancar(fila)?.save_details(id, titulo, tipo_de_agenda_id)
    }

    /// Acerta, na abertura, a gravação que uma queda do processo deixou em `recording`.
    pub fn recuperar(fila: &Mutex<Queue>) -> Result<Vec<QueuedRecording>> {
        session::recover(&*trancar(fila)?)
    }

    pub fn estado(&self, fila: &Mutex<Queue>) -> Result<Option<EstadoSessao>> {
        let Some(ativa) = &self.ativa else {
            return Ok(None);
        };
        Ok(Some(EstadoSessao {
            id: ativa.id().to_string(),
            iniciada_em: ativa.started_at(),
            audio_ms: ativa.audio_ms(),
            nivel: ativa.level(),
            pausada: ativa.is_paused(),
            marcadores: trancar(fila)?.markers(ativa.id())?,
        }))
    }
}
