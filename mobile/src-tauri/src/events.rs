//! The `estado` event and the app loop: the UI is a function of the `AppState`, which goes out every
//! 250 ms with the app visible (the meter needs it) and on every change otherwise. Invisible, the
//! loop slows to 1 s and only checks the limits and the microphone, without reading the state or
//! emitting to the WebView; when it becomes visible again, it emits on the first tick. The same
//! loop closes the recording that hit a limit (the service shows the recording-stopped notice)
//! and fires the network cycle when it applies.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use eclume_mobile_core::{self as core, lock, AppState};
use tauri::{AppHandle, Emitter, Runtime};

/// The name of the event that carries the `AppState` to the UI (wire name, kept).
pub const STATE_EVENT: &str = "estado";
/// The loop interval with the app visible and invisible.
const TICK_VISIBLE: Duration = Duration::from_millis(250);
const TICK_INVISIBLE: Duration = Duration::from_secs(1);
/// How often the loop tries the network cycle (the cycle itself decides whether to probe or
/// upload).
const CYCLE: Duration = Duration::from_secs(5);

static LAST: Mutex<Option<String>> = Mutex::new(None);
static IN_CYCLE: AtomicBool = AtomicBool::new(false);

fn current_state() -> Option<AppState> {
    let core = core::global()?;
    let state = lock(core).ok()?.state();
    match state {
        Ok(state) => Some(state),
        Err(err) => {
            log::warn!("{err:#}");
            None
        }
    }
}

/// Emits the state if it changed since the last one (or always, with `force`); returns the state
/// read.
fn emit<R: Runtime>(app: &AppHandle<R>, force: bool) -> Option<AppState> {
    let state = current_state()?;
    let Ok(json) = serde_json::to_string(&state) else {
        return Some(state);
    };
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if force || last.as_deref() != Some(json.as_str()) {
        *last = Some(json);
        drop(last);
        if let Err(err) = app.emit(STATE_EVENT, &state) {
            log::warn!("failed to emit the state: {err}");
        }
    }
    Some(state)
}

/// Tells the UI about the new state after a command.
pub fn notify<R: Runtime>(app: &AppHandle<R>) {
    let _ = emit(app, false);
}

/// Runs a network cycle on a thread, if no other is running (`now`: "Sincronizar agora").
pub fn cycle_in_background<R: Runtime>(app: &AppHandle<R>, now: bool) {
    if IN_CYCLE.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(core) = core::global() {
            if let Err(err) = core::cycle(core, now) {
                log::warn!("network cycle: {err:#}");
            }
        }
        IN_CYCLE.store(false, Ordering::Release);
        let _ = emit(&app, false);
    });
}

/// The loop interval: 250 ms visible (the meter and the clock), 1 s invisible.
fn interval(visible: bool) -> Duration {
    if visible {
        TICK_VISIBLE
    } else {
        TICK_INVISIBLE
    }
}

/// The app loop, on its own thread.
pub fn start_loop<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let mut last_cycle = Instant::now();
        let mut was_visible = true;
        // The current recording's microphone and silence, to redraw the notification on a change.
        let mut signals = None;
        cycle_in_background(&app, false);
        loop {
            let visible = core::global()
                .and_then(|core| lock(core).ok())
                .is_none_or(|c| c.visible());
            std::thread::sleep(interval(visible));
            let Some(core) = core::global() else {
                continue;
            };
            let pass = lock(core).and_then(|mut c| {
                if let Err(err) = c.watch() {
                    log::warn!("watching the microphone: {err:#}");
                }
                let closed = c.check_limits()?;
                Ok((closed, c.session_signals(), c.locale()))
            });
            match pass {
                Ok((closed, now, locale)) => {
                    if let Some((recording, reason)) = closed {
                        log::warn!("recording {} stopped on its own: {reason:?}", recording.id);
                        crate::service::stop_with_warning(
                            &app,
                            reason.text(locale),
                            recording.duration_ms.unwrap_or(0),
                        );
                        cycle_in_background(&app, false);
                    } else if now.is_some() && now != signals {
                        crate::service::update(&app);
                    }
                    signals = now;
                }
                Err(err) => log::warn!("{err:#}"),
            }
            if last_cycle.elapsed() >= CYCLE {
                last_cycle = Instant::now();
                cycle_in_background(&app, false);
            }
            if visible {
                let _ = emit(&app, !was_visible);
            }
            was_visible = visible;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loop_slows_down_with_the_app_invisible() {
        assert_eq!(interval(true), Duration::from_millis(250));
        assert_eq!(interval(false), Duration::from_secs(1));
    }
}
