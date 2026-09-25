//! Comandos Tauri que a janela chama (`window.__TAURI__.core.invoke`).

use eclume_recorder::QueuedRecording;
use tauri::{AppHandle, State};

use crate::state::{AppState, StatusView};

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
    crate::refresh_ui(&app);
    to_js(result.and_then(|()| state.view()))
}

#[tauri::command]
pub fn open_web(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    to_js(crate::open_web(&app, &state))
}

#[tauri::command]
pub fn set_web_url(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> CommandResult<StatusView> {
    let result = state.set_web_url(url.trim());
    crate::refresh_ui(&app);
    to_js(result.and_then(|()| state.view()))
}
