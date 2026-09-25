//! Bandeja do sistema: ícone por estado e o menu de ações rápidas.
//!
//! No Linux (AppIndicator) o clique no ícone só abre o menu, então toda ação mora no menu.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::state::{AppState, AppStatus, StatusView};

const TRAY_ID: &str = "eclume";
const MENU_STATUS: &str = "status";
const MENU_TOGGLE: &str = "toggle";
const MENU_OPEN_WEB: &str = "open-web";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

/// Os itens que mudam com o estado.
struct TrayHandles {
    tray: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

/// Cria o ícone e o menu da bandeja.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(
        app,
        MENU_STATUS,
        AppStatus::Idle.label(),
        false,
        None::<&str>,
    )?;
    let toggle = MenuItem::with_id(
        app,
        MENU_TOGGLE,
        toggle_label(AppStatus::Idle),
        true,
        None::<&str>,
    )?;
    let open_web = MenuItem::with_id(app, MENU_OPEN_WEB, "Abrir o eclume web", true, None::<&str>)?;
    let show = MenuItem::with_id(app, MENU_SHOW, "Mostrar gravações", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &open_web,
            &show,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(AppStatus::Idle)?)
        .tooltip(crate::APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;

    app.manage(TrayHandles {
        tray,
        status,
        toggle,
    });
    refresh(app);
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_TOGGLE => {
            // Abrir dispositivos pode levar segundos: fora da thread da UI.
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(err) = app
                    .state::<AppState>()
                    .toggle_recording(crate::capture::open_sources)
                {
                    log::error!("falha ao alternar a gravação: {err:#}");
                }
                crate::refresh_ui(&app);
            });
        }
        MENU_OPEN_WEB => {
            if let Err(err) = crate::open_web(app, &app.state::<AppState>()) {
                log::error!("{err:#}");
            }
        }
        MENU_SHOW => crate::show_window(app),
        MENU_QUIT => {
            let state = app.state::<AppState>();
            if state.status().is_ok_and(|s| s == AppStatus::Recording) {
                if let Err(err) = state.stop_recording() {
                    log::error!("falha ao fechar a gravação ao sair: {err:#}");
                }
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// Atualiza ícone, dica e textos do menu a partir do estado.
pub fn refresh(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let view = match app.state::<AppState>().view() {
        Ok(view) => view,
        Err(err) => {
            log::error!("falha ao ler o estado para a bandeja: {err:#}");
            return;
        }
    };
    let line = status_line(&view);
    let result = (|| -> tauri::Result<()> {
        handles.status.set_text(&line)?;
        handles.toggle.set_text(toggle_label(view.status))?;
        handles.tray.set_icon(Some(icon(view.status)?))?;
        handles
            .tray
            .set_tooltip(Some(format!("{} — {line}", crate::APP_NAME)))?;
        Ok(())
    })();
    if let Err(err) = result {
        log::error!("falha ao atualizar a bandeja: {err}");
    }
}

fn toggle_label(status: AppStatus) -> &'static str {
    if status == AppStatus::Recording {
        "Parar gravação"
    } else {
        "Iniciar gravação"
    }
}

/// A linha de status do menu: o estado e, se houver, quantas gravações faltam sincronizar.
pub fn status_line(view: &StatusView) -> String {
    match view.counts.unsynced() {
        0 => view.status.label().to_string(),
        1 => format!("{} · 1 gravação a sincronizar", view.status.label()),
        n => format!("{} · {n} gravações a sincronizar", view.status.label()),
    }
}

fn icon(status: AppStatus) -> tauri::Result<Image<'static>> {
    Image::from_bytes(match status {
        AppStatus::Idle => include_bytes!("../icons/tray-idle.png"),
        AppStatus::Recording => include_bytes!("../icons/tray-recording.png"),
        AppStatus::Syncing => include_bytes!("../icons/tray-syncing.png"),
    })
}

#[cfg(test)]
mod tests {
    use eclume_recorder::QueueCounts;

    use super::*;

    fn view(status: AppStatus, pending: u32) -> StatusView {
        StatusView {
            status,
            recording_id: None,
            recording_started_at: None,
            counts: QueueCounts {
                pending,
                ..QueueCounts::default()
            },
            web_url: String::new(),
            notice: None,
        }
    }

    #[test]
    fn bandeja_linha_de_status() {
        assert_eq!(status_line(&view(AppStatus::Idle, 0)), "Ocioso");
        assert_eq!(
            status_line(&view(AppStatus::Recording, 1)),
            "Gravando · 1 gravação a sincronizar"
        );
        assert_eq!(
            status_line(&view(AppStatus::Syncing, 3)),
            "Sincronizando · 3 gravações a sincronizar"
        );
        assert_eq!(toggle_label(AppStatus::Recording), "Parar gravação");
        assert_eq!(toggle_label(AppStatus::Idle), "Iniciar gravação");
    }

    #[test]
    fn bandeja_icones_decodificam() {
        for status in [AppStatus::Idle, AppStatus::Recording, AppStatus::Syncing] {
            let image = icon(status).unwrap();
            assert_eq!((image.width(), image.height()), (64, 64));
        }
    }
}
