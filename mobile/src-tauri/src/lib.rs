//! Eclume's mobile app: the Tauri shell over `eclume-mobile-core`. The commands ([`comandos`]) and
//! the `estado` event ([`eventos`]) link the UI to the process's core; on Android, the JNI bridge
//! (`jni`) links the native plugin (recording service, notification, WorkManager) to the same
//! core, without depending on the WebView.

mod comandos;
mod eventos;
#[cfg(target_os = "android")]
mod jni;

use eclume_mobile_core::config::Dirs;
use eclume_recorder::AudioSource;
use tauri::{Manager, Runtime};

/// The app's version (`tauri.conf.json` and `Cargo.toml` move together).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The default microphone, at 16 kHz mono through the recorder's mixer.
pub(crate) fn microphone() -> anyhow::Result<Box<dyn AudioSource>> {
    Ok(Box::new(eclume_audio_capture::MicSource::open()?))
}

/// The reply of a JNI bridge call, isolated from panics: an error becomes `{"erro": …}` and a panic
/// becomes `{"erro": "pânico: …"}`, without aborting the process (the workspace does not use
/// `panic = "abort"`). It stays outside `cfg(android)` so it is tested on the host. The `erro` key
/// is the bridge's wire format with the Kotlin side and is kept.
// Used only by the Android bridge; the tests exercise it on the host.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn reply(f: impl FnOnce() -> anyhow::Result<serde_json::Value>) -> serde_json::Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(value)) => value,
        Ok(Err(err)) => serde_json::json!({ "erro": format!("{err:#}") }),
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|m| (*m).to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "sem mensagem".into());
            log::error!("panic in the JNI bridge: {message}");
            serde_json::json!({ "erro": format!("pânico: {message}") })
        }
    }
}

/// The core's directories from the app's data folder: `eclume/` for config, CA, queue and
/// recordings, and `no_backup/` (Android's `noBackupFilesDir`) for the token.
pub(crate) fn dirs_from(base: &std::path::Path) -> Dirs {
    Dirs {
        data: base.join("eclume"),
        no_backup: base.join("no_backup"),
    }
}

/// Android's foreground service (notification and microphone with the screen locked), through the
/// `gravador` plugin. The Kotlin side answers on the caller's thread: `start` blocks (`gravar`
/// calls it on a blocking thread) and the other calls run on a thread of their own.
pub(crate) mod service {
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_eclume_gravador::GravadorExt;

    fn in_background<R: Runtime>(
        app: &AppHandle<R>,
        what: &'static str,
        f: fn(
            &tauri_plugin_eclume_gravador::Gravador<R>,
        ) -> tauri_plugin_eclume_gravador::Resultado<()>,
    ) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = f(app.gravador()) {
                log::warn!("recording service ({what}): {err}");
            }
        });
    }

    /// Starts the service and waits for the foreground (blocks; never on the main thread).
    pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
        app.gravador()
            .iniciar_servico()
            .map_err(|err| err.to_string())
    }

    pub fn update<R: Runtime>(app: &AppHandle<R>) {
        in_background(app, "update", |g| g.atualizar_servico());
    }

    pub fn stop<R: Runtime>(app: &AppHandle<R>) {
        in_background(app, "stop", |g| g.parar_servico(None));
    }

    /// Schedules the WorkManager sync to upload with the app closed (off the command's thread).
    pub fn schedule_sync<R: Runtime>(app: &AppHandle<R>, delay: std::time::Duration) {
        let app = app.clone();
        let delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
        std::thread::spawn(move || {
            if let Err(err) = app.gravador().agendar_sync(delay_ms) {
                log::warn!("scheduling the sync: {err}");
            }
        });
    }

    /// The recording stopped without being asked: the service shows the recording-stopped notice
    /// with the reason and exits.
    pub fn stop_with_warning<R: Runtime>(
        app: &AppHandle<R>,
        reason: &'static str,
        duration_ms: i64,
    ) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = app.gravador().parar_servico(Some((reason, duration_ms))) {
                log::warn!("recording service (stop with warning): {err}");
            }
        });
    }
}

/// A server found on the network, already parsed by the sync crate's TXT parser. Serialized to the
/// UI; the keys keep their names.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Found {
    #[serde(rename = "nome")]
    pub name: String,
    pub url: String,
    pub ca_sha256: Option<String>,
}

/// Looks for the server on the network for `segundos` seconds: on Android, through the plugin's
/// `NsdManager`; in development, through the sync crate's mDNS. The command and argument names are
/// the IPC contract and are kept.
#[tauri::command]
async fn descobrir<R: Runtime>(
    app: tauri::AppHandle<R>,
    segundos: u32,
) -> Result<Vec<Found>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(mobile)]
        let found = {
            use tauri_plugin_eclume_gravador::GravadorExt;
            app.gravador()
                .descobrir(segundos)
                .map_err(|err| err.to_string())?
                .into_iter()
                .filter_map(|announcement| {
                    let txt: Vec<(String, String)> = announcement.txt.into_iter().collect();
                    eclume_sync::discovery::parse(&announcement.nome, &txt)
                })
                .collect::<Vec<_>>()
        };
        #[cfg(not(mobile))]
        let found = {
            let _ = &app;
            eclume_sync::discovery::discover(std::time::Duration::from_secs(u64::from(segundos)))
                .map_err(|err| format!("{err:#}"))?
        };
        Ok(found
            .into_iter()
            .map(|f| Found {
                name: f.name,
                url: f.url,
                ca_sha256: f.ca_sha256,
            })
            .collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Reads the device every few seconds (battery, space, unmetered Wi-Fi) and hands it to the core; a
/// network change fires the cycle (the probe runs again).
fn watch_device<R: Runtime>(app: tauri::AppHandle<R>) {
    use tauri_plugin_eclume_gravador::GravadorExt;

    std::thread::spawn(move || {
        let mut model_set = false;
        loop {
            match app.gravador().estado_do_dispositivo() {
                Ok(device) => {
                    let changed = eclume_mobile_core::global()
                        .and_then(|core| eclume_mobile_core::lock(core).ok())
                        .map(|mut core| {
                            if !model_set {
                                model_set = core.set_device(&device.modelo).is_ok();
                            }
                            core.update_device(
                                device.bateria,
                                device.carregando,
                                device.espaco_livre,
                            );
                            core.network_changed(device.wifi_nao_medido)
                        })
                        .unwrap_or(false);
                    if changed {
                        eventos::cycle_in_background(&app, false);
                    }
                }
                Err(err) => log::warn!("device state: {err}"),
            }
            std::thread::sleep(DEVICE_INTERVAL);
        }
    });
}

/// How often the device is read.
const DEVICE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

fn init_log() {
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("eclume"),
    );
}

fn open_core<R: Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<()> {
    let base = app.path().app_data_dir()?;
    log::info!("app data in {}", base.display());
    eclume_mobile_core::init(dirs_from(&base), VERSION)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_log();
    let builder = tauri::Builder::default().plugin(tauri_plugin_eclume_gravador::init());
    // The QR reader (camera) only exists on the phone.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .setup(|app| {
            open_core(app.handle())?;
            watch_device(app.handle().clone());
            eventos::start_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            descobrir,
            comandos::estado,
            comandos::conectar_descoberto,
            comandos::conectar_endereco,
            comandos::confiar_ca,
            comandos::cancelar_ca,
            comandos::entrar,
            comandos::parear,
            comandos::gravar,
            comandos::pausar,
            comandos::continuar,
            comandos::marcar,
            comandos::anotar_marcador,
            comandos::parar,
            comandos::salvar,
            comandos::sincronizar_agora,
            comandos::gravacoes,
            comandos::gravacao,
            comandos::excluir_local,
            comandos::excluir_sincronizadas,
            comandos::tipos_de_agenda,
            comandos::idiomas,
            comandos::configuracoes,
            comandos::salvar_configuracoes,
            comandos::sair,
            comandos::visibilidade,
            comandos::verificar_atualizacao,
            comandos::atualizar,
            comandos::abrir_na_web,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start eclume's mobile app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_turns_error_and_panic_into_json() {
        assert_eq!(
            reply(|| Ok(serde_json::json!({ "ok": true }))),
            serde_json::json!({ "ok": true })
        );
        assert_eq!(
            reply(|| Err(anyhow::anyhow!("sem sessão"))),
            serde_json::json!({ "erro": "sem sessão" })
        );
        assert_eq!(
            reply(|| panic!("núcleo quebrado")),
            serde_json::json!({ "erro": "pânico: núcleo quebrado" })
        );
        let dynamic = String::from("índice 3");
        assert_eq!(
            reply(move || panic!("{dynamic}")),
            serde_json::json!({ "erro": "pânico: índice 3" })
        );
    }

    #[test]
    fn token_stays_outside_the_data_folder() {
        let dirs = dirs_from(std::path::Path::new(
            "/data/user/0/io.github.holetz.eclume.movel",
        ));
        assert!(dirs.data.ends_with("eclume"));
        assert!(dirs.token().starts_with(&dirs.no_backup));
        assert!(!dirs.token().starts_with(&dirs.data));
    }
}
