//! Notificações nativas, com os textos do frame "Notifications" do DS. A pergunta "gravar esta
//! reunião?" leva as ações Gravar e Agora não, e o resumo pronto, Copiar e Abrir, onde o
//! SO deixa responder pela notificação — Linux (D-Bus, `notify-rust`), Windows (toast com botões,
//! `tauri-winrt-notification`) e macOS (`mac-notification-sys`) —, e a mesma pergunta fica na
//! bandeja e na janela, porque o SO pode suprimir a notificação (modo foco, não perturbe).

use std::sync::Arc;

use eclume_detect::AppKey;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const ACTION_RECORD: &str = "gravar";
const ACTION_IGNORE: &str = "ignorar";
const LABEL_RECORD: &str = "Gravar";
const LABEL_IGNORE: &str = "Agora não";
const ACTION_COPY: &str = "copiar";
const ACTION_OPEN: &str = "abrir";
const LABEL_COPY: &str = "Copiar";
const LABEL_OPEN: &str = "Abrir";

/// Duas ações `(id, rótulo)`: a principal e a outra.
type Actions = [(&'static str, &'static str); 2];
/// O que fazer com a ação escolhida (o id dela).
type OnAction = Arc<dyn Fn(&AppHandle, &str) + Send + Sync>;

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
    with_actions(
        app.clone(),
        title,
        body,
        [(ACTION_RECORD, LABEL_RECORD), (ACTION_IGNORE, LABEL_IGNORE)],
        Arc::new(respond),
    );
}

/// Título e corpo do aviso de resumo pronto.
pub fn summary_text(recording_title: &str) -> (String, String) {
    (
        "Resumo pronto".into(),
        format!("{recording_title} · copie para compartilhar"),
    )
}

/// O resumo automático de uma gravação enviada ficou pronto: "Copiar" põe o Markdown na área de
/// transferência e "Abrir" mostra a gravação no eclume web.
pub fn summary_ready(app: &AppHandle, recording_title: &str, markdown: String, url: String) {
    let (title, body) = summary_text(recording_title);
    let on_action: OnAction = Arc::new(move |app, action| match action {
        ACTION_COPY => {
            if let Err(err) = app.clipboard().write_text(markdown.clone()) {
                log::warn!("falha ao copiar o resumo: {err}");
            }
        }
        ACTION_OPEN => {
            if let Err(err) = app.opener().open_url(&url, None::<&str>) {
                log::warn!("falha ao abrir {url}: {err}");
            }
        }
        _ => {}
    });
    with_actions(
        app.clone(),
        title,
        body,
        [(ACTION_COPY, LABEL_COPY), (ACTION_OPEN, LABEL_OPEN)],
        on_action,
    );
}

fn respond(app: &AppHandle, action: &str) {
    match action {
        ACTION_RECORD => crate::auto::answer(app, true),
        ACTION_IGNORE => crate::auto::answer(app, false),
        _ => {}
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification
            .appname(crate::APP_NAME)
            .summary(&title)
            .body(&body)
            .timeout(notify_rust::Timeout::Never);
        for (id, label) in actions {
            notification.action(id, label);
        }
        match notification.show() {
            Ok(handle) => handle.wait_for_action(|action| on(&app, action)),
            Err(err) => log::warn!("falha ao notificar \"{title}\": {err}"),
        }
    });
}

#[cfg(target_os = "windows")]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    use tauri_winrt_notification::{Duration, Toast};

    // Instalado, o toast usa o AUMID do app; em dev, o do PowerShell, que sempre existe.
    let app_id = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let handle = app.clone();
    let [(first, first_label), (second, second_label)] = actions;
    let shown = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .duration(Duration::Long)
        .add_button(first_label, first)
        .add_button(second_label, second)
        .on_activated(move |action| {
            if let Some(action) = action {
                on(&handle, &action);
            }
            Ok(())
        })
        .show();
    if let Err(err) = shown {
        log::warn!("falha ao notificar \"{title}\": {err}");
    }
}

#[cfg(target_os = "macos")]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    std::thread::spawn(move || {
        // Só vale uma vez por processo; as seguintes devolvem "já definido".
        let _ = mac_notification_sys::set_application(&app.config().identifier);
        let [(first, first_label), (second, second_label)] = actions;
        let response = Notification::new()
            .title(&title)
            .message(&body)
            .main_button(MainButton::SingleAction(first_label))
            .close_button(second_label)
            .send();
        match response {
            Ok(NotificationResponse::ActionButton(_)) => on(&app, first),
            Ok(NotificationResponse::CloseButton(_)) => on(&app, second),
            Ok(_) => {}
            Err(err) => log::warn!("falha ao notificar \"{title}\": {err}"),
        }
    });
}

#[cfg(not(any(unix, target_os = "windows")))]
fn with_actions(_app: AppHandle, title: String, body: String, _actions: Actions, _on: OnAction) {
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
        let (title, body) = summary_text("Kickoff do programa");
        assert_eq!(
            format!("{title} · {body}"),
            "Resumo pronto · Kickoff do programa · copie para compartilhar"
        );
        assert_eq!((LABEL_COPY, LABEL_OPEN), ("Copiar", "Abrir"));
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
