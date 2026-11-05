//! Tauri commands called by the window (`window.__TAURI__.core.invoke`).

use eclume_recorder::{Marker, QueuedRecording};
use tauri::{AppHandle, State};

use crate::account::{Login, PreparedServer, RealNet, ServerChoice};
use crate::capture::TestSource;
use crate::import::ImportPreview;

use crate::state::{
    AppState, ConnectionTest, NoteMeter, SettingsInput, SettingsView, StatusView, StorageInfo,
};

type CommandResult<T> = Result<T, String>;

fn to_js<T>(result: anyhow::Result<T>) -> CommandResult<T> {
    result.map_err(|err| format!("{err:#}"))
}

#[tauri::command]
pub fn status(state: State<'_, AppState>) -> CommandResult<StatusView> {
    to_js(state.view())
}

#[tauri::command]
pub fn recordings(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> CommandResult<Vec<QueuedRecording>> {
    to_js(state.recordings(limit.unwrap_or(50)))
}

// `async`: opening devices can take seconds and must not block the UI thread.
#[tauri::command(async)]
pub fn toggle_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<StatusView> {
    let result = state
        .audio_choice()
        .and_then(|choice| state.toggle_recording(|| crate::capture::open_sources(&choice)));
    crate::sync::nudge(&app);
    crate::refresh_ui(&app);
    to_js(result.and_then(|()| state.view()))
}

/// "New voice note": starts a note or stops the current one.
#[tauri::command(async)]
pub fn new_note(app: AppHandle) -> CommandResult<()> {
    to_js(crate::toggle_note(&app))
}

/// The current voice note meter (`null` without a note), polled by the window every 100 ms.
#[tauri::command]
pub fn note_meter(state: State<'_, AppState>) -> CommandResult<Option<NoteMeter>> {
    to_js(state.note_meter())
}

/// Marks the current recording time, with an optional note.
#[tauri::command]
pub fn add_marker(
    app: AppHandle,
    state: State<'_, AppState>,
    note: Option<String>,
) -> CommandResult<Marker> {
    let result = state.add_marker(note);
    crate::refresh_ui(&app);
    to_js(result)
}

/// Changes the note of a marker in the current recording.
#[tauri::command]
pub fn set_marker_note(
    state: State<'_, AppState>,
    client_id: String,
    note: Option<String>,
) -> CommandResult<Marker> {
    to_js(state.set_marker_note(&client_id, note))
}

/// The native import dialog; `null` when the user cancels.
#[tauri::command(async)]
pub fn pick_import_file(app: AppHandle) -> Option<String> {
    crate::import::pick(&app).map(|path| path.to_string_lossy().into_owned())
}

/// Reads file duration and date before confirmation.
#[tauri::command(async)]
pub fn probe_import(path: String) -> CommandResult<ImportPreview> {
    to_js(crate::import::preview(std::path::Path::new(&path)))
}

/// Converts and queues in the background; completion arrives through an event.
#[tauri::command]
pub fn import_file(
    app: AppHandle,
    path: String,
    recorded_at: i64,
    recorded_at_source: String,
) -> CommandResult<()> {
    to_js(
        crate::import::parse_source(&recorded_at_source)
            .and_then(|source| crate::import::spawn(&app, path.into(), recorded_at, source)),
    )
}

#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>) -> CommandResult<()> {
    to_js(state.cancel_import())
}

/// Opens a server help center article (`<web_url>/ajuda/<artigo>`), or the help center itself.
#[tauri::command]
pub fn open_help(
    app: AppHandle,
    state: State<'_, AppState>,
    article: Option<String>,
) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    to_js(
        state
            .web_url()
            .and_then(|web| crate::help_url(&web, article.as_deref()))
            .and_then(|url| {
                app.opener()
                    .open_url(&url, None::<&str>)
                    .map_err(anyhow::Error::from)
            }),
    )
}

/// "Report a problem…": opens the log folder to attach `eclume.log`.
#[tauri::command(async)]
pub fn open_log_dir(app: AppHandle) -> CommandResult<()> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    to_js(
        app.path()
            .app_log_dir()
            .map_err(anyhow::Error::from)
            .and_then(|dir| {
                app.opener()
                    .open_path(dir.to_string_lossy(), None::<&str>)
                    .map_err(anyhow::Error::from)
            }),
    )
}

#[tauri::command]
pub fn open_web(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    to_js(crate::open_web(&app, &state))
}

/// The effective account transcription language (`GET /me/transcription`), so the Audio tab
/// can name the default; `None` without an account or server response.
#[tauri::command(async)]
pub fn account_language(state: State<'_, AppState>) -> Option<String> {
    let config = state.uploader_config().ok()??;
    let preference = eclume_sync::Client::from_config(&config)
        .and_then(|client| client.transcription_preference())
        .map_err(|err| log::warn!("{err:#}"))
        .ok()?;
    Some(preference.effective().to_string())
}

#[tauri::command(async)]
pub fn settings(state: State<'_, AppState>) -> CommandResult<SettingsView> {
    to_js(state.settings())
}

#[tauri::command(async)]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SettingsInput,
) -> CommandResult<SettingsView> {
    let result = state.save_settings(input);
    if let Ok(action) = &result {
        crate::auto::execute(&app, *action);
        crate::shortcuts::register(&app);
        crate::reconcile_autostart(&app);
        // New PAT or server: retry failures now.
        if let Err(err) = crate::sync::sync_now(&app) {
            log::error!("{err:#}");
        }
        // Synced folder enabled or changed: run a cycle now.
        crate::mirror_sync::nudge(&app, false);
        // Recent recordings at the top changed: reload the panel.
        crate::recent::nudge(&app);
    }
    crate::refresh_ui(&app);
    to_js(result.and_then(|_| state.settings()))
}

#[tauri::command]
pub fn set_locale(
    app: AppHandle,
    state: State<'_, AppState>,
    choice: Option<String>,
) -> CommandResult<()> {
    let result = state.set_locale(choice);
    crate::refresh_ui(&app);
    to_js(result)
}

#[tauri::command]
pub fn report_system_locale(
    app: AppHandle,
    state: State<'_, AppState>,
    tag: String,
) -> CommandResult<()> {
    let result = state.report_system_locale(&tag);
    crate::refresh_ui(&app);
    to_js(result)
}

/// "Create GNOME shortcuts" (`install`) or remove them, in Wayland `sistema` mode.
#[tauri::command(async)]
pub fn system_shortcuts(
    app: AppHandle,
    state: State<'_, AppState>,
    install: bool,
) -> CommandResult<SettingsView> {
    let result = if install {
        state
            .shortcuts()
            .and_then(|shortcuts| crate::shortcuts::install_system(&shortcuts))
    } else {
        crate::shortcuts::remove_system()
    };
    crate::shortcuts::register(&app);
    to_js(result.and_then(|()| state.settings()))
}

/// The window's answer to the detected meeting prompt.
#[tauri::command]
pub fn answer_meeting(app: AppHandle, record: bool) {
    crate::auto::answer(&app, record);
}

/// System microphones for the Audio tab.
#[derive(serde::Serialize)]
pub struct MicDevices {
    pub default: Option<String>,
    pub names: Vec<String>,
}

#[tauri::command(async)]
pub fn list_input_devices() -> CommandResult<MicDevices> {
    to_js(
        eclume_audio_capture::list_input_devices().map(|devices| MicDevices {
            default: devices.default,
            names: devices.names,
        }),
    )
}

/// System audio outputs for the Audio tab.
#[derive(serde::Serialize)]
pub struct OutputDevices {
    pub default: Option<String>,
    pub devices: Vec<OutputDevice>,
}

#[derive(serde::Serialize)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

#[tauri::command(async)]
pub fn list_output_devices() -> CommandResult<OutputDevices> {
    to_js(eclume_audio_capture::list_output_devices().map(|devices| {
        OutputDevices {
            default: devices.default,
            devices: devices
                .devices
                .into_iter()
                .map(|device| OutputDevice {
                    id: device.id,
                    name: device.name,
                })
                .collect(),
        }
    }))
}

/// "Speak to test" (`mic`) or "Play something to test" (`system`): up to 10 s of metering with
/// the source chosen in the Audio tab. One test at a time.
#[tauri::command(async)]
pub fn source_test(state: State<'_, AppState>, source: TestSource) -> CommandResult<()> {
    let choice = state.audio_choice();
    to_js(choice.and_then(|choice| {
        state.start_source_test(
            move || crate::capture::open_test_source(&choice, source),
            crate::state::SOURCE_TEST,
        )
    }))
}

/// "Stop": ends the level test immediately.
#[tauri::command]
pub fn source_test_stop(state: State<'_, AppState>) -> CommandResult<()> {
    to_js(state.stop_source_test())
}

/// The level test meter (`null` when finished), polled by the window every 100 ms.
#[tauri::command]
pub fn source_test_meter(state: State<'_, AppState>) -> CommandResult<Option<Vec<f32>>> {
    to_js(
        state
            .source_test_meter()
            .map(|m| m.map(|levels| levels.to_vec())),
    )
}

/// How many recordings and how much space remain on this computer.
#[tauri::command(async)]
pub fn storage_info(state: State<'_, AppState>) -> CommandResult<StorageInfo> {
    to_js(state.storage_info())
}

/// "Show": opens the recording folder in the file manager.
#[tauri::command(async)]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.data_dir();
    to_js(
        std::fs::create_dir_all(dir)
            .map_err(anyhow::Error::from)
            .and_then(|()| {
                app.opener()
                    .open_path(dir.to_string_lossy(), None::<&str>)
                    .map_err(anyhow::Error::from)
            }),
    )
}

/// Dismisses the "Updated to X" notice.
#[tauri::command]
pub fn dismiss_update_notice(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let result = state.dismiss_update_notice();
    crate::refresh_ui(&app);
    to_js(result)
}

#[tauri::command]
pub fn sync_now(app: AppHandle) -> CommandResult<()> {
    to_js(crate::sync::sync_now(&app))
}

/// The recent recordings panel at the top of the main window.
#[tauri::command]
pub fn recent(app: AppHandle) -> CommandResult<crate::recent::RecentView> {
    to_js(crate::recent::view(&app))
}

/// Requests a recent recordings refresh now (the main window just opened).
#[tauri::command]
pub fn recent_refresh(app: AppHandle) {
    crate::recent::nudge(&app);
}

/// "Copy summary": places the current summary Markdown on the clipboard.
#[tauri::command(async)]
pub fn copy_summary(app: AppHandle, recording_id: String) -> CommandResult<()> {
    to_js(crate::recent::copy_summary(&app, &recording_id))
}

/// "Open on web": the recording page.
#[tauri::command]
pub fn open_recording(app: AppHandle, recording_id: String) -> CommandResult<()> {
    to_js(crate::recent::open_recording(&app, &recording_id))
}

/// First-run servers: the installer server and, for up to 3 s, those announced on the network.
#[tauri::command(async)]
pub fn discover_servers() -> Vec<ServerChoice> {
    let found = eclume_sync::discovery::discover(eclume_sync::discovery::DEFAULT_TIMEOUT)
        .unwrap_or_else(|err| {
            log::warn!("{err:#}");
            Vec::new()
        });
    crate::account::server_choices(crate::config::embedded_server(), found)
}

/// Pins the chosen server CA (checking the fingerprint, when present) and saves the server.
#[tauri::command(async)]
pub fn prepare_server(
    state: State<'_, AppState>,
    url: String,
    ca_sha256: Option<String>,
) -> CommandResult<PreparedServer> {
    to_js(state.prepare_server(&RealNet, &url, ca_sha256.as_deref()))
}

/// The user checked the chosen server fingerprint.
#[tauri::command(async)]
pub fn confirm_server(
    state: State<'_, AppState>,
    url: String,
    ca_sha256: Option<String>,
) -> CommandResult<()> {
    to_js(state.confirm_server(&url, ca_sha256.as_deref()))
}

/// Signs in to the chosen server with email and password.
#[tauri::command(async)]
pub fn sign_in(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> CommandResult<()> {
    let result = state.sign_in(
        &RealNet,
        Login::Password {
            email: &email,
            password: &password,
        },
    );
    signed_in(&app, result)
}

/// Signs in with the pairing code shown on the web.
#[tauri::command(async)]
pub fn pair(app: AppHandle, state: State<'_, AppState>, code: String) -> CommandResult<()> {
    let result = state.sign_in(&RealNet, Login::Code(&code));
    signed_in(&app, result)
}

/// After sign-in, uploads waiting recordings immediately.
fn signed_in(app: &AppHandle, result: anyhow::Result<()>) -> CommandResult<()> {
    if result.is_ok() {
        if let Err(err) = crate::sync::sync_now(app) {
            log::error!("{err:#}");
        }
    }
    crate::refresh_ui(app);
    to_js(result)
}

/// "Sign out": deletes this computer's credential; the queue waits for the next sign-in.
#[tauri::command(async)]
pub fn sign_out(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let result = state.sign_out();
    crate::refresh_ui(&app);
    to_js(result)
}

/// "Test connection".
#[tauri::command(async)]
pub fn test_connection(state: State<'_, AppState>) -> CommandResult<ConnectionTest> {
    to_js(state.test_connection(&RealNet))
}

/// "Choose…" for the extra CA: native dialog with a PEM filter; `null` when the user cancels.
#[tauri::command(async)]
pub fn pick_ca_file(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Autoridade certificadora extra")
        .add_filter("Certificado PEM", &["pem", "crt", "cer"])
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// "Choose folder…" for the synced folder: native folder dialog; `null` when the user
/// cancels.
#[tauri::command(async)]
pub fn pick_mirror_dir(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Pasta dos resumos")
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Synced folder status: current cycle, last result and error.
#[tauri::command]
pub fn mirror_status(state: State<'_, AppState>) -> CommandResult<crate::state::MirrorStatus> {
    to_js(state.mirror_status())
}

/// "Sync now" for the synced folder: runs a cycle now, also checking the whole library.
#[tauri::command]
pub fn mirror_sync_now(app: AppHandle) {
    crate::mirror_sync::nudge(&app, true);
}

/// "Create account": opens the chosen server sign-up page in the browser.
#[tauri::command]
pub fn open_signup(app: AppHandle, url: String) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    to_js(crate::config::validate_web_url(url.trim()).and_then(|()| {
        let signup = format!("{}/cadastro", url.trim().trim_end_matches('/'));
        app.opener()
            .open_url(&signup, None::<&str>)
            .map_err(anyhow::Error::from)
    }))
}
