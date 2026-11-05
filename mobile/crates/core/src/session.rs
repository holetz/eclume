//! The phone's recording session, on top of `eclume-recorder`: record, pause without closing the
//! microphone, mark by audio time, stop leaving the saved-recording sheet to hold the sync, and
//! save title and agenda type. A process crash is settled by `recover` on the next open (the
//! recording survives the phone switching off).
//!
//! A microphone that drops (headset plugged or unplugged, Bluetooth) reconnects inside the source
//! (`eclume_audio_capture::reconnect`): the recording continues in the same file, with silence in
//! between, and the session shows `microfone: reconectando`. A drop longer than 5 s and the return
//! become automatic markers, as does the silence the system imposes (API 29+, `muted`).
//!
//! The serialized field names are read by the UI and the notification and keep their original
//! (pt-BR) names.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use eclume_recorder::session::{self, ActiveRecording, RecorderConfig, StartOptions};
use eclume_recorder::{AudioSource, Marker, Queue, QueuedRecording, SourceState};
use serde::Serialize;

/// How long the microphone may be gone before the "microfone perdido" marker.
const MIC_LOST_AFTER: Duration = Duration::from_secs(5);

/// How the current recording's microphone is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MicState {
    Ok,
    /// It dropped and the source is trying to reopen it; the file gets silence meanwhile.
    #[serde(rename = "reconectando")]
    Reconnecting,
}

/// The current recording, as the UI and the notification show it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionState {
    pub id: String,
    /// Start, in Unix ms.
    #[serde(rename = "iniciada_em")]
    pub started_at: i64,
    /// The audio time (without the pauses).
    pub audio_ms: i64,
    /// RMS level from 0 to 1.
    #[serde(rename = "nivel")]
    pub level: f32,
    #[serde(rename = "pausada")]
    pub paused: bool,
    #[serde(rename = "marcadores")]
    pub markers: Vec<Marker>,
    #[serde(rename = "microfone")]
    pub mic: MicState,
    /// The system muted the capture (a call, a voice assistant, the microphone toggle).
    #[serde(rename = "silenciada")]
    pub muted: bool,
}

/// The session: at most one recording at a time.
#[derive(Default)]
pub struct Session {
    active: Option<ActiveRecording>,
    /// The microphone drop already became a marker.
    mic_marked: bool,
    muted: bool,
}

fn lock_queue(queue: &Mutex<Queue>) -> Result<MutexGuard<'_, Queue>> {
    queue
        .lock()
        .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
}

impl Session {
    pub fn is_recording(&self) -> bool {
        self.active.is_some()
    }

    /// Starts recording the source (the microphone, or a synthetic source in tests). Returns the
    /// id.
    pub fn start(
        &mut self,
        config: &RecorderConfig,
        queue: &Mutex<Queue>,
        source: Box<dyn AudioSource>,
    ) -> Result<String> {
        if self.active.is_some() {
            bail!("Já há uma gravação em andamento");
        }
        let active = session::start(
            config,
            &*lock_queue(queue)?,
            vec![source],
            StartOptions::MEETING,
        )?;
        let id = active.id().to_string();
        self.active = Some(active);
        self.mic_marked = false;
        self.muted = false;
        Ok(id)
    }

    /// Since when the microphone is gone, if it is.
    fn mic_lost_since(&self) -> Option<std::time::Instant> {
        self.active
            .as_ref()?
            .progress()
            .source_states()
            .into_iter()
            .find_map(|state| match state {
                SourceState::Reconnecting { since } => Some(since),
                SourceState::Live => None,
            })
    }

    /// Watches the microphone (called by the app loop): a drop longer than 5 s marks "microfone
    /// perdido" at the instant of the drop, and the return marks "microfone de volta".
    pub fn watch(&mut self, queue: &Mutex<Queue>) -> Result<()> {
        let Some(active) = &self.active else {
            return Ok(());
        };
        let audio_ms = active.audio_ms();
        match (self.mic_lost_since(), self.mic_marked) {
            (Some(since), false) if since.elapsed() >= MIC_LOST_AFTER => {
                let lost_ms = i64::try_from(since.elapsed().as_millis()).unwrap_or(i64::MAX);
                let at = audio_ms.saturating_sub(lost_ms).max(0);
                lock_queue(queue)?.add_marker(active.id(), at, Some("microfone perdido"))?;
                self.mic_marked = true;
            }
            (None, true) => {
                lock_queue(queue)?.add_marker(active.id(), audio_ms, Some("microfone de volta"))?;
                self.mic_marked = false;
            }
            _ => {}
        }
        Ok(())
    }

    /// The system muted (or gave back) the capture; muting marks "silenciado pelo sistema".
    pub fn set_muted(&mut self, queue: &Mutex<Queue>, muted: bool) -> Result<()> {
        let active = self.active()?;
        if muted && !self.muted {
            lock_queue(queue)?.add_marker(
                active.id(),
                active.audio_ms(),
                Some("silenciado pelo sistema"),
            )?;
        }
        self.muted = muted;
        Ok(())
    }

    fn active(&self) -> Result<&ActiveRecording> {
        self.active
            .as_ref()
            .context("nenhuma gravação em andamento")
    }

    pub fn pause(&self) -> Result<()> {
        self.active()?.set_paused(true);
        Ok(())
    }

    pub fn resume(&self) -> Result<()> {
        self.active()?.set_paused(false);
        Ok(())
    }

    /// Marks the current instant in the audio, right away; the note may come later through
    /// [`Self::annotate`].
    pub fn mark(&self, queue: &Mutex<Queue>, note: Option<&str>) -> Result<Marker> {
        let active = self.active()?;
        lock_queue(queue)?.add_marker(active.id(), active.audio_ms(), note)
    }

    /// A marker's note (empty deletes it), while the recording has not been uploaded.
    pub fn annotate(queue: &Mutex<Queue>, client_id: &str, note: Option<&str>) -> Result<Marker> {
        lock_queue(queue)?.set_marker_note(client_id, note)
    }

    /// Stops, closes the file and hands it to the queue (with `details_pending`, if the config
    /// asks for it).
    pub fn stop(&mut self, queue: &Mutex<Queue>) -> Result<QueuedRecording> {
        let active = self
            .active
            .take()
            .context("nenhuma gravação em andamento")?;
        active.stop(&*lock_queue(queue)?)
    }

    /// The recording ended on its own (the microphone dropped): the caller closes it with
    /// [`Self::stop`].
    pub fn ended_on_its_own(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(ActiveRecording::is_finished)
    }

    /// Title, agenda type and language from the saved-recording sheet ("Pular" passes all three
    /// empty).
    pub fn save_details(
        queue: &Mutex<Queue>,
        id: &str,
        title: Option<&str>,
        agenda_type_id: Option<&str>,
        language: Option<&str>,
    ) -> Result<()> {
        lock_queue(queue)?.save_details(id, title, agenda_type_id, language)
    }

    /// On open, settles the recording a process crash left in `recording`.
    pub fn recover(queue: &Mutex<Queue>) -> Result<Vec<QueuedRecording>> {
        session::recover(&*lock_queue(queue)?)
    }

    /// The current recording's microphone and silence, without reading the queue: the loop checks
    /// them on every pass, even with the app invisible, to redraw the notification when they
    /// change.
    pub fn signals(&self) -> Option<(MicState, bool)> {
        self.active.as_ref()?;
        let mic = if self.mic_lost_since().is_some() {
            MicState::Reconnecting
        } else {
            MicState::Ok
        };
        Some((mic, self.muted))
    }

    pub fn state(&self, queue: &Mutex<Queue>) -> Result<Option<SessionState>> {
        let Some(active) = &self.active else {
            return Ok(None);
        };
        Ok(Some(SessionState {
            id: active.id().to_string(),
            started_at: active.started_at(),
            audio_ms: active.audio_ms(),
            level: active.level(),
            paused: active.is_paused(),
            markers: lock_queue(queue)?.markers(active.id())?,
            mic: if self.mic_lost_since().is_some() {
                MicState::Reconnecting
            } else {
                MicState::Ok
            },
            muted: self.muted,
        }))
    }
}
