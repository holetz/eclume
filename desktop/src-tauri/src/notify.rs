//! Native notifications, with text from the DS "Notifications" frame. The question "record this
//! meeting?" has Record and Not now actions; a ready summary has Copy and Open; other processing
//! outcomes (failed summary, ready without a summary, failed transcription) have Open, where the
//! OS supports notification responses — Linux (D-Bus, `notify-rust`), Windows (toast with buttons,
//! `tauri-winrt-notification`) and macOS (`mac-notification-sys`). The same question stays in the
//! tray and window because the OS may suppress notifications (focus mode, do not disturb).
//!
//! On Windows, every notice uses a toast with the installed app's AUMID to show eclume's name
//! and icon (PowerShell's only in dev). On Linux, actions wait at most
//! [`ACTIONS_DEADLINE`]: once it expires, the notification closes and the thread ends.

use std::sync::Arc;
#[cfg(all(unix, not(target_os = "macos")))]
use std::time::Duration;

use eclume_detect::AppKey;
use eclume_recorder::session::StopReason;
use eclume_sync::{Ended, Outcome};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

const ACTION_RECORD: &str = "record";
const ACTION_IGNORE: &str = "ignore";
const LABEL_RECORD: &str = "Gravar";
const LABEL_IGNORE: &str = "Agora não";
const ACTION_COPY: &str = "copy";
const ACTION_OPEN: &str = "open";
const LABEL_COPY: &str = "Copiar";
const LABEL_OPEN: &str = "Abrir";
/// How long a notification with actions waits for a response on Linux. The question and summary
/// stay in the tray, window and web, so it can expire.
#[cfg(all(unix, not(target_os = "macos")))]
const ACTIONS_DEADLINE: Duration = Duration::from_secs(15 * 60);

/// The toast AUMID: the app `identifier`, saved by [`init`].
#[cfg(target_os = "windows")]
static APP_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Two `(id, label)` actions: the primary one and the other.
type Actions = &'static [(&'static str, &'static str)];
/// What to do with the chosen action (its id).
type OnAction = Arc<dyn Fn(&AppHandle, &str) + Send + Sync>;

/// What the app announces through notifications.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// A meeting was detected and the policy requires asking.
    Detected(AppKey),
    /// Automatic recording started.
    Recording(AppKey),
    /// The automatically recorded meeting ended.
    MeetingEnded(Option<i64>),
    NoteSaved(Option<i64>),
    NoteDiscarded,
    /// New voice note requested while another recording is in progress.
    Busy,
    /// The recording stopped on its own (sources dropped or a failure), with the saved duration.
    RecordingStopped(Option<i64>, StopReason),
    /// The microphone has been unavailable for over 5 s and recording continues without it.
    MicLost,
}

impl Notice {
    /// Title and body.
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
            Self::MicLost => (
                "Microfone perdido".into(),
                "gravando sem a sua voz, tentando reconectar".into(),
            ),
            Self::RecordingStopped(ms, reason) => (
                "A gravação parou".into(),
                format!(
                    "{} salvos · {}",
                    duration(ms),
                    if reason == StopReason::SourcesEnded {
                        "as fontes de áudio caíram"
                    } else {
                        "falha ao gravar"
                    }
                ),
            ),
        }
    }
}

/// Show a notice without an action.
pub fn show(notice: Notice) {
    let (title, body) = notice.text();
    info(&title, &body);
}

/// Save what notifications need from the app (the Windows AUMID); called during setup.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    let _ = APP_ID.set(app.config().identifier.clone());
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// The toast AUMID: the installed app's; in dev (or before [`init`]), PowerShell's, which
/// always exists.
#[cfg(target_os = "windows")]
fn toast_app_id() -> String {
    use tauri_winrt_notification::Toast;

    match APP_ID.get() {
        Some(id) if !tauri::is_dev() => id.clone(),
        _ => Toast::POWERSHELL_APP_ID.to_string(),
    }
}

/// Informational notification, without an action.
#[cfg(target_os = "windows")]
pub fn info(title: &str, body: &str) {
    use tauri_winrt_notification::Toast;

    let result = Toast::new(&toast_app_id()).title(title).text1(body).show();
    if let Err(err) = result {
        log::warn!("failed to notify \"{title}\": {err}");
    }
}

/// Informational notification, without an action.
#[cfg(not(target_os = "windows"))]
pub fn info(title: &str, body: &str) {
    let result = notify_rust::Notification::new()
        .appname(crate::APP_NAME)
        .summary(title)
        .body(body)
        .show();
    if let Err(err) = result {
        log::warn!("failed to notify \"{title}\": {err}");
    }
}

/// The voice note went into the queue.
pub fn note_saved(duration_ms: Option<i64>) {
    show(Notice::NoteSaved(duration_ms));
}

/// The voice note had no speech and was discarded.
pub fn note_discarded() {
    show(Notice::NoteDiscarded);
}

/// The recording stopped on its own: sources dropped or recording failed.
pub fn recording_stopped(duration_ms: Option<i64>, reason: StopReason) {
    show(Notice::RecordingStopped(duration_ms, reason));
}

/// The microphone for the current recording has been unavailable for over 5 s.
pub fn mic_lost() {
    show(Notice::MicLost);
}

/// New voice note requested while another recording is in progress.
pub fn busy() {
    show(Notice::Busy);
}

/// "42 s", "3 min" or "1 h 05 min".
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

/// Ask whether to record the detected meeting (the question also stays in the tray and window).
pub fn ask(app: &AppHandle, key: AppKey) {
    let (title, body) = Notice::Detected(key).text();
    with_actions(
        app.clone(),
        title,
        body,
        &[(ACTION_RECORD, LABEL_RECORD), (ACTION_IGNORE, LABEL_IGNORE)],
        Arc::new(respond),
    );
}

/// How many outcomes per pass get individual notices; above this, use a grouped notice.
pub const GROUP_ABOVE: usize = 3;

/// The reason text for a skipped summary (the same as `MOTIVOS` in `ui/js/vocabulario.js`); an
/// unknown code appears as is, just as in the window.
fn reason_text(reason: Option<&str>) -> String {
    match reason {
        Some("no_provider") => "nenhum agente configurado; fale com quem administra".into(),
        Some("no_agenda_type") => "a gravação não tem tipo de agenda".into(),
        Some(code) => code.into(),
        None => "sem motivo informado".into(),
    }
}

/// Title and body of a processing outcome notice.
pub fn outcome_text(
    outcome: Outcome,
    recording_title: &str,
    reason: Option<&str>,
) -> (String, String) {
    let name = if recording_title.trim().is_empty() {
        "Gravação"
    } else {
        recording_title
    };
    match outcome {
        Outcome::SummaryReady => (
            "Resumo pronto".into(),
            format!("{name} · copie para compartilhar"),
        ),
        Outcome::SummaryFailed => (
            "O resumo falhou".into(),
            format!("{name} · abra para gerar de novo"),
        ),
        Outcome::NoSummary => (
            "Pronta sem resumo".into(),
            format!("{name} · {}", reason_text(reason)),
        ),
        Outcome::TranscriptionFailed => (
            "A transcrição falhou".into(),
            format!("{name} · abra para ver o motivo"),
        ),
        Outcome::AwaitingSpeakers => (
            "Precisa de você".into(),
            format!("{name} · nomeie os locutores para seguir com o resumo"),
        ),
    }
}

/// Title and body of the grouped notice when many recordings finish in the same pass.
pub fn grouped_text(count: usize) -> (String, String) {
    (
        format!("{count} gravações processadas"),
        "Abra a biblioteca para ver os resumos e as falhas".into(),
    )
}

/// A processing outcome for an account recording. A ready summary with Markdown has Copy
/// (put the summary on the clipboard) and Open; others have only Open (the recording on the web).
pub fn outcome(app: &AppHandle, ended: &Ended, markdown: Option<String>, url: String) {
    let (title, body) = outcome_text(ended.outcome, &ended.title, ended.reason.as_deref());
    let actions: Actions = if ended.outcome == Outcome::SummaryReady && markdown.is_some() {
        &[(ACTION_COPY, LABEL_COPY), (ACTION_OPEN, LABEL_OPEN)]
    } else {
        &[(ACTION_OPEN, LABEL_OPEN)]
    };
    let on_action: OnAction = Arc::new(move |app, action| match action {
        ACTION_COPY => {
            if let Some(markdown) = &markdown {
                if let Err(err) = app.clipboard().write_text(markdown.clone()) {
                    log::warn!("failed to copy summary: {err}");
                }
            }
        }
        ACTION_OPEN => open(app, &url),
        _ => {}
    });
    with_actions(app.clone(), title, body, actions, on_action);
}

/// Many outcomes at once: a single notice that opens the web library.
pub fn outcomes_grouped(app: &AppHandle, count: usize, url: String) {
    let (title, body) = grouped_text(count);
    let on_action: OnAction = Arc::new(move |app, action| {
        if action == ACTION_OPEN {
            open(app, &url);
        }
    });
    with_actions(
        app.clone(),
        title,
        body,
        &[(ACTION_OPEN, LABEL_OPEN)],
        on_action,
    );
}

fn open(app: &AppHandle, url: &str) {
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        log::warn!("failed to open {url}: {err}");
    }
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
            .timeout(notify_rust::Timeout::Milliseconds(
                u32::try_from(ACTIONS_DEADLINE.as_millis()).unwrap_or(u32::MAX),
            ));
        for (id, label) in actions {
            notification.action(id, label);
        }
        match notification.show() {
            Ok(handle) => {
                let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
                close_after_deadline(notification, handle.id(), Arc::clone(&answered));
                handle.wait_for_action(|action| on(&app, action));
                answered.store(true, std::sync::atomic::Ordering::Release);
            }
            Err(err) => log::warn!("failed to notify \"{title}\": {err}"),
        }
    });
}

/// After the deadline without a response, close notification `id`: the server emits the closure
/// and [`with_actions`] stops waiting. GNOME ignores the requested notification timeout, hence
/// the explicit closure.
#[cfg(all(unix, not(target_os = "macos")))]
fn close_after_deadline(
    mut notification: notify_rust::Notification,
    id: u32,
    answered: Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        std::thread::sleep(ACTIONS_DEADLINE);
        if answered.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        // Replace the same notification (same id) just to get the handle that closes it.
        match notification.id(id).show() {
            Ok(handle) => handle.close(),
            Err(err) => log::debug!("failed to close notification {id}: {err}"),
        }
    });
}

#[cfg(target_os = "windows")]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    use tauri_winrt_notification::{Duration, Toast};

    let app_id = toast_app_id();
    let handle = app.clone();
    let mut toast = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .duration(Duration::Long);
    for (id, label) in actions {
        toast = toast.add_button(label, id);
    }
    let shown = toast
        .on_activated(move |action| {
            if let Some(action) = action {
                on(&handle, &action);
            }
            Ok(())
        })
        .show();
    if let Err(err) = shown {
        log::warn!("failed to notify \"{title}\": {err}");
    }
}

#[cfg(target_os = "macos")]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    std::thread::spawn(move || {
        // Only applies once per process; subsequent calls return "already set".
        let _ = mac_notification_sys::set_application(&app.config().identifier);
        let first = actions.first().copied();
        let second = actions.get(1).copied();
        let mut notification = Notification::new();
        notification.title(&title).message(&body);
        if let Some((_, label)) = first {
            notification.main_button(MainButton::SingleAction(label));
        }
        if let Some((_, label)) = second {
            notification.close_button(label);
        }
        match notification.send() {
            Ok(NotificationResponse::ActionButton(_)) => {
                if let Some((id, _)) = first {
                    on(&app, id);
                }
            }
            Ok(NotificationResponse::CloseButton(_)) => {
                if let Some((id, _)) = second {
                    on(&app, id);
                }
            }
            Ok(_) => {}
            Err(err) => log::warn!("failed to notify \"{title}\": {err}"),
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
    fn notifications_frame_text() {
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
        assert_eq!(
            text(Notice::RecordingStopped(
                Some(12 * 60_000),
                StopReason::SourcesEnded
            )),
            "A gravação parou · 12 min salvos · as fontes de áudio caíram"
        );
        assert_eq!(
            text(Notice::RecordingStopped(Some(42_000), StopReason::Failed)),
            "A gravação parou · 42 s salvos · falha ao gravar"
        );
        assert_eq!(
            text(Notice::MicLost),
            "Microfone perdido · gravando sem a sua voz, tentando reconectar"
        );
        assert_eq!((LABEL_RECORD, LABEL_IGNORE), ("Gravar", "Agora não"));
        assert_eq!((LABEL_COPY, LABEL_OPEN), ("Copiar", "Abrir"));
    }

    #[test]
    fn outcome_texts() {
        let text = |outcome, title: &str, reason: Option<&str>| {
            let (title, body) = outcome_text(outcome, title, reason);
            format!("{title} · {body}")
        };
        assert_eq!(
            text(Outcome::SummaryReady, "Kickoff do programa", None),
            "Resumo pronto · Kickoff do programa · copie para compartilhar"
        );
        assert_eq!(
            text(Outcome::SummaryFailed, "Kickoff", None),
            "O resumo falhou · Kickoff · abra para gerar de novo"
        );
        assert_eq!(
            text(Outcome::NoSummary, "Kickoff", Some("no_provider")),
            "Pronta sem resumo · Kickoff · nenhum agente configurado; fale com quem administra"
        );
        assert_eq!(
            text(Outcome::NoSummary, "", Some("motivo_novo")),
            "Pronta sem resumo · Gravação · motivo_novo"
        );
        assert_eq!(
            text(Outcome::TranscriptionFailed, "Kickoff", None),
            "A transcrição falhou · Kickoff · abra para ver o motivo"
        );
        assert_eq!(
            text(
                Outcome::AwaitingSpeakers,
                "Kickoff",
                Some("unnamed_speakers")
            ),
            "Precisa de você · Kickoff · nomeie os locutores para seguir com o resumo"
        );
        let (title, body) = grouped_text(5);
        assert_eq!(
            format!("{title} · {body}"),
            "5 gravações processadas · Abra a biblioteca para ver os resumos e as falhas"
        );
    }

    #[test]
    fn short_notification_duration() {
        assert_eq!(short_duration(0), "1 s");
        assert_eq!(short_duration(42_300), "42 s");
        assert_eq!(short_duration(59_400), "59 s");
        assert_eq!(short_duration(3 * 60_000 + 10_000), "3 min");
        assert_eq!(short_duration(54 * 60_000), "54 min");
        assert_eq!(short_duration(65 * 60_000), "1 h 05 min");
    }
}
