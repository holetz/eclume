//! Meeting detection loop: polls the detector every second and executes what the automatic
//! recording state machine decides — start, stop or ask.
//!
//! Never records without a visible indicator: automatic recording only starts with the tray
//! present, and its start also appears in a notification.

use std::time::Duration;

use eclume_detect::{Action, AppKey, DebounceConfig, DebouncedDetector, SystemSignals};
use eclume_recorder::MeetingDetector;
use tauri::{AppHandle, Manager};

use crate::notify::Notice;
use crate::state::{AppState, Origin};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Starts the detector thread.
pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("eclume-deteccao".into())
        .spawn(move || {
            let mut detector =
                DebouncedDetector::new(SystemSignals::new(), DebounceConfig::default());
            let mut backoff = crate::supervise::Backoff::default();
            loop {
                std::thread::sleep(POLL_INTERVAL);
                crate::supervise::pass(&mut backoff, "meeting detection", || {
                    poll_once(&app, &mut detector);
                });
            }
        });
    if let Err(err) = spawned {
        log::error!("failed to start meeting detection: {err}");
    }
}

/// One detection pass: polls the detector and handles the event, if any.
fn poll_once(app: &AppHandle, detector: &mut DebouncedDetector<SystemSignals>) {
    let enabled = app.state::<AppState>().detection_enabled().unwrap_or(false);
    // When disabled, detection only tracks an already detected meeting to its end.
    if !enabled && detector.active().is_none() {
        return;
    }
    let Some(event) = detector.poll() else {
        return;
    };
    log::info!("meeting: {event:?}");
    match app.state::<AppState>().on_meeting_event(&event) {
        Ok(action) => execute(app, action),
        Err(err) => log::error!("failed to handle {event:?}: {err:#}"),
    }
}

/// The user's answer to the prompt (notification, tray or window). Opening devices can take
/// seconds: runs off the caller's thread.
pub fn answer(app: &AppHandle, record: bool) {
    let app = app.clone();
    std::thread::spawn(
        move || match app.state::<AppState>().answer_meeting(record) {
            Ok(action) => execute(&app, action),
            Err(err) => log::error!("failed to answer the prompt: {err:#}"),
        },
    );
}

/// Executes an action from the automatic recording state machine.
pub fn execute(app: &AppHandle, action: Action) {
    match action {
        Action::None => return,
        Action::Start(key) => start(app, key),
        Action::Stop => {
            match app.state::<AppState>().stop_recording() {
                Ok(recording) => crate::notify::show(Notice::MeetingEnded(recording.duration_ms)),
                Err(err) => log::error!("failed to stop automatic recording: {err:#}"),
            }
            crate::sync::nudge(app);
        }
        Action::Ask(key) => crate::notify::ask(app, key),
        // The prompt disappears from the tray and window on the refresh below.
        Action::Dismiss => {}
    }
    crate::refresh_ui(app);
}

fn start(app: &AppHandle, key: AppKey) {
    let state = app.state::<AppState>();
    if !crate::tray::is_visible(app) {
        log::warn!("automatic recording of {} refused: no tray", key.label());
        return;
    }
    let result = state.audio_choice().and_then(|choice| {
        state.start_recording_as(Origin::detected(key), || {
            crate::capture::open_sources(&choice)
        })
    });
    match result {
        Ok(()) => crate::notify::show(Notice::Recording(key)),
        Err(err) => log::error!("failed to start automatic recording: {err:#}"),
    }
}
