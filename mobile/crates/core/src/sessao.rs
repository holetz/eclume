//! A sessão de gravação do celular, sobre o `eclume-recorder`: gravar, pausar sem fechar o
//! microfone, marcar pelo tempo de áudio, parar deixando a folha "Gravação salva" segurar o sync
//! e salvar título e tipo de agenda. A queda do processo é acertada por `recuperar` na abertura
//! seguinte ("A gravação fica salva se o celular desligar").
//!
//! O microfone que cai (fone plugado ou tirado, Bluetooth) se reconecta dentro da fonte
//! (`eclume_audio_capture::reconnect`): a gravação segue no mesmo arquivo, com silêncio no meio, e
//! a sessão mostra `microfone: reconectando`. Uma queda acima de 5 s e a volta viram marcadores
//! automáticos, assim como o silêncio imposto pelo sistema (API 29+, `silenciada`).

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig, StartOptions};
use eclume_recorder::{AudioSource, Marker, Queue, QueuedRecording, SourceState};
use serde::Serialize;

/// Quanto o microfone pode ficar fora antes do marcador "microfone perdido".
const MICROFONE_FORA_APOS: Duration = Duration::from_secs(5);

/// Como está o microfone da gravação em curso.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EstadoMicrofone {
    Ok,
    /// Caiu e a fonte tenta reabrir; o arquivo recebe silêncio enquanto isso.
    Reconectando,
}

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
    pub microfone: EstadoMicrofone,
    /// O sistema silenciou a captura (chamada, assistente de voz, bloqueio do microfone).
    pub silenciada: bool,
}

/// A sessão: no máximo uma gravação por vez.
#[derive(Default)]
pub struct Sessao {
    ativa: Option<ActiveRecording>,
    /// A queda do microfone já virou marcador.
    microfone_marcado: bool,
    silenciada: bool,
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
        self.microfone_marcado = false;
        self.silenciada = false;
        Ok(id)
    }

    /// Desde quando o microfone está fora, se está.
    fn microfone_fora_desde(&self) -> Option<std::time::Instant> {
        self.ativa
            .as_ref()?
            .progress()
            .source_states()
            .into_iter()
            .find_map(|estado| match estado {
                SourceState::Reconnecting { since } => Some(since),
                SourceState::Live => None,
            })
    }

    /// Vigia o microfone (chamada pelo laço do app): uma queda acima de 5 s marca "microfone
    /// perdido" no instante da queda, e a volta marca "microfone de volta".
    pub fn vigiar(&mut self, fila: &Mutex<Queue>) -> Result<()> {
        let Some(ativa) = &self.ativa else {
            return Ok(());
        };
        let audio_ms = ativa.audio_ms();
        match (self.microfone_fora_desde(), self.microfone_marcado) {
            (Some(desde), false) if desde.elapsed() >= MICROFONE_FORA_APOS => {
                let fora_ms = i64::try_from(desde.elapsed().as_millis()).unwrap_or(i64::MAX);
                let em = audio_ms.saturating_sub(fora_ms).max(0);
                trancar(fila)?.add_marker(ativa.id(), em, Some("microfone perdido"))?;
                self.microfone_marcado = true;
            }
            (None, true) => {
                trancar(fila)?.add_marker(ativa.id(), audio_ms, Some("microfone de volta"))?;
                self.microfone_marcado = false;
            }
            _ => {}
        }
        Ok(())
    }

    /// O sistema silenciou (ou devolveu) a captura; silenciar marca "silenciado pelo sistema".
    pub fn silenciar(&mut self, fila: &Mutex<Queue>, silenciada: bool) -> Result<()> {
        let ativa = self.ativa()?;
        if silenciada && !self.silenciada {
            trancar(fila)?.add_marker(
                ativa.id(),
                ativa.audio_ms(),
                Some("silenciado pelo sistema"),
            )?;
        }
        self.silenciada = silenciada;
        Ok(())
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

    /// O microfone e o silêncio da gravação em curso, sem ler a fila: o laço os confere a cada
    /// passada, mesmo com o app invisível, para redesenhar a notificação quando mudam.
    pub fn sinais(&self) -> Option<(EstadoMicrofone, bool)> {
        self.ativa.as_ref()?;
        let microfone = if self.microfone_fora_desde().is_some() {
            EstadoMicrofone::Reconectando
        } else {
            EstadoMicrofone::Ok
        };
        Some((microfone, self.silenciada))
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
            microfone: if self.microfone_fora_desde().is_some() {
                EstadoMicrofone::Reconectando
            } else {
                EstadoMicrofone::Ok
            },
            silenciada: self.silenciada,
        }))
    }
}
