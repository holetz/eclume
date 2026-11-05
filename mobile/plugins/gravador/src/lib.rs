//! The native plugin of eclume's mobile app (`eclume-gravador`). On Android, the Kotlin class
//! `GravadorPlugin` handles what only the system does: the microphone-type foreground service, with
//! the ongoing notification that records with the screen locked. Off Android (the development build
//! and the tests on Linux), the methods do nothing.
//!
//! The way back, from Kotlin to Rust, does not go through here: it is the app's `EclumeCore` JNI
//! bridge, which does not depend on the WebView being alive.
//!
//! The plugin name, the command names given to `run_mobile_plugin` and the JSON keys exchanged with
//! the Kotlin side are the plugin's wire contract and keep their original (pt-BR) names.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// The plugin's Kotlin package.
pub const ANDROID_PACKAGE: &str = "io.github.holetz.eclume.movel.gravador";

/// The error of a call to the native side; off the phone, no call fails.
#[cfg(mobile)]
pub type Error = tauri::plugin::mobile::PluginInvokeError;
#[cfg(not(mobile))]
pub type Error = std::convert::Infallible;

pub type PluginResult<T> = Result<T, Error>;

/// The device: battery, free space, network, model and the edge-to-edge insets (in dp).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DeviceState {
    #[serde(rename = "bateria")]
    pub battery: u8,
    #[serde(rename = "carregando")]
    pub charging: bool,
    #[serde(rename = "espacoLivre")]
    pub free_space: u64,
    #[serde(rename = "wifiNaoMedido")]
    pub unmetered_wifi: bool,
    #[serde(rename = "modelo")]
    pub model: String,
    #[serde(rename = "insetTopo")]
    pub inset_top: f64,
    #[serde(rename = "insetBase")]
    pub inset_bottom: f64,
    /// The app's notifications are allowed.
    #[serde(rename = "notificacoes", default = "yes")]
    pub notifications: bool,
    /// The battery-optimization exemption: `concedida`, `pedir` or `recusada`.
    #[serde(rename = "isencaoDeBateria", default = "granted")]
    pub battery_exemption: String,
}

fn yes() -> bool {
    true
}

fn granted() -> String {
    "concedida".into()
}

/// An `_eclume._tcp` announcement found by `NsdManager`, with the raw TXT.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct Announcement {
    #[serde(rename = "nome")]
    pub name: String,
    pub txt: std::collections::BTreeMap<String, String>,
}

#[cfg(mobile)]
#[derive(serde::Deserialize)]
struct Announcements {
    #[serde(rename = "servicos")]
    services: Vec<Announcement>,
}

/// The access to the plugin, kept in the app's state.
pub struct Recorder<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(mobile))]
    _app: tauri::AppHandle<R>,
}

impl<R: Runtime> Recorder<R> {
    #[cfg(mobile)]
    fn call<T: serde::de::DeserializeOwned>(&self, command: &str) -> PluginResult<T> {
        self.handle.run_mobile_plugin(command, ())
    }

    /// Starts the foreground service (the tap on Gravar, with the Activity visible) and waits:
    /// Kotlin only answers after `startForeground`, or rejects with the refusal's reason
    /// (`ForegroundServiceStartNotAllowedException`, `SecurityException`, a 5 s deadline).
    pub fn start_service(&self) -> PluginResult<()> {
        #[cfg(mobile)]
        self.call::<serde_json::Value>("iniciarServico")?;
        Ok(())
    }

    /// Schedules WorkManager's sync work, which waits for unmetered Wi-Fi (`delay_ms`: the
    /// saved-recording sheet's deadline on stop; zero on save). Chains after a running sync,
    /// without cancelling it.
    pub fn schedule_sync(&self, delay_ms: u64) -> PluginResult<()> {
        #[cfg(mobile)]
        self.handle.run_mobile_plugin::<serde_json::Value>(
            "agendarSync",
            serde_json::json!({ "atrasoMs": delay_ms }),
        )?;
        #[cfg(not(mobile))]
        let _ = delay_ms;
        Ok(())
    }

    /// Redraws the notification from the core's current state.
    pub fn update_service(&self) -> PluginResult<()> {
        #[cfg(mobile)]
        self.call::<serde_json::Value>("atualizarServico")?;
        Ok(())
    }

    /// The device state. Off the phone (development), a device plugged in and on Wi-Fi.
    pub fn device_state(&self) -> PluginResult<DeviceState> {
        #[cfg(mobile)]
        return self.call("estadoDoDispositivo");
        #[cfg(not(mobile))]
        Ok(DeviceState {
            battery: 100,
            charging: true,
            free_space: 64 * 1_000_000_000,
            unmetered_wifi: true,
            model: "computador".into(),
            inset_top: 0.0,
            inset_bottom: 0.0,
            notifications: true,
            battery_exemption: granted(),
        })
    }

    /// Looks for `_eclume._tcp` for `seconds` through `NsdManager` (blocks). Off the phone,
    /// discovery is the sync crate's, and this finds nothing.
    pub fn discover(&self, seconds: u32) -> PluginResult<Vec<Announcement>> {
        #[cfg(mobile)]
        return self
            .handle
            .run_mobile_plugin::<Announcements>(
                "descobrir",
                serde_json::json!({ "segundos": seconds }),
            )
            .map(|a| a.services);
        #[cfg(not(mobile))]
        {
            let _ = seconds;
            Ok(Vec::new())
        }
    }

    /// Opens the system installer for the APK at `path` (in the app's cache). Returns `false` when
    /// the system first went to ask for the permission to install from unknown sources.
    pub fn open_installer(&self, path: &str) -> PluginResult<bool> {
        #[cfg(mobile)]
        {
            #[derive(serde::Deserialize)]
            struct Opened {
                #[serde(rename = "aberto")]
                opened: bool,
            }
            return self
                .handle
                .run_mobile_plugin::<Opened>(
                    "abrirInstalador",
                    serde_json::json!({ "caminho": path }),
                )
                .map(|r| r.opened);
        }
        #[cfg(not(mobile))]
        {
            let _ = path;
            Ok(false)
        }
    }

    /// Opens `url` in the system browser (Intent `ACTION_VIEW`).
    pub fn open_url(&self, url: &str) -> PluginResult<()> {
        #[cfg(mobile)]
        self.handle.run_mobile_plugin::<serde_json::Value>(
            "abrirUrl",
            serde_json::json!({ "url": url }),
        )?;
        #[cfg(not(mobile))]
        let _ = url;
        Ok(())
    }

    /// Removes the notification and stops the service. With `stopped` (the recording stopped without
    /// being asked: the reason and the saved time), the service shows the recording-stopped notice
    /// on the warnings channel before exiting.
    pub fn stop_service(&self, stopped: Option<(&str, i64)>) -> PluginResult<()> {
        #[cfg(mobile)]
        self.handle.run_mobile_plugin::<serde_json::Value>(
            "pararServico",
            match stopped {
                Some((reason, duration_ms)) => {
                    serde_json::json!({ "motivo": reason, "duracaoMs": duration_ms })
                }
                None => serde_json::json!({}),
            },
        )?;
        #[cfg(not(mobile))]
        let _ = stopped;
        Ok(())
    }
}

/// The access to the plugin from an `App`, `AppHandle` or window.
pub trait RecorderExt<R: Runtime> {
    fn recorder(&self) -> &Recorder<R>;
}

impl<R: Runtime, T: Manager<R>> RecorderExt<R> for T {
    fn recorder(&self) -> &Recorder<R> {
        self.state::<Recorder<R>>().inner()
    }
}

/// Registers the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("eclume-gravador")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let recorder = Recorder {
                handle: api.register_android_plugin(ANDROID_PACKAGE, "GravadorPlugin")?,
            };
            #[cfg(target_os = "ios")]
            let recorder: Recorder<R> = {
                let _ = api;
                return Err("the recorder plugin has no iOS side yet".into());
            };
            #[cfg(not(mobile))]
            let recorder = {
                let _ = api;
                Recorder { _app: app.clone() }
            };
            app.manage(recorder);
            Ok(())
        })
        .build()
}
