//! Notificações nativas, com os textos do frame "Notifications" do DS. A pergunta "gravar esta
//! reunião?" leva as ações Gravar e Agora não onde o
//! SO deixa responder pela notificação — Linux (D-Bus, `notify-rust`), Windows (toast com botões,
//! `tauri-winrt-notification`) e macOS (`mac-notification-sys`) —, e a mesma pergunta fica na
//! bandeja e na janela, porque o SO pode suprimir a notificação (modo foco, não perturbe).

use eclume_detect::AppKey;
use tauri::AppHandle;

const ACTION_RECORD: &str = "gravar";
const ACTION_IGNORE: &str = "ignorar";
const LABEL_RECORD: &str = "Gravar";
const LABEL_IGNORE: &str = "Agora não";

/// O que o app avisa por notificação.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// Uma reunião foi detectada e a política pede para perguntar.
    Detected(AppKey),
    /// A gravação automática começou.
    Recording(AppKey),
    /// A reunião gravada automaticamente acabou.
    MeetingEnded(Option<i64>),
    NoteSaved(Option<i64>),
    NoteDiscarded,
    /// "Nova nota" com outra gravação em andamento.
    Busy,
}

impl Notice {
    /// Título e corpo.
    pub fn text(self) -> (String, String) {
        let duration = |ms: Option<i64>| short_duration(ms.unwrap_or(0));
        match self {
            Self::Detected(key) => (
                "Reunião detectada".into(),
                format!("{} está usando o microfone. Gravar?", key.label()),
            ),
            Self::Recording(key) => (
                "Gravando".into(),
                format!("{} · pare pelo ícone da bandeja", key.label()),
            ),
            Self::MeetingEnded(ms) => (
                "Reunião encerrada".into(),
                format!("{} · enviando ao servidor", duration(ms)),
            ),
            Self::NoteSaved(ms) => (
                "Nota salva".into(),
                format!("{} · processando no servidor", duration(ms)),
            ),
            Self::NoteDiscarded => ("Nota descartada".into(), "não ouvimos voz".into()),
            Self::Busy => (
                "Já há uma gravação em andamento".into(),
                "Pare a gravação atual para gravar uma nota.".into(),
            ),
        }
    }
}

/// Mostra um aviso sem ação.
pub fn show(notice: Notice) {
    let (title, body) = notice.text();
    info(&title, &body);
}

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

/// A nota foi para a fila.
pub fn note_saved(duration_ms: Option<i64>) {
    show(Notice::NoteSaved(duration_ms));
}

/// A nota não teve voz e foi descartada.
pub fn note_discarded() {
    show(Notice::NoteDiscarded);
}

/// "Nova nota" com outra gravação em andamento.
pub fn busy() {
    show(Notice::Busy);
}

/// "42 s", "3 min" ou "1 h 05 min".
pub fn short_duration(ms: i64) -> String {
    let seconds = (ms.max(0) + 500) / 1000;
    if seconds < 60 {
        return format!("{} s", seconds.max(1));
    }
    let minutes = (seconds + 30) / 60;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    format!("{} h {:02} min", minutes / 60, minutes % 60)
}

/// Pergunta se grava a reunião detectada (a pergunta também fica na bandeja e na janela).
pub fn ask(app: &AppHandle, key: AppKey) {
    let (title, body) = Notice::Detected(key).text();
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
            .action(ACTION_RECORD, LABEL_RECORD)
            .action(ACTION_IGNORE, LABEL_IGNORE)
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
        .add_button(LABEL_RECORD, ACTION_RECORD)
        .add_button(LABEL_IGNORE, ACTION_IGNORE)
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
            .main_button(MainButton::SingleAction(LABEL_RECORD))
            .close_button(LABEL_IGNORE)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textos_do_frame_notifications() {
        let text = |n: Notice| {
            let (title, body) = n.text();
            format!("{title} · {body}")
        };
        assert_eq!(
            text(Notice::Detected(AppKey::Zoom)),
            "Reunião detectada · Zoom está usando o microfone. Gravar?"
        );
        assert_eq!(
            text(Notice::Recording(AppKey::Zoom)),
            "Gravando · Zoom · pare pelo ícone da bandeja"
        );
        assert_eq!(
            text(Notice::MeetingEnded(Some(54 * 60_000))),
            "Reunião encerrada · 54 min · enviando ao servidor"
        );
        assert_eq!(
            text(Notice::NoteSaved(Some(42_000))),
            "Nota salva · 42 s · processando no servidor"
        );
        assert_eq!(
            text(Notice::NoteDiscarded),
            "Nota descartada · não ouvimos voz"
        );
        assert_eq!((LABEL_RECORD, LABEL_IGNORE), ("Gravar", "Agora não"));
    }

    #[test]
    fn duracao_curta_da_notificacao() {
        assert_eq!(short_duration(0), "1 s");
        assert_eq!(short_duration(42_300), "42 s");
        assert_eq!(short_duration(59_400), "59 s");
        assert_eq!(short_duration(3 * 60_000 + 10_000), "3 min");
        assert_eq!(short_duration(54 * 60_000), "54 min");
        assert_eq!(short_duration(65 * 60_000), "1 h 05 min");
    }
}
