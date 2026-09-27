//! Comandos Tauri que a janela chama (`window.__TAURI__.core.invoke`).

use eclume_recorder::QueuedRecording;
use tauri::{AppHandle, State};

use crate::state::{AppState, NoteMeter, SettingsInput, SettingsView, StatusView};

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

#[tauri::command]
pub fn sync_now(app: AppHandle) -> CommandResult<()> {
    to_js(crate::sync::sync_now(&app))
}
