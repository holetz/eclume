//! App desktop do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus, mantém a fila
//! local de gravações e fica na bandeja do sistema.

pub mod capture;
mod commands;
pub mod config;
pub mod state;
mod tray;
mod updater;

use std::time::Duration;

use anyhow::Context;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

/// Nome exibido na janela e na bandeja do sistema.
pub const APP_NAME: &str = "eclume";

/// Evento que a janela escuta para se atualizar.
const STATUS_EVENT: &str = "status-changed";

/// Atualiza tudo que mostra o estado: a bandeja e a janela.
pub(crate) fn refresh_ui(app: &AppHandle) {
    tray::refresh(app);
    let _ = app.emit(STATUS_EVENT, ());
}

/// Mostra e foca a janela principal (criada oculta).
pub(crate) fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Abre o eclume web no navegador padrão.
pub(crate) fn open_web(app: &AppHandle, state: &AppState) -> anyhow::Result<()> {
    let url = state.web_url()?;
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

/// Fecha, a cada segundo, a gravação cujas fontes caíram sozinhas.
fn spawn_reaper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        match app.state::<AppState>().reap_finished() {
            Ok(true) => refresh_ui(&app),
            Ok(false) => {}
            Err(err) => log::error!("falha ao fechar gravação encerrada: {err:#}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::open(&data_dir, &config_dir)?;
            log::info!("dados em {}", data_dir.display());
            app.manage(state);
            tray::build(app.handle())?;
            // No macOS, o app vive na barra de menus, sem ícone no Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            spawn_reaper(app.handle().clone());
            updater::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar a janela só a esconde: o app segue na bandeja.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::recordings,
            commands::toggle_recording,
            commands::open_web,
            commands::set_web_url,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app desktop do eclume");
}

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn nome_do_app() {
        assert_eq!(APP_NAME, "eclume");
    }
}
