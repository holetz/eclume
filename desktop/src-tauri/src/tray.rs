//! System tray: an icon per state and a menu of quick actions.
//!
//! On Linux (AppIndicator), clicking the icon only opens the menu, so every action lives there —
//! including the detected meeting question, which adds two items while waiting for a response, and
//! the Recent section, with the latest recordings and an action submenu for each.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eclume_detect::AppKey;
use eclume_recorder::Kind;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::i18n::{fill, Locale};
use crate::recent::{TrayAction, TraySection};
use crate::shortcuts::Shortcuts;
use crate::state::{AppState, AppStatus, StatusView};

const TRAY_ID: &str = "eclume";
const MENU_STATUS: &str = "status";
const MENU_TOGGLE: &str = "toggle";
const MENU_NOTE: &str = "note";
const MENU_MARKER: &str = "marker";
const MENU_IMPORT: &str = "import";
const MENU_ASK_RECORD: &str = "ask-record";
const MENU_ASK_IGNORE: &str = "ask-ignore";
const MENU_OPEN_WEB: &str = "open-web";
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";
const MENU_RECENT_HEADER: &str = "recent-header";
const MENU_RECENT_EMPTY: &str = "recent-empty";
/// Prefixes for recent recording items, followed by the id used by the action.
const RECENT_SUBMENU: &str = "recent:";
const RECENT_COPY: &str = "recent-copy:";
const RECENT_OPEN: &str = "recent-open:";
const RECENT_RETRY: &str = "recent-retry:";
const RECENT_SHOW: &str = "recent-show:";

/// The current menu and items that change with the state.
struct MenuHandles {
    locale: Locale,
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    /// The question currently shown in the menu.
    ask: Option<AppKey>,
    /// The menu has the Add marker item (only while recording).
    recording: bool,
    /// The shortcuts shown as accelerators.
    shortcuts: Shortcuts,
    /// The current icon: replacing it writes a PNG on Linux, so only replace it when it changes.
    icon: Option<TrayIconState>,
    /// The current menu's Recent section (`None`: hidden). Rebuilding closes the menu in
    /// AppIndicator, so rebuild only when it changes.
    recent: Option<TraySection>,
}

struct TrayHandles {
    tray: TrayIcon<Wry>,
    menu: Mutex<MenuHandles>,
}

/// The tray is running: it provides the visible indicator required for automatic recording.
pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<TrayHandles>().is_some()
}

/// A tray menu line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuLine {
    Item {
        id: String,
        label: String,
        enabled: bool,
        /// The combination shown beside the item (the global shortcut for the same action).
        accelerator: Option<String>,
    },
    /// A submenu: a recent recording with its actions.
    Submenu {
        id: String,
        label: String,
        items: Vec<MenuLine>,
    },
    Separator,
}

fn item(id: impl Into<String>, label: impl Into<String>, accelerator: Option<&str>) -> MenuLine {
    MenuLine::Item {
        id: id.into(),
        label: label.into(),
        enabled: true,
        accelerator: accelerator.map(str::to_string),
    }
}

fn disabled(id: &str, label: impl Into<String>) -> MenuLine {
    MenuLine::Item {
        id: id.into(),
        label: label.into(),
        enabled: false,
        accelerator: None,
    }
}

/// The Recent section: a disabled header and a line per recording. With actions, the line is a
/// submenu (Copy summary, Open on web, Try now); without actions (recording, awaiting upload),
/// it is an item that opens the window.
fn recent_lines(section: &TraySection, locale: Locale) -> Vec<MenuLine> {
    let texts = locale.texts();
    let mut lines = vec![disabled(MENU_RECENT_HEADER, section.header.clone())];
    if section.entries.is_empty() {
        lines.push(disabled(MENU_RECENT_EMPTY, texts.recent_empty));
    }
    for entry in &section.entries {
        if entry.actions.is_empty() {
            lines.push(item(
                format!("{RECENT_SHOW}{}", entry.key),
                entry.label.clone(),
                None,
            ));
            continue;
        }
        let items = entry
            .actions
            .iter()
            .map(|action| match action {
                TrayAction::CopySummary(id) => {
                    item(format!("{RECENT_COPY}{id}"), texts.copy_summary, None)
                }
                TrayAction::OpenWeb(id) => item(format!("{RECENT_OPEN}{id}"), texts.open_web, None),
                TrayAction::Retry(id) => item(format!("{RECENT_RETRY}{id}"), texts.retry, None),
            })
            .collect();
        lines.push(MenuLine::Submenu {
            id: format!("{RECENT_SUBMENU}{}", entry.key),
            label: entry.label.clone(),
            items,
        });
    }
    lines
}

/// Menu lines, as in the DS "Tray menu" frame: status line, record, new voice note,
/// marker (only while recording), import, Recent section (when enabled), open eclume, open the
/// web library and quit. The detected meeting question adds two items just below the status.
/// Recent stays below the actions to avoid moving Start recording.
pub fn menu_lines(
    ask: Option<AppKey>,
    recording: bool,
    shortcuts: &Shortcuts,
    recent: Option<&TraySection>,
    locale: Locale,
) -> Vec<MenuLine> {
    let texts = locale.texts();
    let mut lines = vec![MenuLine::Item {
        id: MENU_STATUS.into(),
        label: AppStatus::Idle.label(locale).into(),
        enabled: false,
        accelerator: None,
    }];
    if let Some(key) = ask {
        lines.push(MenuLine::Separator);
        lines.push(item(
            MENU_ASK_RECORD,
            fill(texts.ask_record, &[("app", locale.app_label(key))]),
            None,
        ));
        lines.push(item(MENU_ASK_IGNORE, texts.ignore, None));
    }
    lines.push(MenuLine::Separator);
    let status = if recording {
        AppStatus::Recording
    } else {
        AppStatus::Idle
    };
    lines.push(item(
        MENU_TOGGLE,
        toggle_label(status, locale),
        Some(&shortcuts.record),
    ));
    lines.push(item(MENU_NOTE, texts.new_note, Some(&shortcuts.note)));
    if recording {
        lines.push(item(MENU_MARKER, texts.add_marker, Some(&shortcuts.marker)));
    }
    lines.push(item(MENU_IMPORT, texts.import_file, None));
    if let Some(section) = recent {
        lines.push(MenuLine::Separator);
        lines.extend(recent_lines(section, locale));
    }
    lines.push(MenuLine::Separator);
    lines.push(item(MENU_SHOW, texts.show_app, None));
    lines.push(item(MENU_OPEN_WEB, texts.open_library, None));
    lines.push(MenuLine::Separator);
    lines.push(item(MENU_QUIT, texts.quit, Some("CmdOrCtrl+Q")));
    lines
}

/// The native submenu for a `Submenu` line, with its children.
fn submenu(
    app: &AppHandle,
    id: &str,
    label: &str,
    items: &[MenuLine],
) -> tauri::Result<Submenu<Wry>> {
    let menu = Submenu::with_id(app, id, label, true)?;
    for line in items {
        match line {
            MenuLine::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            MenuLine::Item {
                id,
                label,
                enabled,
                accelerator,
            } => menu.append(&MenuItem::with_id(
                app,
                id.as_str(),
                label,
                *enabled,
                accelerator.as_deref(),
            )?)?,
            MenuLine::Submenu { id, label, items } => {
                menu.append(&submenu(app, id, label, items)?)?;
            }
        }
    }
    Ok(menu)
}

fn build_menu(
    app: &AppHandle,
    ask: Option<AppKey>,
    recording: bool,
    shortcuts: &Shortcuts,
    recent: Option<TraySection>,
    locale: Locale,
) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
    let menu = Menu::new(app)?;
    let mut status = None;
    let mut toggle = None;
    for line in menu_lines(ask, recording, shortcuts, recent.as_ref(), locale) {
        match line {
            MenuLine::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            MenuLine::Submenu { id, label, items } => {
                menu.append(&submenu(app, &id, &label, &items)?)?;
            }
            MenuLine::Item {
                id,
                label,
                enabled,
                accelerator,
            } => {
                let entry =
                    MenuItem::with_id(app, id.as_str(), label, enabled, accelerator.as_deref())?;
                menu.append(&entry)?;
                match id.as_str() {
                    MENU_STATUS => status = Some(entry),
                    MENU_TOGGLE => toggle = Some(entry),
                    _ => {}
                }
            }
        }
    }
    Ok((
        menu,
        MenuHandles {
            locale,
            status: status.expect("the menu always has a status line"),
            toggle: toggle.expect("the menu always has record"),
            ask,
            recording,
            shortcuts: shortcuts.clone(),
            icon: None,
            recent,
        },
    ))
}

/// Create the tray icon and menu.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let shortcuts = app.state::<AppState>().shortcuts().unwrap_or_default();
    let locale = app.state::<AppState>().locale().unwrap_or(Locale::En);
    let (menu, handles) = build_menu(app, None, false, &shortcuts, None, locale)?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(TrayIconState::Idle)?)
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
    spawn_note_clock(app.clone());
    Ok(())
}

/// During a voice note, update the tray time every second (variant A: nothing else opens).
/// Request via `refresh`, which dispatches to the main thread.
fn spawn_note_clock(app: AppHandle) {
    let mut backoff = crate::supervise::Backoff::default();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        crate::supervise::pass(&mut backoff, "voice note clock", || {
            let in_note = app
                .state::<AppState>()
                .view()
                .is_ok_and(|view| view.recording_kind == Some(Kind::Note));
            if in_note {
                refresh(&app);
            }
        });
    });
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_TOGGLE => crate::spawn_toggle_recording(app),
        MENU_NOTE => {
            // Opening the microphone can take seconds: keep it off the UI thread.
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = crate::toggle_note(&app);
            });
        }
        MENU_MARKER => crate::add_marker(app),
        MENU_IMPORT => crate::import::pick_from_tray(app),
        MENU_ASK_RECORD => crate::auto::answer(app, true),
        MENU_ASK_IGNORE => crate::auto::answer(app, false),
        MENU_OPEN_WEB => {
            if let Err(err) = crate::open_web(app, &app.state::<AppState>()) {
                log::error!("{err:#}");
            }
        }
        MENU_SHOW => crate::show_window(app),
        id if id.starts_with("recent") => on_recent_event(app, id),
        MENU_QUIT => {
            // Closing a recording can take seconds (join, driver, `fsync`): off the UI thread,
            // and exit the app when done.
            let app = app.clone();
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                if state.status().is_ok_and(|s| s == AppStatus::Recording) {
                    if let Err(err) = state.stop_recording() {
                        log::error!("failed to close recording on exit: {err:#}");
                    }
                }
                app.exit(0);
            });
        }
        _ => {}
    }
}

/// Recent actions. Copy reads the API and Try now changes the queue: keep off the UI thread.
/// The tray has no other feedback, so copying sends a notification.
fn on_recent_event(app: &AppHandle, id: &str) {
    if let Some(remote) = id.strip_prefix(RECENT_COPY) {
        let (app, remote) = (app.clone(), remote.to_string());
        std::thread::spawn(move || {
            let texts = app
                .state::<AppState>()
                .locale()
                .unwrap_or(Locale::En)
                .texts();
            match crate::recent::copy_summary(&app, &remote) {
                Ok(()) => crate::notify::info(texts.summary_copied, texts.summary_clipboard),
                Err(err) => {
                    log::error!("failed to copy summary from tray: {err:#}");
                    crate::notify::info(texts.copy_failed, &format!("{err:#}"));
                }
            }
        });
    } else if let Some(remote) = id.strip_prefix(RECENT_OPEN) {
        if let Err(err) = crate::recent::open_recording(app, remote) {
            log::error!("{err:#}");
        }
    } else if id.starts_with(RECENT_RETRY) {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = crate::sync::sync_now(&app) {
                log::error!("{err:#}");
            }
            crate::refresh_ui(&app);
        });
    } else if id.starts_with(RECENT_SHOW) {
        crate::show_window(app);
    }
}

/// Request a tray update, which only runs on the main thread: Tauri setters block until the main
/// thread responds, and a background thread calling them while holding the menu mutex would freeze
/// the app (#83). On the main thread, run at once; from another thread, just enqueue and return.
/// The handler reads the current state, so it never draws an old state.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    if let Err(err) = app.run_on_main_thread(move || apply(&handle)) {
        log::debug!("tray not updated (event loop ended): {err}");
    }
}

/// Update the icon, tooltip and menu text from state; replace the menu when the meeting question
/// appears or disappears, or when the Recent section changes. Main thread only: call
/// `refresh`.
fn apply(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let view = match app.state::<AppState>().view() {
        Ok(view) => view,
        Err(err) => {
            log::error!("failed to read state for tray: {err:#}");
            return;
        }
    };
    let Ok(mut menu) = handles.menu.lock() else {
        return;
    };
    let now = now_ms();
    let line = status_line(&view, now);
    let ask = view.pending_ask.map(|a| a.app);
    let recording = view.status == AppStatus::Recording;
    let shortcuts = app.state::<AppState>().shortcuts().unwrap_or_default();
    // The same local queue and panel snapshot; on failure, keep the section already in the menu.
    let recent = crate::recent::tray_section(app).unwrap_or_else(|err| {
        log::error!("failed to read recent recordings for tray: {err:#}");
        menu.recent.clone()
    });
    let result = (|| -> tauri::Result<()> {
        if menu.ask != ask
            || menu.recording != recording
            || menu.shortcuts != shortcuts
            || menu.recent != recent
            || menu.locale != view.locale
        {
            let (next, next_handles) =
                build_menu(app, ask, recording, &shortcuts, recent, view.locale)?;
            handles.tray.set_menu(Some(next))?;
            *menu = next_handles;
        }
        menu.status.set_text(&line)?;
        menu.toggle
            .set_text(toggle_label(view.status, view.locale))?;
        let state = TrayIconState::of(&view);
        if menu.icon != Some(state) {
            handles.tray.set_icon(Some(icon(state)?))?;
            menu.icon = Some(state);
        }
        // The icon label exists on macOS and Linux AppIndicator; on Windows, the voice note
        // time only appears in the tooltip, which already includes the status line.
        handles.tray.set_title(note_title(&view, now))?;
        handles.tray.set_tooltip(Some(fill(
            view.locale.texts().tooltip,
            &[("app", crate::APP_NAME), ("status", &line)],
        )))?;
        Ok(())
    })();
    if let Err(err) = result {
        log::error!("failed to update tray: {err}");
    }
}

fn toggle_label(status: AppStatus, locale: Locale) -> &'static str {
    let texts = locale.texts();
    if status == AppStatus::Recording {
        texts.stop_recording
    } else {
        texts.start_recording
    }
}

/// The elapsed time of a recording: "0:42" or "1:02:09".
fn elapsed(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m, s) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// "Nota 0:42" during a voice note; `None` otherwise.
pub fn note_title(view: &StatusView, now_ms: i64) -> Option<String> {
    if view.status != AppStatus::Recording || view.recording_kind != Some(Kind::Note) {
        return None;
    }
    let started = view.recording_started_at.unwrap_or(now_ms);
    Some(fill(
        view.locale.texts().note_time,
        &[("time", &elapsed(now_ms - started))],
    ))
}

/// The menu status line: state, app and recording mode (or voice note time), the meeting
/// awaiting a response and how many recordings still need to sync.
pub fn status_line(view: &StatusView, now_ms: i64) -> String {
    let texts = view.locale.texts();
    let mut parts = vec![view.status.label(view.locale).to_string()];
    if view.mic_lost && view.status == AppStatus::Recording {
        parts.push(texts.no_microphone.into());
    }
    if let Some(title) = note_title(view, now_ms) {
        parts.push(title);
    } else if view.status == AppStatus::Recording {
        match (view.recording_app, view.recording_auto) {
            (Some(app), true) => parts.push(fill(texts.automatic_app, &[("app", app.label)])),
            (Some(app), false) => parts.push(app.label.to_string()),
            (None, true) => parts.push(texts.automatic.into()),
            (None, false) => {}
        }
        match view.marker_count {
            0 => {}
            1 => parts.push(fill(texts.markers_one, &[("count", "1")])),
            n => parts.push(fill(texts.markers_other, &[("count", &n.to_string())])),
        }
    } else if let Some(ask) = view.pending_ask {
        parts.push(fill(texts.meeting_detected, &[("app", ask.label)]));
    }
    match view.counts.unsynced() {
        0 => {}
        1 => parts.push(fill(texts.unsynced_one, &[("count", "1")])),
        n => parts.push(fill(texts.unsynced_other, &[("count", &n.to_string())])),
    }
    parts.join(" · ")
}

/// The state shown by the tray icon: the brand mark, with distinct meeting and voice note icons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayIconState {
    Idle,
    Meeting,
    Note,
    Syncing,
}

impl TrayIconState {
    #[cfg(test)]
    const ALL: [Self; 4] = [Self::Idle, Self::Meeting, Self::Note, Self::Syncing];

    fn of(view: &StatusView) -> Self {
        match view.status {
            AppStatus::Idle => Self::Idle,
            AppStatus::Syncing => Self::Syncing,
            AppStatus::Recording if view.recording_kind == Some(Kind::Note) => Self::Note,
            AppStatus::Recording => Self::Meeting,
        }
    }
}

/// The PNGs are generated from the brand mark by `desktop/scripts/tray_icons.py`.
fn icon(state: TrayIconState) -> tauri::Result<Image<'static>> {
    Image::from_bytes(match state {
        TrayIconState::Idle => include_bytes!("../icons/tray-idle.png"),
        TrayIconState::Meeting => include_bytes!("../icons/tray-recording.png"),
        TrayIconState::Note => include_bytes!("../icons/tray-note.png"),
        TrayIconState::Syncing => include_bytes!("../icons/tray-syncing.png"),
    })
}

#[cfg(test)]
mod tests {
    use eclume_recorder::QueueCounts;

    use super::*;
    use crate::state::MeetingView;

    fn view(status: AppStatus, pending: u32) -> StatusView {
        StatusView {
            locale: Locale::PtBr,
            locale_choice: None,
            status,
            recording_id: None,
            recording_started_at: None,
            recording_kind: None,
            note_silence_s: Some(4),
            theme: "system".into(),
            marker_count: 0,
            last_marker: None,
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
            queue_waits: Default::default(),
            updated: None,
            connection: crate::config::Connection::Account,
            account: None,
            mic_lost: false,
        }
    }

    #[test]
    fn english_tray_text_follows_view_locale() {
        let mut note = view(AppStatus::Recording, 2);
        note.locale = Locale::En;
        note.recording_kind = Some(Kind::Note);
        note.recording_started_at = Some(1_000);
        assert_eq!(
            status_line(&note, 43_500),
            "Recording · Note 0:42 · 2 recordings to sync"
        );
        let lines = menu_lines(
            Some(AppKey::Zoom),
            false,
            &Shortcuts::default(),
            None,
            Locale::En,
        );
        assert_eq!(
            labels(&lines)[..4],
            ["Idle", "—", "Record the meeting in Zoom", "Not now"]
        );
        assert_eq!(
            toggle_label(AppStatus::Recording, Locale::En),
            "Stop recording"
        );
        assert_eq!(toggle_label(AppStatus::Idle, Locale::En), "Start recording");
    }

    #[test]
    fn tray_status_line() {
        assert_eq!(status_line(&view(AppStatus::Idle, 0), 0), "Ocioso");
        assert_eq!(
            status_line(&view(AppStatus::Recording, 1), 0),
            "Gravando · 1 gravação a sincronizar"
        );
        assert_eq!(
            status_line(&view(AppStatus::Syncing, 3), 0),
            "Sincronizando · 3 gravações a sincronizar"
        );
        let mut without_mic = view(AppStatus::Recording, 0);
        without_mic.mic_lost = true;
        assert_eq!(status_line(&without_mic, 0), "Gravando · sem microfone");
        assert_eq!(
            toggle_label(AppStatus::Recording, Locale::PtBr),
            "Parar gravação"
        );
        assert_eq!(
            toggle_label(AppStatus::Idle, Locale::PtBr),
            "Iniciar gravação"
        );
    }

    #[test]
    fn tray_shows_automatic_recording_and_question() {
        let mut auto = view(AppStatus::Recording, 0);
        auto.recording_auto = true;
        auto.recording_app = Some(MeetingView::new(AppKey::Teams, Locale::PtBr));
        assert_eq!(
            status_line(&auto, 0),
            "Gravando · Microsoft Teams (automático)"
        );
        auto.marker_count = 3;
        assert_eq!(
            status_line(&auto, 0),
            "Gravando · Microsoft Teams (automático) · 3 marcadores"
        );
        auto.marker_count = 1;
        assert!(status_line(&auto, 0).ends_with(" · 1 marcador"));
        let mut asking = view(AppStatus::Idle, 2);
        asking.pending_ask = Some(MeetingView::new(AppKey::Zoom, Locale::PtBr));
        assert_eq!(
            status_line(&asking, 0),
            "Ocioso · reunião no Zoom detectada · 2 gravações a sincronizar"
        );
    }

    #[test]
    fn tray_shows_voice_note_time() {
        let mut note = view(AppStatus::Recording, 0);
        note.recording_kind = Some(Kind::Note);
        note.recording_started_at = Some(1_000);
        note.marker_count = 2;
        assert_eq!(note_title(&note, 43_500).as_deref(), Some("Nota 0:42"));
        assert_eq!(status_line(&note, 43_500), "Gravando · Nota 0:42");
        assert_eq!(
            note_title(&note, 1_000 + 3_723_000).as_deref(),
            Some("Nota 1:02:03")
        );

        let mut meeting = view(AppStatus::Recording, 0);
        meeting.recording_kind = Some(Kind::Meeting);
        meeting.recording_started_at = Some(1_000);
        assert_eq!(note_title(&meeting, 43_500), None);
        assert_eq!(note_title(&view(AppStatus::Idle, 0), 43_500), None);
    }

    fn labels(lines: &[MenuLine]) -> Vec<String> {
        lines
            .iter()
            .map(|line| match line {
                MenuLine::Separator => "—".into(),
                MenuLine::Submenu { label, items, .. } => {
                    format!("{label} ▸ {}", labels(items).join(" | "))
                }
                MenuLine::Item {
                    label, accelerator, ..
                } => match accelerator {
                    Some(keys) => format!("{label} [{keys}]"),
                    None => label.clone(),
                },
            })
            .collect()
    }

    #[test]
    fn tray_menu_matches_ds() {
        let shortcuts = Shortcuts {
            record: "Ctrl+Alt+R".into(),
            note: "Ctrl+Alt+N".into(),
            marker: "Ctrl+Alt+M".into(),
        };
        assert_eq!(
            labels(&menu_lines(None, false, &shortcuts, None, Locale::PtBr)),
            [
                "Ocioso",
                "—",
                "Iniciar gravação [Ctrl+Alt+R]",
                "Nova nota [Ctrl+Alt+N]",
                "Importar arquivo…",
                "—",
                "Abrir o eclume",
                "Abrir a biblioteca na web",
                "—",
                "Sair [CmdOrCtrl+Q]",
            ]
        );
        let recording = menu_lines(Some(AppKey::Zoom), true, &shortcuts, None, Locale::PtBr);
        assert_eq!(
            labels(&recording)[..8],
            [
                "Ocioso",
                "—",
                "Gravar a reunião do Zoom",
                "Agora não",
                "—",
                "Parar gravação [Ctrl+Alt+R]",
                "Nova nota [Ctrl+Alt+N]",
                "Adicionar marcador [Ctrl+Alt+M]",
            ]
        );
        assert_eq!(
            recording[0],
            MenuLine::Item {
                id: MENU_STATUS.into(),
                label: "Ocioso".into(),
                enabled: false,
                accelerator: None
            }
        );
    }

    #[test]
    fn tray_menu_with_recent_section() {
        use crate::recent::TrayEntry;

        let shortcuts = Shortcuts {
            record: "Ctrl+Alt+R".into(),
            note: "Ctrl+Alt+N".into(),
            marker: "Ctrl+Alt+M".into(),
        };
        let section = TraySection {
            header: "Recentes · 1 precisa de você".into(),
            entries: vec![
                TrayEntry {
                    key: "r1".into(),
                    label: "Reunião X · Resumo pronto".into(),
                    actions: vec![
                        TrayAction::CopySummary("r1".into()),
                        TrayAction::OpenWeb("r1".into()),
                    ],
                },
                TrayEntry {
                    key: "local:l1".into(),
                    label: "Daily · Precisa de você (Falhou o envio)".into(),
                    actions: vec![TrayAction::Retry("l1".into())],
                },
                TrayEntry {
                    key: "local:l2".into(),
                    label: "05/10 14:02 · Gravando".into(),
                    actions: vec![],
                },
            ],
        };
        let lines = menu_lines(None, false, &shortcuts, Some(&section), Locale::PtBr);
        assert_eq!(
            labels(&lines)[4..11],
            [
                "Importar arquivo…",
                "—",
                "Recentes · 1 precisa de você",
                "Reunião X · Resumo pronto ▸ Copiar resumo | Abrir no web",
                "Daily · Precisa de você (Falhou o envio) ▸ Tentar agora",
                "05/10 14:02 · Gravando",
                "—",
            ]
        );
        // Record stays in place; the header is only text.
        assert_eq!(labels(&lines)[2], "Iniciar gravação [Ctrl+Alt+R]");
        assert_eq!(
            lines[6],
            MenuLine::Item {
                id: MENU_RECENT_HEADER.into(),
                label: "Recentes · 1 precisa de você".into(),
                enabled: false,
                accelerator: None,
            }
        );
        // The ids carry what the action uses, and are unique within the menu.
        let MenuLine::Submenu { id, items, .. } = &lines[7] else {
            panic!("the recording with actions is a submenu");
        };
        assert_eq!(id, "recent:r1");
        let ids: Vec<_> = items
            .iter()
            .filter_map(|line| match line {
                MenuLine::Item { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["recent-copy:r1", "recent-open:r1"]);
        let MenuLine::Item { id, .. } = &lines[9] else {
            panic!("the recording without actions is an item");
        };
        assert_eq!(id, "recent-show:local:l2");

        let empty = TraySection {
            header: "Recentes".into(),
            entries: vec![],
        };
        assert_eq!(
            labels(&menu_lines(
                None,
                false,
                &shortcuts,
                Some(&empty),
                Locale::PtBr
            ))[5..8],
            ["—", "Recentes", "Nenhuma gravação recente"]
        );
        // With 0 in the config, the section disappears.
        assert!(
            !labels(&menu_lines(None, false, &shortcuts, None, Locale::PtBr))
                .iter()
                .any(|label| label.starts_with("Recentes"))
        );
    }

    #[test]
    fn icon_distinguishes_meeting_from_voice_note() {
        assert_eq!(
            TrayIconState::of(&view(AppStatus::Idle, 0)),
            TrayIconState::Idle
        );
        assert_eq!(
            TrayIconState::of(&view(AppStatus::Syncing, 1)),
            TrayIconState::Syncing
        );
        let mut meeting = view(AppStatus::Recording, 0);
        assert_eq!(TrayIconState::of(&meeting), TrayIconState::Meeting);
        meeting.recording_kind = Some(Kind::Note);
        assert_eq!(TrayIconState::of(&meeting), TrayIconState::Note);
    }

    #[test]
    fn tray_icons_decode() {
        for state in TrayIconState::ALL {
            let image = icon(state).unwrap();
            assert_eq!((image.width(), image.height()), (64, 64));
        }
    }
}
