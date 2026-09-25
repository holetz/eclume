//! Notificações nativas. A pergunta "gravar esta reunião?" leva as ações Gravar e Ignorar onde o
//! SO deixa responder pela notificação — Linux (D-Bus, `notify-rust`), Windows (toast com botões,
//! `tauri-winrt-notification`) e macOS (`mac-notification-sys`) —, e a mesma pergunta fica na
//! bandeja e na janela, porque o SO pode suprimir a notificação (modo foco, não perturbe).

use eclume_detect::AppKey;
use tauri::AppHandle;

const ACTION_RECORD: &str = "gravar";
const ACTION_IGNORE: &str = "ignorar";

/// Notificação informativa, sem ação.
pub fn info(title: &str, body: &str) {
    let result = notify_rust::Notification::new()
        .appname(crate::APP_NAME)
        .summary(title)
        .body(body)
        .show();
    if let Err(err) = result {
        log::warn!("falha ao notificar \"{title}\": {err}");
    }
}

/// Pergunta se grava a reunião detectada.
pub fn ask(app: &AppHandle, key: AppKey) {
    let title = format!("Reunião no {} detectada", key.label());
    let body = "Gravar esta reunião? A pergunta também está na bandeja do eclume.".to_string();
    ask_native(app.clone(), title, body);
}

fn respond(app: &AppHandle, action: &str) {
    match action {
        ACTION_RECORD => crate::auto::answer(app, true),
        ACTION_IGNORE => crate::auto::answer(app, false),
        _ => {}
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn ask_native(app: AppHandle, title: String, body: String) {
    std::thread::spawn(move || {
        let shown = notify_rust::Notification::new()
            .appname(crate::APP_NAME)
            .summary(&title)
            .body(&body)
            .action(ACTION_RECORD, "Gravar")
            .action(ACTION_IGNORE, "Ignorar")
            .timeout(notify_rust::Timeout::Never)
            .show();
        match shown {
            Ok(handle) => handle.wait_for_action(|action| respond(&app, action)),
            Err(err) => log::warn!("falha ao notificar \"{title}\": {err}"),
        }
    });
}

#[cfg(target_os = "windows")]
fn ask_native(app: AppHandle, title: String, body: String) {
    use tauri_winrt_notification::{Duration, Toast};

    // Instalado, o toast usa o AUMID do app; em dev, o do PowerShell, que sempre existe.
    let app_id = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let handle = app.clone();
    let shown = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .duration(Duration::Long)
        .add_button("Gravar", ACTION_RECORD)
        .add_button("Ignorar", ACTION_IGNORE)
        .on_activated(move |action| {
            if let Some(action) = action {
                respond(&handle, &action);
            }
            Ok(())
        })
        .show();
    if let Err(err) = shown {
        log::warn!("falha ao notificar \"{title}\": {err}");
    }
}

#[cfg(target_os = "macos")]
fn ask_native(app: AppHandle, title: String, body: String) {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    std::thread::spawn(move || {
        // Só vale uma vez por processo; as seguintes devolvem "já definido".
        let _ = mac_notification_sys::set_application(&app.config().identifier);
        let response = Notification::new()
            .title(&title)
            .message(&body)
            .main_button(MainButton::SingleAction("Gravar"))
            .close_button("Ignorar")
            .send();
        match response {
            Ok(NotificationResponse::ActionButton(_)) => respond(&app, ACTION_RECORD),
            Ok(NotificationResponse::CloseButton(_)) => respond(&app, ACTION_IGNORE),
            Ok(_) => {}
            Err(err) => log::warn!("falha ao notificar \"{title}\": {err}"),
        }
    });
}

#[cfg(not(any(unix, target_os = "windows")))]
fn ask_native(_app: AppHandle, title: String, body: String) {
    info(&title, &body);
}
