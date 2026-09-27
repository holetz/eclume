//! Bandeja do sistema: ícone por estado e o menu de ações rápidas.
//!
//! No Linux (AppIndicator) o clique no ícone só abre o menu, então toda ação mora no menu —
//! inclusive a pergunta de reunião detectada, que ganha dois itens enquanto espera resposta.

use std::sync::Mutex;

use eclume_detect::AppKey;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::state::{AppState, AppStatus, StatusView};

const TRAY_ID: &str = "eclume";
const MENU_STATUS: &str = "status";
const MENU_TOGGLE: &str = "toggle";
const MENU_ASK_RECORD: &str = "ask-record";
const MENU_ASK_IGNORE: &str = "ask-ignore";
const MENU_SYNC: &str = "sync-now";
const MENU_OPEN_WEB: &str = "open-web";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

/// O menu em uso e os itens que mudam com o estado.
struct MenuHandles {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    /// A pergunta que o menu mostra agora.
    ask: Option<AppKey>,
}

struct TrayHandles {
    tray: TrayIcon<Wry>,
    menu: Mutex<MenuHandles>,
}

/// A bandeja está de pé: é a indicação visível que a gravação automática exige.
pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<TrayHandles>().is_some()
}

fn build_menu(app: &AppHandle, ask: Option<AppKey>) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
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
    let menu = Menu::with_items(app, &[&status])?;
    if let Some(key) = ask {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            MENU_ASK_RECORD,
            format!("Gravar a reunião do {}", key.label()),
            true,
            None::<&str>,
        )?)?;
        menu.append(&MenuItem::with_id(
            app,
            MENU_ASK_IGNORE,
            "Ignorar esta reunião",
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&toggle)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_SYNC,
        "Sincronizar agora",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_OPEN_WEB,
        "Abrir o eclume web",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_SHOW,
        "Gravações e configurações",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_QUIT,
        "Sair",
        true,
        None::<&str>,
    )?)?;
    Ok((
        menu,
        MenuHandles {
            status,
            toggle,
            ask,
        },
    ))
}

/// Cria o ícone e o menu da bandeja.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let (menu, handles) = build_menu(app, None)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(AppStatus::Idle)?)
        .tooltip(crate::APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;

    app.manage(TrayHandles {
        tray,
        menu: Mutex::new(handles),
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
                crate::sync::nudge(&app);
                crate::refresh_ui(&app);
            });
        }
        MENU_ASK_RECORD => crate::auto::answer(app, true),
        MENU_ASK_IGNORE => crate::auto::answer(app, false),
        MENU_SYNC => {
            if let Err(err) = crate::sync::sync_now(app) {
                log::error!("{err:#}");
            }
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

/// Atualiza ícone, dica e textos do menu a partir do estado; troca o menu quando a pergunta de
/// reunião aparece ou some.
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
    let Ok(mut menu) = handles.menu.lock() else {
        return;
    };
    let line = status_line(&view);
    let ask = view.pending_ask.map(|a| a.app);
    let result = (|| -> tauri::Result<()> {
        if menu.ask != ask {
            let (next, next_handles) = build_menu(app, ask)?;
            handles.tray.set_menu(Some(next))?;
            *menu = next_handles;
        }
        menu.status.set_text(&line)?;
        menu.toggle.set_text(toggle_label(view.status))?;
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

/// A linha de status do menu: o estado, o app e o modo da gravação, a reunião esperando
/// resposta e quantas gravações faltam sincronizar.
pub fn status_line(view: &StatusView) -> String {
    let mut parts = vec![view.status.label().to_string()];
    if view.status == AppStatus::Recording {
        match (view.recording_app, view.recording_auto) {
            (Some(app), true) => parts.push(format!("{} (automático)", app.label)),
            (Some(app), false) => parts.push(app.label.to_string()),
            (None, true) => parts.push("automático".into()),
            (None, false) => {}
        }
    } else if let Some(ask) = view.pending_ask {
        parts.push(format!("reunião no {} detectada", ask.label));
    }
    match view.counts.unsynced() {
        0 => {}
        1 => parts.push("1 gravação a sincronizar".into()),
        n => parts.push(format!("{n} gravações a sincronizar")),
    }
    parts.join(" · ")
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
    use crate::state::MeetingView;

    fn view(status: AppStatus, pending: u32) -> StatusView {
        StatusView {
            status,
            recording_id: None,
            recording_started_at: None,
            recording_kind: None,
            note_silence_s: Some(4),
            recording_auto: false,
            recording_app: None,
            meeting: None,
            pending_ask: None,
            counts: QueueCounts {
                pending,
                ..QueueCounts::default()
            },
            web_url: String::new(),
            notice: None,
            sync_notice: None,
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
    fn bandeja_mostra_gravacao_automatica_e_pergunta() {
        let mut auto = view(AppStatus::Recording, 0);
        auto.recording_auto = true;
        auto.recording_app = Some(MeetingView::from(AppKey::Teams));
        assert_eq!(
            status_line(&auto),
            "Gravando · Microsoft Teams (automático)"
        );
        let mut asking = view(AppStatus::Idle, 2);
        asking.pending_ask = Some(MeetingView::from(AppKey::Zoom));
        assert_eq!(
            status_line(&asking),
            "Ocioso · reunião no Zoom detectada · 2 gravações a sincronizar"
        );
    }

    #[test]
    fn bandeja_icones_decodificam() {
        for status in [AppStatus::Idle, AppStatus::Recording, AppStatus::Syncing] {
            let image = icon(status).unwrap();
            assert_eq!((image.width(), image.height()), (64, 64));
        }
    }
}
