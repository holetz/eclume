//! Bandeja do sistema: ícone por estado e o menu de ações rápidas.
//!
//! No Linux (AppIndicator) o clique no ícone só abre o menu, então toda ação mora no menu —
//! inclusive a pergunta de reunião detectada, que ganha dois itens enquanto espera resposta, e a
//! seção Recentes, com as últimas gravações e um submenu de ações para cada uma.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use eclume_detect::AppKey;
use eclume_recorder::Kind;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

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
/// Prefixos dos itens das gravações recentes, seguidos do id que a ação usa.
const RECENT_SUBMENU: &str = "recent:";
const RECENT_COPY: &str = "recent-copy:";
const RECENT_OPEN: &str = "recent-open:";
const RECENT_RETRY: &str = "recent-retry:";
const RECENT_SHOW: &str = "recent-show:";

/// O menu em uso e os itens que mudam com o estado.
struct MenuHandles {
    status: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    /// A pergunta que o menu mostra agora.
    ask: Option<AppKey>,
    /// O menu tem o item "Adicionar marcador" (só gravando).
    recording: bool,
    /// Os atalhos mostrados como acelerador.
    shortcuts: Shortcuts,
    /// O ícone mostrado agora: trocar grava um PNG no Linux, então só troca quando muda.
    icon: Option<TrayIconState>,
    /// A seção Recentes do menu em uso (`None`: oculta). Reconstruir o menu fecha-o no
    /// AppIndicator, então só se reconstrói quando ela muda.
    recent: Option<TraySection>,
}

struct TrayHandles {
    tray: TrayIcon<Wry>,
    menu: Mutex<MenuHandles>,
}

/// A bandeja está de pé: é a indicação visível que a gravação automática exige.
pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<TrayHandles>().is_some()
}

/// Uma linha do menu da bandeja.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuLine {
    Item {
        id: String,
        label: String,
        enabled: bool,
        /// A combinação mostrada ao lado do item (o atalho global que faz o mesmo).
        accelerator: Option<String>,
    },
    /// Um submenu: uma gravação recente com as ações dela.
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

/// A seção Recentes: o cabeçalho desabilitado e uma linha por gravação. Com ação, a linha é um
/// submenu (Copiar resumo, Abrir no web, Tentar agora); sem ação (gravando, aguardando envio),
/// um item que abre a janela.
fn recent_lines(section: &TraySection) -> Vec<MenuLine> {
    let mut lines = vec![disabled(MENU_RECENT_HEADER, section.header.clone())];
    if section.entries.is_empty() {
        lines.push(disabled(MENU_RECENT_EMPTY, "Nenhuma gravação recente"));
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
                    item(format!("{RECENT_COPY}{id}"), "Copiar resumo", None)
                }
                TrayAction::OpenWeb(id) => item(format!("{RECENT_OPEN}{id}"), "Abrir no web", None),
                TrayAction::Retry(id) => item(format!("{RECENT_RETRY}{id}"), "Tentar agora", None),
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

/// As linhas do menu, como o frame "Tray menu" do DS: a linha de status, gravar, nova nota,
/// marcador (só gravando), importar, a seção Recentes (quando ligada), abrir o eclume, abrir a
/// biblioteca na web e sair. A pergunta de reunião detectada entra como dois itens logo abaixo
/// do status. Recentes fica abaixo das ações para não mover "Iniciar gravação".
pub fn menu_lines(
    ask: Option<AppKey>,
    recording: bool,
    shortcuts: &Shortcuts,
    recent: Option<&TraySection>,
) -> Vec<MenuLine> {
    let mut lines = vec![MenuLine::Item {
        id: MENU_STATUS.into(),
        label: AppStatus::Idle.label().into(),
        enabled: false,
        accelerator: None,
    }];
    if let Some(key) = ask {
        lines.push(MenuLine::Separator);
        lines.push(item(
            MENU_ASK_RECORD,
            format!("Gravar a reunião do {}", key.label()),
            None,
        ));
        lines.push(item(MENU_ASK_IGNORE, "Agora não", None));
    }
    lines.push(MenuLine::Separator);
    let status = if recording {
        AppStatus::Recording
    } else {
        AppStatus::Idle
    };
    lines.push(item(
        MENU_TOGGLE,
        toggle_label(status),
        Some(&shortcuts.record),
    ));
    lines.push(item(MENU_NOTE, "Nova nota", Some(&shortcuts.note)));
    if recording {
        lines.push(item(
            MENU_MARKER,
            "Adicionar marcador",
            Some(&shortcuts.marker),
        ));
    }
    lines.push(item(MENU_IMPORT, "Importar arquivo…", None));
    if let Some(section) = recent {
        lines.push(MenuLine::Separator);
        lines.extend(recent_lines(section));
    }
    lines.push(MenuLine::Separator);
    lines.push(item(MENU_SHOW, "Abrir o eclume", None));
    lines.push(item(MENU_OPEN_WEB, "Abrir a biblioteca na web", None));
    lines.push(MenuLine::Separator);
    lines.push(item(MENU_QUIT, "Sair", Some("CmdOrCtrl+Q")));
    lines
}

/// O submenu nativo de uma linha `Submenu`, com os filhos.
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
) -> tauri::Result<(Menu<Wry>, MenuHandles)> {
    let menu = Menu::new(app)?;
    let mut status = None;
    let mut toggle = None;
    for line in menu_lines(ask, recording, shortcuts, recent.as_ref()) {
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
            status: status.expect("o menu sempre tem a linha de status"),
            toggle: toggle.expect("o menu sempre tem gravar"),
            ask,
            recording,
            shortcuts: shortcuts.clone(),
            icon: None,
            recent,
        },
    ))
}

/// Cria o ícone e o menu da bandeja.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let shortcuts = app.state::<AppState>().shortcuts().unwrap_or_default();
    let (menu, handles) = build_menu(app, None, false, &shortcuts, None)?;
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

/// Durante uma nota, atualiza o tempo da bandeja a cada segundo (variante A: nada mais abre). Pede
/// por `refresh`, que despacha para a thread principal.
fn spawn_note_clock(app: AppHandle) {
    let mut backoff = crate::supervise::Backoff::default();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        crate::supervise::pass(&mut backoff, "relógio da nota", || {
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
            // Abrir o microfone pode levar segundos: fora da thread da UI.
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
            // Fechar a gravação pode levar segundos (join, driver, `fsync`): fora da thread da UI,
            // e o app sai ao fim.
            let app = app.clone();
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                if state.status().is_ok_and(|s| s == AppStatus::Recording) {
                    if let Err(err) = state.stop_recording() {
                        log::error!("falha ao fechar a gravação ao sair: {err:#}");
                    }
                }
                app.exit(0);
            });
        }
        _ => {}
    }
}

/// As ações da seção Recentes. Copiar lê a API e Tentar agora mexe na fila: fora da thread da UI.
/// A bandeja não tem outro retorno, então o copiar avisa por notificação.
fn on_recent_event(app: &AppHandle, id: &str) {
    if let Some(remote) = id.strip_prefix(RECENT_COPY) {
        let (app, remote) = (app.clone(), remote.to_string());
        std::thread::spawn(move || match crate::recent::copy_summary(&app, &remote) {
            Ok(()) => crate::notify::info(
                "Resumo copiado",
                "O resumo em Markdown está na área de transferência.",
            ),
            Err(err) => {
                log::error!("falha ao copiar o resumo pela bandeja: {err:#}");
                crate::notify::info("Não foi possível copiar o resumo", &format!("{err:#}"));
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

/// Pede a atualização da bandeja, que só é tocada na thread principal: os setters do Tauri
/// bloqueiam até a thread principal responder, e uma thread de fundo que os chamasse segurando o
/// mutex do menu travaria o app (#83). Na thread principal roda na hora; de outra thread, só
/// enfileira e volta. Quem roda lê o estado do momento, então nunca desenha um estado velho.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    if let Err(err) = app.run_on_main_thread(move || apply(&handle)) {
        log::debug!("bandeja não atualizada (laço de eventos encerrado): {err}");
    }
}

/// Atualiza ícone, dica e textos do menu a partir do estado; troca o menu quando a pergunta de
/// reunião aparece ou some, ou quando a seção Recentes muda. Só na thread principal: chame
/// `refresh`.
fn apply(app: &AppHandle) {
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
    let now = now_ms();
    let line = status_line(&view, now);
    let ask = view.pending_ask.map(|a| a.app);
    let recording = view.status == AppStatus::Recording;
    let shortcuts = app.state::<AppState>().shortcuts().unwrap_or_default();
    // A mesma fila local e o mesmo retrato do painel; uma falha mantém a seção que está no menu.
    let recent = crate::recent::tray_section(app).unwrap_or_else(|err| {
        log::error!("falha ao ler as recentes para a bandeja: {err:#}");
        menu.recent.clone()
    });
    let result = (|| -> tauri::Result<()> {
        if menu.ask != ask
            || menu.recording != recording
            || menu.shortcuts != shortcuts
            || menu.recent != recent
        {
            let (next, next_handles) = build_menu(app, ask, recording, &shortcuts, recent)?;
            handles.tray.set_menu(Some(next))?;
            *menu = next_handles;
        }
        menu.status.set_text(&line)?;
        menu.toggle.set_text(toggle_label(view.status))?;
        let state = TrayIconState::of(&view);
        if menu.icon != Some(state) {
            handles.tray.set_icon(Some(icon(state)?))?;
            menu.icon = Some(state);
        }
        // O rótulo ao lado do ícone existe no macOS e no AppIndicator do Linux; no Windows, o
        // tempo da nota vai só na dica, que já traz a linha de status.
        handles.tray.set_title(note_title(&view, now))?;
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

/// O tempo corrido de uma gravação: "0:42" ou "1:02:09".
fn elapsed(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m, s) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// "Nota 0:42" durante uma nota; `None` fora dela.
pub fn note_title(view: &StatusView, now_ms: i64) -> Option<String> {
    if view.status != AppStatus::Recording || view.recording_kind != Some(Kind::Note) {
        return None;
    }
    let started = view.recording_started_at.unwrap_or(now_ms);
    Some(format!("Nota {}", elapsed(now_ms - started)))
}

/// A linha de status do menu: o estado, o app e o modo da gravação (ou o tempo da nota), a
/// reunião esperando resposta e quantas gravações faltam sincronizar.
pub fn status_line(view: &StatusView, now_ms: i64) -> String {
    let mut parts = vec![view.status.label().to_string()];
    if view.mic_lost && view.status == AppStatus::Recording {
        parts.push("sem microfone".into());
    }
    if let Some(title) = note_title(view, now_ms) {
        parts.push(title);
    } else if view.status == AppStatus::Recording {
        match (view.recording_app, view.recording_auto) {
            (Some(app), true) => parts.push(format!("{} (automático)", app.label)),
            (Some(app), false) => parts.push(app.label.to_string()),
            (None, true) => parts.push("automático".into()),
            (None, false) => {}
        }
        match view.marker_count {
            0 => {}
            1 => parts.push("1 marcador".into()),
            n => parts.push(format!("{n} marcadores")),
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

/// O estado que o ícone da bandeja mostra: a marca, com a reunião e a nota distintas.
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

/// Os PNG saem de `desktop/scripts/icones_bandeja.py`, a partir da marca.
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
    fn bandeja_linha_de_status() {
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
        assert_eq!(toggle_label(AppStatus::Recording), "Parar gravação");
        assert_eq!(toggle_label(AppStatus::Idle), "Iniciar gravação");
    }

    #[test]
    fn bandeja_mostra_gravacao_automatica_e_pergunta() {
        let mut auto = view(AppStatus::Recording, 0);
        auto.recording_auto = true;
        auto.recording_app = Some(MeetingView::from(AppKey::Teams));
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
        asking.pending_ask = Some(MeetingView::from(AppKey::Zoom));
        assert_eq!(
            status_line(&asking, 0),
            "Ocioso · reunião no Zoom detectada · 2 gravações a sincronizar"
        );
    }

    #[test]
    fn bandeja_mostra_o_tempo_da_nota() {
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
    fn menu_da_bandeja_como_o_ds() {
        let shortcuts = Shortcuts {
            record: "Ctrl+Alt+R".into(),
            note: "Ctrl+Alt+N".into(),
            marker: "Ctrl+Alt+M".into(),
        };
        assert_eq!(
            labels(&menu_lines(None, false, &shortcuts, None)),
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
        let recording = menu_lines(Some(AppKey::Zoom), true, &shortcuts, None);
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
    fn menu_da_bandeja_com_a_secao_recentes() {
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
        let lines = menu_lines(None, false, &shortcuts, Some(&section));
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
        // O gravar fica onde estava; o cabeçalho é só texto.
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
        // Os ids levam o que a ação usa, e são únicos no menu.
        let MenuLine::Submenu { id, items, .. } = &lines[7] else {
            panic!("a gravação com ações é um submenu");
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
            panic!("a gravação sem ação é um item");
        };
        assert_eq!(id, "recent-show:local:l2");

        let vazia = TraySection {
            header: "Recentes".into(),
            entries: vec![],
        };
        assert_eq!(
            labels(&menu_lines(None, false, &shortcuts, Some(&vazia)))[5..8],
            ["—", "Recentes", "Nenhuma gravação recente"]
        );
        // Com 0 na configuração, a seção some.
        assert!(!labels(&menu_lines(None, false, &shortcuts, None))
            .iter()
            .any(|label| label.starts_with("Recentes")));
    }

    #[test]
    fn icone_distingue_reuniao_de_nota() {
        assert_eq!(
            TrayIconState::of(&view(AppStatus::Idle, 0)),
            TrayIconState::Idle
        );
        assert_eq!(
            TrayIconState::of(&view(AppStatus::Syncing, 1)),
            TrayIconState::Syncing
        );
        let mut reuniao = view(AppStatus::Recording, 0);
        assert_eq!(TrayIconState::of(&reuniao), TrayIconState::Meeting);
        reuniao.recording_kind = Some(Kind::Note);
        assert_eq!(TrayIconState::of(&reuniao), TrayIconState::Note);
    }

    #[test]
    fn bandeja_icones_decodificam() {
        for state in TrayIconState::ALL {
            let image = icon(state).unwrap();
            assert_eq!((image.width(), image.height()), (64, 64));
        }
    }
}
