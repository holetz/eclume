//! The commands the UI calls (`invoke`). Each one locks the core only for the local operation; the
//! slow network work (probe, sync, steps) runs outside the lock through the core's functions.
//!
//! The command names and their argument names are the IPC contract with the UI (`invoke("gravar")`,
//! `{ tipoDeAgendaId }`): they keep their original (pt-BR) names, and so do the serialized fields
//! of the structs returned here.

use eclume_mobile_core::config::AgendaType;
use eclume_mobile_core::{
    self as core, lock, AppState, Core, LocalDetail, LocalRecording, Preferences,
};
use eclume_recorder::Marker;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::events;

/// The saved-recording sheet's deadline (`DETAILS_WAIT_MS`), which holds the stopped recording's
/// sync.
const SHEET_DEADLINE: std::time::Duration =
    std::time::Duration::from_millis(eclume_recorder::queue::DETAILS_WAIT_MS.unsigned_abs());

/// A command's error, as text for the UI to show.
type CommandResult<T> = Result<T, String>;

fn text(err: anyhow::Error) -> String {
    format!("{err:#}")
}

fn the_core() -> CommandResult<&'static std::sync::Mutex<Core>> {
    core::global().ok_or_else(|| "o app ainda está abrindo".to_string())
}

/// Runs `f` on the locked core and tells the UI about the new state.
fn with_core<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut Core) -> anyhow::Result<T>,
) -> CommandResult<T> {
    let result = {
        let mut core = lock(the_core()?).map_err(text)?;
        f(&mut core).map_err(text)
    };
    events::notify(app);
    result
}

/// Like [`with_core`], on a blocking thread: the commands that talk to the server (download the
/// CA, `/server`, sign-in, pairing) must not hold the main thread (ANR) with a silent address.
async fn with_core_on_network<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(&mut Core) -> anyhow::Result<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(move || with_core(&app, f))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn estado() -> CommandResult<AppState> {
    lock(the_core()?).map_err(text)?.state().map_err(text)
}

#[tauri::command]
pub async fn conectar_descoberto<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    ca: Option<String>,
) -> CommandResult<()> {
    with_core_on_network(app, move |c| c.connect_discovered(&url, ca.as_deref())).await
}

#[tauri::command]
pub async fn conectar_endereco<R: Runtime>(
    app: AppHandle<R>,
    endereco: String,
) -> CommandResult<()> {
    with_core_on_network(app, move |c| c.connect_address(&endereco)).await
}

#[tauri::command]
pub async fn confiar_ca<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    with_core_on_network(app, Core::trust_ca).await
}

#[tauri::command]
pub fn cancelar_ca<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    with_core(&app, |c| {
        c.cancel_ca();
        Ok(())
    })
}

#[tauri::command]
pub async fn entrar<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    senha: String,
) -> CommandResult<()> {
    with_core_on_network(app.clone(), move |c| c.sign_in(&email, &senha)).await?;
    events::cycle_in_background(&app, true);
    Ok(())
}

#[tauri::command]
pub async fn parear<R: Runtime>(app: AppHandle<R>, texto: String) -> CommandResult<()> {
    with_core_on_network(app.clone(), move |c| c.pair(&texto)).await?;
    events::cycle_in_background(&app, true);
    Ok(())
}

/// Recording only confirms after the service enters the foreground: opening the microphone and
/// waiting for Kotlin run on a blocking thread (a synchronous command runs on the main thread). If
/// Android refuses the service, the opened recording is undone and the screen gets the reason.
#[tauri::command]
pub async fn gravar<R: Runtime>(app: AppHandle<R>) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = crate::microphone().map_err(text)?;
        let id = with_core(&app, |c| c.record(source))?;
        if let Err(reason) = crate::service::start(&app) {
            log::warn!("recording service refused: {reason}");
            with_core(&app, Core::undo_recording)?;
            return Err(format!(
                "O Android não deixou gravar em segundo plano: {reason}"
            ));
        }
        Ok(id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn pausar<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    with_core(&app, |c| c.pause())?;
    crate::service::update(&app);
    Ok(())
}

#[tauri::command]
pub fn continuar<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    with_core(&app, |c| c.resume())?;
    crate::service::update(&app);
    Ok(())
}

#[tauri::command]
pub fn marcar<R: Runtime>(app: AppHandle<R>, nota: Option<String>) -> CommandResult<Marker> {
    let marker = with_core(&app, |c| c.mark(nota.as_deref()))?;
    crate::service::update(&app);
    Ok(marker)
}

#[tauri::command]
pub fn anotar_marcador<R: Runtime>(
    app: AppHandle<R>,
    client_id: String,
    nota: Option<String>,
) -> CommandResult<Marker> {
    with_core(&app, |c| c.annotate_marker(&client_id, nota.as_deref()))
}

#[tauri::command]
pub fn parar<R: Runtime>(app: AppHandle<R>) -> CommandResult<String> {
    let recording = with_core(&app, Core::stop)?;
    crate::service::stop(&app);
    // The saved-recording sheet holds the sync until its deadline: the work waits the same
    // deadline, so the recording uploads with the app closed even with the sheet left open.
    crate::service::schedule_sync(&app, SHEET_DEADLINE);
    Ok(recording.id)
}

#[tauri::command]
pub fn salvar<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    titulo: Option<String>,
    tipo_de_agenda_id: Option<String>,
    idioma: Option<String>,
) -> CommandResult<()> {
    with_core(&app, |c| {
        c.save_details(
            &id,
            titulo.as_deref(),
            tipo_de_agenda_id.as_deref(),
            idioma.as_deref(),
        )
    })?;
    // On stopping, the probe runs again: the recording may upload right away, or with the app
    // closed through the sync work, on eclume's next Wi-Fi.
    events::cycle_in_background(&app, false);
    crate::service::schedule_sync(&app, std::time::Duration::ZERO);
    Ok(())
}

#[tauri::command]
pub fn sincronizar_agora<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    events::cycle_in_background(&app, true);
    Ok(())
}

#[tauri::command]
pub fn gravacoes() -> CommandResult<Vec<LocalRecording>> {
    lock(the_core()?).map_err(text)?.recordings().map_err(text)
}

#[tauri::command]
pub async fn gravacao(id: String) -> CommandResult<LocalDetail> {
    // Off the main thread: reading the server steps goes over the network.
    tauri::async_runtime::spawn_blocking(move || core::detail(the_core()?, &id).map_err(text))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn excluir_local<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<()> {
    with_core(&app, |c| c.delete_local(&id))
}

#[tauri::command]
pub fn excluir_sincronizadas<R: Runtime>(app: AppHandle<R>) -> CommandResult<u64> {
    with_core(&app, |c| c.delete_synced())
}

#[tauri::command]
pub fn tipos_de_agenda() -> CommandResult<Vec<AgendaType>> {
    Ok(lock(the_core()?)
        .map_err(text)?
        .config()
        .agenda_types
        .clone())
}

/// The saved-recording sheet's language options, with the account default named.
#[tauri::command]
pub fn idiomas() -> CommandResult<Vec<eclume_mobile_core::LanguageOption>> {
    Ok(lock(the_core()?).map_err(text)?.language_options())
}

/// What the Settings screen shows.
#[derive(Clone, Debug, Serialize)]
pub struct Settings {
    #[serde(rename = "servidor")]
    pub server: Option<String>,
    #[serde(rename = "preferencias")]
    pub preferences: Preferences,
    #[serde(rename = "reter_dias")]
    pub retention_days: u32,
    #[serde(rename = "uso_bytes")]
    pub usage_bytes: u64,
    #[serde(rename = "versao")]
    pub version: String,
}

#[tauri::command]
pub fn configuracoes() -> CommandResult<Settings> {
    let core = lock(the_core()?).map_err(text)?;
    Ok(Settings {
        server: core.config().server.as_ref().map(|s| s.url.clone()),
        preferences: core.preferences(),
        retention_days: core.config().retention_days,
        usage_bytes: core.local_usage().map_err(text)?,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub fn salvar_configuracoes<R: Runtime>(
    app: AppHandle<R>,
    preferencias: Preferences,
) -> CommandResult<()> {
    with_core(&app, |c| c.save_preferences(&preferencias))
}

#[tauri::command]
pub fn sair<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    with_core(&app, Core::sign_out)
}

/// The device language the UI reads from `navigator.languages`: the core resolves the locale from
/// the account's, then this one, then `en`.
#[tauri::command]
pub fn report_device_locale<R: Runtime>(
    app: AppHandle<R>,
    tag: Option<String>,
) -> CommandResult<()> {
    with_core(&app, |c| c.store_device_locale(tag))
}

/// The UI became visible or went to the background (the periodic probe only runs when visible).
#[tauri::command]
pub fn visibilidade<R: Runtime>(app: AppHandle<R>, visivel: bool) -> CommandResult<()> {
    with_core(&app, |c| {
        c.set_visible(visivel);
        Ok(())
    })?;
    if visivel {
        events::cycle_in_background(&app, false);
    }
    Ok(())
}

/// A new version in `movel.json`.
#[derive(Clone, Debug, Serialize)]
pub struct Update {
    #[serde(rename = "versao")]
    pub version: String,
    #[serde(rename = "notas")]
    pub notes: Option<String>,
}

/// Reads the server's `movel.json` (through the pinned CA) and returns the new version, if any.
#[tauri::command]
pub async fn verificar_atualizacao() -> CommandResult<Option<Update>> {
    tauri::async_runtime::spawn_blocking(|| {
        let manifest = core::check_update(the_core()?, true).map_err(text)?;
        Ok(manifest.map(|m| Update {
            version: m.version,
            notes: m.notes.filter(|n| !n.trim().is_empty()),
        }))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Downloads the new version's APK, checks the SHA-256 and opens the system installer.
#[tauri::command]
pub async fn atualizar<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_eclume_gravador::RecorderExt;

        let apk = core::download_update(the_core()?).map_err(text)?;
        let opened = app
            .recorder()
            .open_installer(&apk.to_string_lossy())
            .map_err(|err| err.to_string())?;
        if opened {
            Ok(())
        } else {
            Err(
                "Permita instalar apps do eclume na tela que abriu e toque em atualizar de novo"
                    .into(),
            )
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// "Abrir na web": the uploaded recording's page in the system browser, by the paired server's
/// address.
#[tauri::command]
pub fn abrir_na_web<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<()> {
    use tauri_plugin_eclume_gravador::RecorderExt;

    let url = lock(the_core()?)
        .map_err(text)?
        .recording(&id)
        .map_err(text)?
        .web_address
        .ok_or_else(|| "A gravação ainda não foi enviada ao servidor".to_string())?;
    app.recorder().open_url(&url).map_err(|err| err.to_string())
}
