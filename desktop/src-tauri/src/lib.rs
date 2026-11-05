//! eclume desktop app: records meetings (mic + system audio) as Ogg/Opus, detects when a
//! meeting starts, keeps a local recording queue, uploads recordings to the server with the
//! device credential (or a PAT from an earlier version) and stays in the system tray.

mod account;
mod auto;
pub mod capture;
mod commands;
pub mod config;
pub mod i18n;
mod import;
mod mirror_sync;
mod notify;
mod recent;
pub mod shortcuts;
pub mod state;
mod supervise;
mod sync;
mod tray;
mod updater;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

use crate::state::{AppState, Busy, MicChange, NoteToggle, Reaped};

/// Name shown in the window and system tray.
pub const APP_NAME: &str = "eclume";

/// Event the window listens to for updates.
const STATUS_EVENT: &str = "status-changed";

/// Reconciles autostart with the config: registers or removes the app in the system.
/// A development build skips registration (it would add the `target/` binary to autostart),
/// and system failures are only logged.
pub(crate) fn reconcile_autostart(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(wanted) = app.state::<AppState>().autostart() else {
        return;
    };
    let launcher = app.autolaunch();
    let result = match (wanted, launcher.is_enabled()) {
        (true, Ok(false) | Err(_)) => launcher.enable(),
        (false, Ok(true)) => launcher.disable(),
        _ => Ok(()),
    };
    if let Err(err) = result {
        log::error!("failed to reconcile autostart: {err}");
    }
}

/// Updates everything that shows state: the tray and window. Safe from any thread: the tray
/// is only touched on the main thread (`tray::refresh` dispatches to it).
pub(crate) fn refresh_ui(app: &AppHandle) {
    tray::refresh(app);
    let _ = app.emit(STATUS_EVENT, ());
}

/// Shows and focuses the main window (created hidden).
pub(crate) fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Opens eclume web in the default browser.
pub(crate) fn open_web(app: &AppHandle, state: &AppState) -> anyhow::Result<()> {
    let url = state.web_url()?;
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

/// Starts or stops recording from the tray or shortcut. Opening devices can take seconds:
/// runs off the UI thread.
pub(crate) fn spawn_toggle_recording(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = state
            .audio_choice()
            .and_then(|choice| state.toggle_recording(|| capture::open_sources(&choice)));
        if let Err(err) = result {
            log::error!("failed to toggle recording: {err:#}");
        }
        sync::nudge(&app);
        refresh_ui(&app);
    });
}

/// "New voice note", from the window, tray or shortcut: starts a note or stops the current one.
/// The result appears in a notification because the shortcut does not open the window.
pub(crate) fn toggle_note(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let result = state
        .audio_choice()
        .and_then(|choice| state.toggle_note(|| capture::open_mic(&choice)));
    match &result {
        Ok(NoteToggle::Started) => {}
        Ok(NoteToggle::Stopped(recording)) => notify::note_saved(recording.duration_ms),
        Err(err) if err.is::<Busy>() => notify::busy(),
        Err(err) => notify::info("Não deu para gravar a nota", &format!("{err:#}")),
    }
    sync::nudge(app);
    refresh_ui(app);
    result.map(|_| ())
}

/// Marker from tray or shortcut: opens nothing and sends no notice to avoid disrupting the meeting.
pub(crate) fn add_marker(app: &AppHandle) {
    match app.state::<AppState>().add_marker(None) {
        Ok(marker) => log::info!("marker at {} ms", marker.at_ms),
        Err(err) => log::warn!("marker ignored: {err:#}"),
    }
    refresh_ui(app);
}

/// The URL of a server help center article; without an article, the help center itself.
pub(crate) fn help_url(web_url: &str, article: Option<&str>) -> anyhow::Result<String> {
    let base = format!("{}/ajuda", web_url.trim_end_matches('/'));
    match article {
        None => Ok(base),
        Some(slug)
            if !slug.is_empty()
                && slug
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') =>
        {
            Ok(format!("{base}/{slug}"))
        }
        Some(slug) => anyhow::bail!("artigo de ajuda inválido: {slug}"),
    }
}

/// Log file in the app's log directory.
const LOG_FILE: &str = "eclume.log";
/// Above this size, the log becomes `eclume.log.1` when the app opens.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Enables logging (`info`, or what `RUST_LOG` requests) to stderr and `<dir>/eclume.log`: on
/// Windows, release builds have no console, so without the file no failure would be recorded.
fn init_logging(dir: &Path) {
    let builder =
        &mut env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    match Tee::open(dir, LOG_MAX_BYTES) {
        Ok(tee) => {
            builder.target(env_logger::Target::Pipe(Box::new(tee)));
        }
        Err(err) => eprintln!("stderr only: failed to open {}: {err}", dir.display()),
    }
    let _ = builder.try_init();
    std::panic::set_hook(Box::new(log_panic));
}

/// Logs panics with the thread, location and backtrace: the default only writes to stderr, which
/// an app launched from the system menu does not save anywhere the user can find.
fn log_panic(info: &std::panic::PanicHookInfo<'_>) {
    let thread = std::thread::current();
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("(no message)");
    let location = info
        .location()
        .map_or_else(String::new, |at| format!(" at {at}"));
    log::error!(
        "panic in thread {}{location}: {message}\n{}",
        thread.name().unwrap_or("unnamed"),
        std::backtrace::Backtrace::force_capture()
    );
}

/// Opens the log for appending, rotating it to `.1` if it exceeds `max_bytes`.
fn open_log(dir: &Path, max_bytes: u64) -> io::Result<File> {
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > max_bytes) {
        fs::rename(&path, dir.join(format!("{LOG_FILE}.1")))?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Writes to the file and, when available, stderr. Above `max_bytes`, rotates the file to
/// `.1` while the app is open (under the `env_logger` lock, which serializes writes).
struct Tee {
    dir: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    written: u64,
}

impl Tee {
    fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
        let file = open_log(dir, max_bytes)?;
        let written = file.metadata().map_or(0, |meta| meta.len());
        Ok(Self {
            dir: dir.to_path_buf(),
            max_bytes,
            file: Some(file),
            written,
        })
    }

    /// Closes the file (Windows cannot rename an open file), rotates and reopens it.
    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let file = open_log(&self.dir, 0).or_else(|_| open_log(&self.dir, u64::MAX))?;
        self.written = file.metadata().map_or(0, |meta| meta.len());
        self.file = Some(file);
        Ok(())
    }
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stderr().write_all(buf);
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log closed"))?;
        file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), Write::flush)
    }
}

/// Every second, closes recordings that ended on their own: lost sources, recording failures
/// (with the "Recording stopped" notice) or a note that stopped on silence (a note without
/// speech is discarded). Every minute, sweeps orphan recordings (`AppState::sweep_orphans`).
fn spawn_reaper(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ticks: u64 = 0;
        let mut backoff = supervise::Backoff::default();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            ticks += 1;
            supervise::pass(&mut backoff, "reaper", || reap_once(&app, ticks));
        }
    });
}

/// One reaper pass.
fn reap_once(app: &AppHandle, ticks: u64) {
    match app.state::<AppState>().watch_sources() {
        Ok(Some(change)) => {
            if change == MicChange::Lost {
                notify::mic_lost();
            }
            refresh_ui(app);
        }
        Ok(None) => {}
        Err(err) => log::error!("failed to watch recording sources: {err:#}"),
    }
    match app.state::<AppState>().reap_finished() {
        Ok(Some(reaped)) => {
            match reaped {
                Reaped::NoteSaved(recording) => notify::note_saved(recording.duration_ms),
                Reaped::NoteDiscarded => notify::note_discarded(),
                Reaped::Stopped { recording, reason } => {
                    notify::recording_stopped(recording.duration_ms, reason);
                }
            }
            sync::nudge(app);
            refresh_ui(app);
        }
        Ok(None) => {}
        Err(err) => log::error!("failed to close finished recording: {err:#}"),
    }
    // Every minute, closes recordings whose `.part` got stuck on stop.
    if ticks.is_multiple_of(60) {
        match app.state::<AppState>().sweep_orphans() {
            Ok(0) => {}
            Ok(_) => {
                sync::nudge(app);
                refresh_ui(app);
            }
            Err(err) => log::error!("failed to sweep orphan recordings: {err:#}"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First plugin: the second instance passes its arguments to the first and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match shortcuts::action_from_args(&argv) {
                Some(action) => shortcuts::run(app, action),
                None => show_window(app),
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            init_logging(&app.path().app_log_dir()?);
            notify::init(app.handle());
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::open(&data_dir, &config_dir)?;
            log::info!(
                "eclume {} ({}) with data in {}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                data_dir.display()
            );
            let updated = state.take_update_notification()?;
            app.manage(state);
            tray::build(app.handle())?;
            if let Some(update) = updated {
                notify::info(
                    &format!("eclume atualizado para {}", update.version),
                    update
                        .notes
                        .as_deref()
                        .unwrap_or("Veja as novidades na janela do eclume."),
                );
            }
            reconcile_autostart(app.handle());
            shortcuts::init(app.handle());
            // Opened by a system shortcut with no running instance: performs the action now.
            if let Some(action) = shortcuts::action_from_args(&std::env::args().collect::<Vec<_>>())
            {
                shortcuts::run(app.handle(), action);
            }
            // On macOS, the app lives in the menu bar, with no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            spawn_reaper(app.handle().clone());
            sync::spawn(app.handle());
            let locale_app = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(err) = locale_app
                    .state::<AppState>()
                    .refresh_account_locale(&account::RealNet)
                {
                    log::warn!("failed to refresh account locale: {err:#}");
                }
                refresh_ui(&locale_app);
            });
            mirror_sync::spawn(app.handle());
            recent::spawn(app.handle());
            auto::spawn(app.handle().clone());
            sync::nudge(app.handle());
            updater::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Closing the window only hides it: the app stays in the tray.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Dropping a file onto the window opens import (the first file if
                // there are several).
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    if let Some(path) = paths.first() {
                        import::open_in_window(window.app_handle(), path);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::recordings,
            commands::toggle_recording,
            commands::system_shortcuts,
            commands::new_note,
            commands::note_meter,
            commands::add_marker,
            commands::set_marker_note,
            commands::pick_import_file,
            commands::probe_import,
            commands::import_file,
            commands::cancel_import,
            commands::open_help,
            commands::open_log_dir,
            commands::open_web,
            commands::settings,
            commands::save_settings,
            commands::set_locale,
            commands::report_system_locale,
            commands::answer_meeting,
            commands::sync_now,
            commands::recent,
            commands::recent_refresh,
            commands::copy_summary,
            commands::open_recording,
            commands::dismiss_update_notice,
            commands::storage_info,
            commands::list_input_devices,
            commands::list_output_devices,
            commands::source_test,
            commands::source_test_stop,
            commands::source_test_meter,
            commands::open_data_dir,
            commands::discover_servers,
            commands::prepare_server,
            commands::confirm_server,
            commands::sign_in,
            commands::pair,
            commands::sign_out,
            commands::test_connection,
            commands::open_signup,
            commands::pick_ca_file,
            commands::pick_mirror_dir,
            commands::mirror_status,
            commands::account_language,
            commands::mirror_sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the eclume desktop app");
}

#[cfg(test)]
mod tests {
    use super::{help_url, open_log, Tee, APP_NAME, LOG_FILE};

    #[test]
    fn help_address() {
        assert_eq!(
            help_url("https://192.0.2.10:8443/", None).unwrap(),
            "https://192.0.2.10:8443/ajuda"
        );
        assert_eq!(
            help_url("https://eclume.local", Some("first-recording")).unwrap(),
            "https://eclume.local/ajuda/first-recording"
        );
        assert!(help_url("https://eclume.local", Some("../admin")).is_err());
        assert!(help_url("https://eclume.local", Some("")).is_err());
    }

    #[test]
    fn app_name() {
        assert_eq!(APP_NAME, "eclume");
    }

    #[test]
    fn log_appends_and_rotates_above_limit() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("eclume-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        writeln!(open_log(&dir, 16).unwrap(), "primeira linha").unwrap();
        writeln!(open_log(&dir, 64).unwrap(), "segunda").unwrap();
        let current = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(current, "primeira linha\nsegunda\n");

        open_log(&dir, 16).unwrap();
        let rotated = std::fs::read_to_string(dir.join(format!("{LOG_FILE}.1"))).unwrap();
        assert_eq!(rotated, "primeira linha\nsegunda\n");
        assert_eq!(std::fs::read_to_string(dir.join(LOG_FILE)).unwrap(), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn log_rotates_while_app_is_open() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("eclume-log-aberto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let mut tee = Tee::open(&dir, 32).unwrap();
        tee.write_all(
            b"primeira linha do log
",
        )
        .unwrap();
        tee.write_all(
            b"segunda linha do log
",
        )
        .unwrap();
        tee.write_all(
            b"terceira
",
        )
        .unwrap();
        tee.flush().unwrap();
        let rotated = std::fs::read_to_string(dir.join(format!("{LOG_FILE}.1"))).unwrap();
        assert_eq!(
            rotated,
            "primeira linha do log
"
        );
        let current = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(
            current,
            "segunda linha do log
terceira
"
        );
        drop(tee);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
