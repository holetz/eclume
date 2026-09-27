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
    let result = state
        .audio_choice()
        .and_then(|choice| state.toggle_recording(|| crate::capture::open_sources(&choice)));
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

/// Abre um artigo da central de ajuda do servidor (`<web_url>/ajuda/<artigo>`), ou a central.
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

/// "Relatar um problema…": abre a pasta de logs, para anexar o `eclume.log`.
#[tauri::command]
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

/// Os microfones do sistema, para a aba Áudio.
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

/// "Fale para testar o nível": 10 s de medidor com o microfone escolhido.
#[tauri::command(async)]
pub fn mic_test(state: State<'_, AppState>) -> CommandResult<()> {
    let choice = state.audio_choice();
    to_js(choice.and_then(|choice| {
        state.start_mic_test(
            move || {
                let mic = eclume_audio_capture::MicSource::open_named(choice.mic.as_deref())?;
                Ok(Box::new(mic) as Box<dyn eclume_recorder::AudioSource>)
            },
            crate::state::MIC_TEST,
        )
    }))
}

/// O medidor do teste de nível (`null` quando acabou), que a janela consulta a cada 100 ms.
#[tauri::command]
pub fn mic_test_meter(state: State<'_, AppState>) -> CommandResult<Option<Vec<f32>>> {
    to_js(
        state
            .mic_test_meter()
            .map(|m| m.map(|levels| levels.to_vec())),
    )
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

/// Fecha o aviso "Atualizado para X".
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
