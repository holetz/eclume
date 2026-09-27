//! Comandos Tauri que a janela chama (`window.__TAURI__.core.invoke`).

use eclume_recorder::{Marker, QueuedRecording};
use tauri::{AppHandle, State};

use crate::import::ImportPreview;

use crate::state::{AppState, NoteMeter, SettingsInput, SettingsView, StatusView, StorageInfo};

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

// `async`: abrir dispositivos pode levar segundos e não deve travar a thread da UI.
#[tauri::command(async)]
pub fn toggle_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<StatusView> {
    let result = state.toggle_recording(crate::capture::open_sources);
    crate::sync::nudge(&app);
    crate::refresh_ui(&app);
    to_js(result.and_then(|()| state.view()))
}

/// "Nova nota": começa uma nota ou para a nota em curso.
#[tauri::command(async)]
pub fn new_note(app: AppHandle) -> CommandResult<()> {
    to_js(crate::toggle_note(&app))
}

/// O medidor da nota em curso (`null` sem nota), que a janela consulta a cada 100 ms.
#[tauri::command]
pub fn note_meter(state: State<'_, AppState>) -> CommandResult<Option<NoteMeter>> {
    to_js(state.note_meter())
}

/// Marca o instante atual da gravação, com nota opcional.
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

/// Troca a nota de um marcador da gravação em curso.
#[tauri::command]
pub fn set_marker_note(
    state: State<'_, AppState>,
    client_id: String,
    note: Option<String>,
) -> CommandResult<Marker> {
    to_js(state.set_marker_note(&client_id, note))
}

/// O diálogo nativo de importar; `null` quando a pessoa desiste.
#[tauri::command(async)]
pub fn pick_import_file(app: AppHandle) -> Option<String> {
    crate::import::pick(&app).map(|path| path.to_string_lossy().into_owned())
}

/// Lê duração e data do arquivo antes da confirmação.
#[tauri::command(async)]
pub fn probe_import(path: String) -> CommandResult<ImportPreview> {
    to_js(crate::import::preview(std::path::Path::new(&path)))
}

/// Converte e põe na fila em segundo plano; o fim chega por evento.
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

#[tauri::command]
pub fn open_web(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    to_js(crate::open_web(&app, &state))
}

#[tauri::command]
pub fn settings(state: State<'_, AppState>) -> CommandResult<SettingsView> {
    to_js(state.settings())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SettingsInput,
) -> CommandResult<SettingsView> {
    let result = state.save_settings(input);
    if let Ok(action) = &result {
        crate::auto::execute(&app, *action);
        crate::shortcuts::register(&app);
        // PAT ou servidor novos: as falhas tentam de novo já.
        if let Err(err) = crate::sync::sync_now(&app) {
            log::error!("{err:#}");
        }
    }
    crate::refresh_ui(&app);
    to_js(result.and_then(|_| state.settings()))
}

/// Resposta da janela à pergunta de reunião detectada.
#[tauri::command]
pub fn answer_meeting(app: AppHandle, record: bool) {
    crate::auto::answer(&app, record);
}

/// Quantas gravações e quanto espaço ainda estão neste computador.
#[tauri::command]
pub fn storage_info(state: State<'_, AppState>) -> CommandResult<StorageInfo> {
    to_js(state.storage_info())
}

/// "Mostrar": abre a pasta das gravações no gerenciador de arquivos.
#[tauri::command]
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

#[tauri::command]
pub fn sync_now(app: AppHandle) -> CommandResult<()> {
    to_js(crate::sync::sync_now(&app))
}
