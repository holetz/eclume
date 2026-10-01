//! Laço de detecção de reuniões: a cada segundo consulta o detector e executa o que a máquina de
//! gravação automática decidir — iniciar, parar ou perguntar.
//!
//! Nunca grava sem indicação visível: a gravação automática só começa com a bandeja de pé, e o
//! início sai também numa notificação.

use std::time::Duration;

use eclume_detect::{Action, AppKey, DebounceConfig, DebouncedDetector, SystemSignals};
use eclume_recorder::MeetingDetector;
use tauri::{AppHandle, Manager};

use crate::notify::Notice;
use crate::state::{AppState, Origin};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Sobe a thread do detector.
pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("eclume-deteccao".into())
        .spawn(move || {
            let mut detector =
                DebouncedDetector::new(SystemSignals::new(), DebounceConfig::default());
            let mut backoff = crate::supervise::Backoff::default();
            loop {
                std::thread::sleep(POLL_INTERVAL);
                crate::supervise::pass(&mut backoff, "detecção de reuniões", || {
                    poll_once(&app, &mut detector);
                });
            }
        });
    if let Err(err) = spawned {
        log::error!("falha ao iniciar a detecção de reuniões: {err}");
    }
}

/// Uma passada da detecção: consulta o detector e trata o evento, se houver.
fn poll_once(app: &AppHandle, detector: &mut DebouncedDetector<SystemSignals>) {
    let enabled = app.state::<AppState>().detection_enabled().unwrap_or(false);
    // Desligada, a detecção só acompanha até o fim a reunião que já tinha visto.
    if !enabled && detector.active().is_none() {
        return;
    }
    let Some(event) = detector.poll() else {
        return;
    };
    log::info!("reunião: {event:?}");
    match app.state::<AppState>().on_meeting_event(&event) {
        Ok(action) => execute(app, action),
        Err(err) => log::error!("falha ao tratar {event:?}: {err:#}"),
    }
}

/// A resposta do usuário à pergunta (notificação, bandeja ou janela). Abrir os dispositivos pode
/// levar segundos: roda fora de quem chamou.
pub fn answer(app: &AppHandle, record: bool) {
    let app = app.clone();
    std::thread::spawn(
        move || match app.state::<AppState>().answer_meeting(record) {
            Ok(action) => execute(&app, action),
            Err(err) => log::error!("falha ao responder à pergunta: {err:#}"),
        },
    );
}

/// Executa uma ação da máquina de gravação automática.
pub fn execute(app: &AppHandle, action: Action) {
    match action {
        Action::None => return,
        Action::Start(key) => start(app, key),
        Action::Stop => {
            match app.state::<AppState>().stop_recording() {
                Ok(recording) => crate::notify::show(Notice::MeetingEnded(recording.duration_ms)),
                Err(err) => log::error!("falha ao parar a gravação automática: {err:#}"),
            }
            crate::sync::nudge(app);
        }
        Action::Ask(key) => crate::notify::ask(app, key),
        // A pergunta some da bandeja e da janela no refresh abaixo.
        Action::Dismiss => {}
    }
    crate::refresh_ui(app);
}

fn start(app: &AppHandle, key: AppKey) {
    let state = app.state::<AppState>();
    if !crate::tray::is_visible(app) {
        log::warn!(
            "gravação automática de {} recusada: sem bandeja",
            key.label()
        );
        return;
    }
    let result = state.audio_choice().and_then(|choice| {
        state.start_recording_as(Origin::detected(key), || {
            crate::capture::open_sources(&choice)
        })
    });
    match result {
        Ok(()) => crate::notify::show(Notice::Recording(key)),
        Err(err) => log::error!("falha ao iniciar a gravação automática: {err:#}"),
    }
}
