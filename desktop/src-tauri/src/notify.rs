//! Notificações nativas, com os textos do frame "Notifications" do DS. A pergunta "gravar esta
//! reunião?" leva as ações Gravar e Agora não, o resumo pronto, Copiar e Abrir, e os outros
//! desfechos do processamento (resumo que falhou, pronta sem resumo, transcrição que falhou), Abrir, onde o
//! SO deixa responder pela notificação — Linux (D-Bus, `notify-rust`), Windows (toast com botões,
//! `tauri-winrt-notification`) e macOS (`mac-notification-sys`) —, e a mesma pergunta fica na
//! bandeja e na janela, porque o SO pode suprimir a notificação (modo foco, não perturbe).
//!
//! No Windows, todo aviso sai pelo toast com o AUMID do app instalado, para ter o nome e o ícone
//! do eclume (o do PowerShell só em dev). No Linux, as ações esperam no máximo
//! [`ACTIONS_DEADLINE`]: vencido o prazo, a notificação é fechada e a thread termina.

use std::sync::Arc;
#[cfg(all(unix, not(target_os = "macos")))]
use std::time::Duration;

use eclume_detect::AppKey;
use eclume_recorder::session::StopReason;
use eclume_sync::{Ended, Outcome};
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
/// Quanto uma notificação com ações espera resposta no Linux. A pergunta e o resumo seguem na
/// bandeja, na janela e no web, então ela pode expirar.
#[cfg(all(unix, not(target_os = "macos")))]
const ACTIONS_DEADLINE: Duration = Duration::from_secs(15 * 60);

/// O AUMID dos toasts: o `identifier` do app, guardado por [`init`].
#[cfg(target_os = "windows")]
static APP_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Duas ações `(id, rótulo)`: a principal e a outra.
type Actions = &'static [(&'static str, &'static str)];
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
    /// A gravação parou sozinha (fontes caíram ou falha), com o tempo salvo.
    RecordingStopped(Option<i64>, StopReason),
    /// O microfone está fora há mais de 5 s e a gravação segue sem ele.
    MicLost,
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

/// Mostra um aviso sem ação.
pub fn show(notice: Notice) {
    let (title, body) = notice.text();
    info(&title, &body);
}

/// Guarda o que os avisos precisam do app (o AUMID do Windows); chamado no setup.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    let _ = APP_ID.set(app.config().identifier.clone());
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

/// O AUMID do toast: o do app instalado; em dev (ou antes de [`init`]), o do PowerShell, que
/// sempre existe.
#[cfg(target_os = "windows")]
fn toast_app_id() -> String {
    use tauri_winrt_notification::Toast;

    match APP_ID.get() {
        Some(id) if !tauri::is_dev() => id.clone(),
        _ => Toast::POWERSHELL_APP_ID.to_string(),
    }
}

/// Notificação informativa, sem ação.
#[cfg(target_os = "windows")]
pub fn info(title: &str, body: &str) {
    use tauri_winrt_notification::Toast;

    let result = Toast::new(&toast_app_id()).title(title).text1(body).show();
    if let Err(err) = result {
        log::warn!("falha ao notificar \"{title}\": {err}");
    }
}

/// Notificação informativa, sem ação.
#[cfg(not(target_os = "windows"))]
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

/// A gravação parou sozinha: as fontes caíram ou a gravação falhou.
pub fn recording_stopped(duration_ms: Option<i64>, reason: StopReason) {
    show(Notice::RecordingStopped(duration_ms, reason));
}

/// O microfone da gravação em curso está fora há mais de 5 s.
pub fn mic_lost() {
    show(Notice::MicLost);
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
        &[(ACTION_RECORD, LABEL_RECORD), (ACTION_IGNORE, LABEL_IGNORE)],
        Arc::new(respond),
    );
}

/// Quantos desfechos de uma volta ganham um aviso cada; acima disso, um aviso agrupado.
pub const GROUP_ABOVE: usize = 3;

/// O texto do motivo de um resumo pulado (o mesmo de `MOTIVOS` em `ui/js/vocabulario.js`); código
/// desconhecido aparece cru, como na janela.
fn reason_text(reason: Option<&str>) -> String {
    match reason {
        Some("no_provider") => "nenhum agente configurado; fale com quem administra".into(),
        Some("no_agenda_type") => "a gravação não tem tipo de agenda".into(),
        Some(code) => code.into(),
        None => "sem motivo informado".into(),
    }
}

/// Título e corpo do aviso de um desfecho do processamento.
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
    }
}

/// Título e corpo do aviso agrupado, quando muitas gravações terminam na mesma volta.
pub fn grouped_text(count: usize) -> (String, String) {
    (
        format!("{count} gravações processadas"),
        "Abra a biblioteca para ver os resumos e as falhas".into(),
    )
}

/// Um desfecho do processamento de uma gravação da conta. Pronto, com o Markdown, leva "Copiar"
/// (põe o resumo na área de transferência) e "Abrir"; os outros, só "Abrir" (a gravação no web).
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
                    log::warn!("falha ao copiar o resumo: {err}");
                }
            }
        }
        ACTION_OPEN => open(app, &url),
        _ => {}
    });
    with_actions(app.clone(), title, body, actions, on_action);
}

/// Muitos desfechos de uma vez: um aviso só, que abre a biblioteca no web.
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
        log::warn!("falha ao abrir {url}: {err}");
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
            Err(err) => log::warn!("falha ao notificar \"{title}\": {err}"),
        }
    });
}

/// Vencido o prazo sem resposta, fecha a notificação `id`: o servidor emite o fechamento e a
/// espera de [`with_actions`] termina. O GNOME ignora o prazo pedido na notificação, por isso o
/// fechamento explícito.
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
        // Substitui a mesma notificação (mesmo id) só para obter o handle que a fecha.
        match notification.id(id).show() {
            Ok(handle) => handle.close(),
            Err(err) => log::debug!("falha ao fechar a notificação {id}: {err}"),
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
        log::warn!("falha ao notificar \"{title}\": {err}");
    }
}

#[cfg(target_os = "macos")]
fn with_actions(app: AppHandle, title: String, body: String, actions: Actions, on: OnAction) {
    use mac_notification_sys::{MainButton, Notification, NotificationResponse};

    std::thread::spawn(move || {
        // Só vale uma vez por processo; as seguintes devolvem "já definido".
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
    fn textos_dos_desfechos() {
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
        let (title, body) = grouped_text(5);
        assert_eq!(
            format!("{title} · {body}"),
            "5 gravações processadas · Abra a biblioteca para ver os resumos e as falhas"
        );
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
