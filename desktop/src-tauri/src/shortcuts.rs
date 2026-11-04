//! Global shortcuts: record, new voice note and marker, registered in Rust through
//! `tauri-plugin-global-shortcut` (the window has no permission for them).
//!
//! On Windows and Linux, use `Ctrl+Alt`: the DS's `Ctrl+Shift` would take everyday shortcuts
//! (`Ctrl+Shift+M` mutes Teams, `Ctrl+Shift+N` opens Chrome incognito and `Ctrl+Shift+R`
//! reloads without cache), and ABNT2 AltGr does not use R, N or M. On macOS, use the DS's `⌘⇧R`
//! and `⌘⇧N`, with the marker on `⌘⇧K`, because `⌘⇧M` mutes Teams on Mac.

use std::collections::BTreeMap;
use std::str::FromStr;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;

/// What a global shortcut does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutAction {
    /// Start or stop recording.
    Record,
    /// Start a voice note or stop the current one.
    Note,
    /// Mark the current recording time.
    Marker,
}

impl ShortcutAction {
    pub const ALL: [Self; 3] = [Self::Record, Self::Note, Self::Marker];

    pub fn label(self) -> &'static str {
        match self {
            Self::Record => "Iniciar ou parar a gravação",
            Self::Note => "Nova nota",
            Self::Marker => "Adicionar marcador",
        }
    }

    /// The stable shortcut id (for the portal and config).
    pub fn id(self) -> &'static str {
        match self {
            Self::Record => "record",
            Self::Note => "note",
            Self::Marker => "marker",
        }
    }

    /// The CLI flag that runs the action in the open instance (`eclume-desktop --nova-nota`),
    /// for system shortcuts where the app cannot register a global shortcut.
    pub fn cli_flag(self) -> &'static str {
        match self {
            Self::Record => "--alternar-gravacao",
            Self::Note => "--nova-nota",
            Self::Marker => "--marcador",
        }
    }
}

/// The action requested on the command line (the first argument is the executable).
pub fn action_from_args<S: AsRef<str>>(args: &[S]) -> Option<ShortcutAction> {
    args.iter().skip(1).find_map(|arg| {
        ShortcutAction::ALL
            .into_iter()
            .find(|action| action.cli_flag() == arg.as_ref())
    })
}

/// The three shortcut combinations, in `global-hotkey` format (`Ctrl+Alt+R`, `Cmd+Shift+N`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Shortcuts {
    pub record: String,
    pub note: String,
    pub marker: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        let (record, note, marker) = if cfg!(target_os = "macos") {
            ("Cmd+Shift+R", "Cmd+Shift+N", "Cmd+Shift+K")
        } else {
            ("Ctrl+Alt+R", "Ctrl+Alt+N", "Ctrl+Alt+M")
        };
        Self {
            record: record.into(),
            note: note.into(),
            marker: marker.into(),
        }
    }
}

impl Shortcuts {
    pub fn get(&self, action: ShortcutAction) -> &str {
        match action {
            ShortcutAction::Record => &self.record,
            ShortcutAction::Note => &self.note,
            ShortcutAction::Marker => &self.marker,
        }
    }

    /// Each shortcut is a valid combination with a modifier, and none duplicates another.
    pub fn validate(&self) -> Result<()> {
        let mut seen: Vec<(Shortcut, ShortcutAction)> = Vec::new();
        for action in ShortcutAction::ALL {
            let shortcut = parse(self.get(action))
                .map_err(|err| anyhow!("atalho de \"{}\": {err}", action.label()))?;
            if let Some((_, other)) = seen.iter().find(|(s, _)| *s == shortcut) {
                bail!(
                    "\"{}\" e \"{}\" usam o mesmo atalho",
                    other.label(),
                    action.label()
                );
            }
            seen.push((shortcut, action));
        }
        Ok(())
    }
}

/// Parse a combination. Without a modifier, the shortcut would take a key from the whole system.
pub fn parse(text: &str) -> Result<Shortcut> {
    let shortcut = Shortcut::from_str(text.trim())
        .map_err(|err| anyhow!("combinação inválida \"{text}\": {err}"))?;
    if shortcut.mods.is_empty() {
        bail!("\"{text}\" precisa de Ctrl, Alt, Shift ou ⌘");
    }
    Ok(shortcut)
}

/// The result of registering a shortcut.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Registration {
    Registered,
    /// The system refused: another app already uses the combination.
    InUse,
    /// No global shortcuts in this session (the plugin did not start).
    Unavailable,
    /// Wayland without a portal: use the system shortcut, which calls the CLI flag.
    System,
}

impl Registration {
    /// The Audio tab notice; `None` when the shortcut works.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Registered => None,
            Self::InUse => Some("Em uso por outro app"),
            Self::Unavailable => Some("Indisponível nesta sessão"),
            Self::System => Some("Crie o atalho no sistema"),
        }
    }
}

/// How shortcuts reach the app in this session, for the Audio tab.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ShortcutMode {
    /// X11, Windows and macOS: `global-hotkey` listens to the keyboard.
    #[default]
    Global,
    /// Wayland with the `GlobalShortcuts` portal.
    Portal,
    /// Wayland without a portal: the system shortcut calls `eclume-desktop <flag>`; on GNOME,
    /// the app creates these shortcuts itself.
    System {
        gnome: bool,
        commands: Vec<ShortcutCommand>,
    },
}

/// The command a system shortcut runs for an action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ShortcutCommand {
    pub action: ShortcutAction,
    pub command: String,
}

/// The registration of each shortcut.
pub type Registrations = BTreeMap<ShortcutAction, Registration>;

/// The combination in the XDG "shortcuts" specification format, requested by the portal as the
/// preferred trigger: `Ctrl+Alt+R` becomes `CTRL+ALT+r`.
pub fn xdg_trigger(text: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for part in text.split('+').map(str::trim) {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => Some("CTRL"),
            "alt" | "option" => Some("ALT"),
            "shift" => Some("SHIFT"),
            "super" | "cmd" | "command" | "meta" => Some("LOGO"),
            _ => None,
        };
        parts.push(match modifier {
            Some(name) => name.to_string(),
            None if part.chars().count() == 1 => part.to_lowercase(),
            None if part.is_empty() => return None,
            None => part.to_string(),
        });
    }
    Some(parts.join("+"))
}

/// In a Wayland session, `global-hotkey` only hears X11 windows: the shortcut is not system-wide.
fn wayland_session(session_type: Option<&str>, wayland_display: bool, display: bool) -> bool {
    session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland")) || (wayland_display && !display)
}

fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && wayland_session(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            std::env::var_os("DISPLAY").is_some(),
        )
}

/// Enable the plugin. A failure (no X server, for example) does not prevent the app from opening:
/// shortcuts become unavailable, and the button and tray still work.
pub fn init(app: &AppHandle) {
    if let Err(err) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
        log::warn!("global shortcuts unavailable: {err}");
    }
    register(app);
}

/// (Re)register the config shortcuts and save each result in the state.
pub fn register(app: &AppHandle) {
    let state = app.state::<AppState>();
    let shortcuts = match state.shortcuts() {
        Ok(shortcuts) => shortcuts,
        Err(err) => {
            log::error!("{err:#}");
            return;
        }
    };
    let wayland = is_wayland();
    let (mode, registrations) = if wayland {
        system_mode(&shortcuts)
    } else {
        let registrations = match app.try_state::<GlobalShortcut<Wry>>() {
            Some(_) => register_with_plugin(app, &shortcuts),
            None => all(Registration::Unavailable),
        };
        (ShortcutMode::Global, registrations)
    };
    if let Err(err) = state.set_shortcuts_state(mode, registrations) {
        log::error!("{err:#}");
    }
    // The portal responds later (and may ask the person to confirm); use system mode until then.
    #[cfg(target_os = "linux")]
    if wayland {
        portal::spawn(app.clone(), shortcuts);
    }
}

/// System mode: each shortcut works if its GNOME shortcut exists. If eclume shortcuts are already
/// in GNOME, rewrite them with the current combinations and executable.
fn system_mode(shortcuts: &Shortcuts) -> (ShortcutMode, Registrations) {
    let exe = launcher();
    let gnome = gnome::available();
    if gnome && gnome::any_installed() {
        if let Err(err) = gnome::install(shortcuts, &exe) {
            log::warn!("failed to update GNOME shortcuts: {err:#}");
        }
    }
    let registrations = ShortcutAction::ALL
        .into_iter()
        .map(|action| {
            let ok = gnome && gnome::installed(action, shortcuts.get(action), &exe);
            (
                action,
                if ok {
                    Registration::Registered
                } else {
                    Registration::System
                },
            )
        })
        .collect();
    let commands = ShortcutAction::ALL
        .into_iter()
        .map(|action| ShortcutCommand {
            action,
            command: command_line(&exe, action),
        })
        .collect();
    (ShortcutMode::System { gnome, commands }, registrations)
}

/// Create GNOME shortcuts: save the three system shortcuts with the config combinations.
pub fn install_system(shortcuts: &Shortcuts) -> Result<()> {
    if !gnome::available() {
        bail!("os atalhos só podem ser criados sozinhos no GNOME; use os comandos da aba");
    }
    gnome::install(shortcuts, &launcher())
}

/// Remove the GNOME shortcuts created by eclume.
pub fn remove_system() -> Result<()> {
    gnome::remove()
}

/// The executable called by the system: the AppImage, when the app runs through it.
fn launcher() -> String {
    std::env::var("APPIMAGE")
        .ok()
        .filter(|path| !path.is_empty())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|path| path.display().to_string())
        })
        .unwrap_or_else(|| "eclume-desktop".into())
}

/// The command line for an action, quoting the executable when needed.
fn command_line(exe: &str, action: ShortcutAction) -> String {
    let safe = exe
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c));
    let exe = if safe {
        exe.to_string()
    } else {
        format!("'{}'", exe.replace('\'', "'\\''"))
    };
    format!("{exe} {}", action.cli_flag())
}

fn all(registration: Registration) -> Registrations {
    ShortcutAction::ALL
        .into_iter()
        .map(|action| (action, registration))
        .collect()
}

fn register_with_plugin(app: &AppHandle, shortcuts: &Shortcuts) -> Registrations {
    let plugin = app.global_shortcut();
    if let Err(err) = plugin.unregister_all() {
        log::warn!("failed to release previous shortcuts: {err}");
    }
    ShortcutAction::ALL
        .into_iter()
        .map(|action| {
            let text = shortcuts.get(action);
            let registration = match parse(text).and_then(|shortcut| {
                plugin
                    .on_shortcut(shortcut, move |app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            run(app, action);
                        }
                    })
                    .map_err(|err| anyhow!("{err}"))
            }) {
                Ok(()) => Registration::Registered,
                Err(err) => {
                    log::warn!("shortcut {text} not registered: {err:#}");
                    Registration::InUse
                }
            };
            (action, registration)
        })
        .collect()
}

pub(crate) fn run(app: &AppHandle, action: ShortcutAction) {
    match action {
        ShortcutAction::Record => crate::spawn_toggle_recording(app),
        ShortcutAction::Note => {
            // Opening the microphone can take seconds: keep it off the event thread.
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = crate::toggle_note(&app);
            });
        }
        ShortcutAction::Marker => crate::add_marker(app),
    }
}

/// GNOME custom shortcuts (`gsettings`), one per action, in eclume-specific paths:
/// creating them again only rewrites them, and removal leaves the person's shortcuts untouched.
mod gnome {
    use std::process::Command;

    use anyhow::{bail, Context, Result};

    use super::{command_line, parse, ShortcutAction, Shortcuts};

    const LIST_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
    const LIST_KEY: &str = "custom-keybindings";
    const ITEM_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
    const BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";

    fn path(action: ShortcutAction) -> String {
        format!("{BASE}eclume-{}/", action.id())
    }

    fn item(action: ShortcutAction) -> String {
        format!("{ITEM_SCHEMA}:{}", path(action))
    }

    fn gsettings(args: &[&str]) -> Result<String> {
        let output = Command::new("gsettings")
            .args(args)
            .output()
            .context("gsettings não encontrado")?;
        if !output.status.success() {
            bail!(
                "gsettings {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub fn is_gnome(current_desktop: Option<&str>) -> bool {
        current_desktop.is_some_and(|desktop| {
            desktop
                .split(':')
                .any(|name| name.eq_ignore_ascii_case("gnome"))
        })
    }

    pub fn available() -> bool {
        cfg!(target_os = "linux")
            && is_gnome(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref())
            && gsettings(&["get", LIST_SCHEMA, LIST_KEY]).is_ok()
    }

    /// A GVariant string list (`['/a/', '/b/']` or `@as []`).
    pub fn parse_strv(text: &str) -> Vec<String> {
        let text = text.trim().trim_start_matches("@as").trim();
        text.trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|item| item.trim().trim_matches('\'').to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }

    /// A string in GVariant format, enclosed in single quotes.
    pub fn quote(text: &str) -> String {
        format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
    }

    pub fn format_strv(items: &[String]) -> String {
        let quoted: Vec<String> = items.iter().map(|item| quote(item)).collect();
        format!("[{}]", quoted.join(", "))
    }

    /// The combination in GTK format stored by GNOME: `Ctrl+Alt+R` becomes `<Control><Alt>r`.
    pub fn accelerator(keys: &str) -> Option<String> {
        parse(keys).ok()?;
        let mut accel = String::new();
        let mut key = None;
        for part in keys.split('+').map(str::trim) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => accel.push_str("<Control>"),
                "alt" | "option" => accel.push_str("<Alt>"),
                "shift" => accel.push_str("<Shift>"),
                "super" | "cmd" | "command" | "meta" => accel.push_str("<Super>"),
                _ if part.chars().count() == 1 => key = Some(part.to_lowercase()),
                _ => key = Some(part.to_string()),
            }
        }
        Some(accel + &key?)
    }

    fn list() -> Result<Vec<String>> {
        Ok(parse_strv(&gsettings(&["get", LIST_SCHEMA, LIST_KEY])?))
    }

    pub fn any_installed() -> bool {
        list().is_ok_and(|paths| {
            ShortcutAction::ALL
                .into_iter()
                .any(|action| paths.contains(&path(action)))
        })
    }

    pub fn installed(action: ShortcutAction, keys: &str, exe: &str) -> bool {
        let Ok(paths) = list() else { return false };
        let get = |key: &str| gsettings(&["get", &item(action), key]).ok();
        paths.contains(&path(action))
            && accelerator(keys).is_some_and(|accel| get("binding") == Some(quote(&accel)))
            && get("command") == Some(quote(&command_line(exe, action)))
    }

    pub fn install(shortcuts: &Shortcuts, exe: &str) -> Result<()> {
        for action in ShortcutAction::ALL {
            let keys = shortcuts.get(action);
            let accel = accelerator(keys)
                .with_context(|| format!("\"{keys}\" não vira atalho do GNOME"))?;
            let item = item(action);
            gsettings(&[
                "set",
                &item,
                "name",
                &quote(&format!("eclume · {}", action.label())),
            ])?;
            gsettings(&["set", &item, "command", &quote(&command_line(exe, action))])?;
            gsettings(&["set", &item, "binding", &quote(&accel)])?;
        }
        let mut paths = list()?;
        for action in ShortcutAction::ALL {
            if !paths.contains(&path(action)) {
                paths.push(path(action));
            }
        }
        gsettings(&["set", LIST_SCHEMA, LIST_KEY, &format_strv(&paths)])?;
        Ok(())
    }

    pub fn remove() -> Result<()> {
        let ours: Vec<String> = ShortcutAction::ALL.into_iter().map(path).collect();
        let paths: Vec<String> = list()?.into_iter().filter(|p| !ours.contains(p)).collect();
        gsettings(&["set", LIST_SCHEMA, LIST_KEY, &format_strv(&paths)])?;
        for action in ShortcutAction::ALL {
            for key in ["name", "command", "binding"] {
                gsettings(&["reset", &item(action), key])?;
            }
        }
        Ok(())
    }
}

/// Shortcuts through the `org.freedesktop.portal.GlobalShortcuts` portal, in a session that lives
/// while the app listens. Registering again (config changed) replaces the session.
#[cfg(target_os = "linux")]
mod portal {
    use std::sync::Mutex;

    use anyhow::Result;
    use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
    use ashpd::desktop::CreateSessionOptions;
    use futures_util::StreamExt;
    use tauri::{AppHandle, Manager};
    use tokio::sync::oneshot;

    use super::{all, run, xdg_trigger, Registration, ShortcutAction, ShortcutMode, Shortcuts};
    use crate::state::AppState;

    /// Stop the current listener: it closes its session before the new one takes over.
    static STOP: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

    pub fn spawn(app: AppHandle, shortcuts: Shortcuts) {
        let (stop, stopped) = oneshot::channel();
        let previous = STOP.lock().ok().and_then(|mut slot| slot.replace(stop));
        if let Some(previous) = previous {
            let _ = previous.send(());
        }
        tauri::async_runtime::spawn(async move {
            if let Err(err) = listen(&app, &shortcuts, stopped).await {
                log::info!("global shortcuts portal unavailable: {err:#}");
            }
        });
    }

    async fn listen(
        app: &AppHandle,
        shortcuts: &Shortcuts,
        mut stopped: oneshot::Receiver<()>,
    ) -> Result<()> {
        let proxy = GlobalShortcuts::new().await?;
        let session = proxy
            .create_session(CreateSessionOptions::default())
            .await?;
        let triggers: Vec<Option<String>> = ShortcutAction::ALL
            .iter()
            .map(|action| xdg_trigger(shortcuts.get(*action)))
            .collect();
        let wanted: Vec<NewShortcut> = ShortcutAction::ALL
            .iter()
            .zip(&triggers)
            .map(|(action, trigger)| {
                NewShortcut::new(action.id(), action.label()).preferred_trigger(trigger.as_deref())
            })
            .collect();
        proxy
            .bind_shortcuts(&session, &wanted, None, BindShortcutsOptions::default())
            .await?
            .response()?;
        let mut activated = proxy.receive_activated().await?;
        app.state::<AppState>()
            .set_shortcuts_state(ShortcutMode::Portal, all(Registration::Registered))?;
        crate::refresh_ui(app);
        loop {
            tokio::select! {
                _ = &mut stopped => break,
                event = activated.next() => {
                    let Some(event) = event else { break };
                    if let Some(action) = ShortcutAction::ALL
                        .into_iter()
                        .find(|action| action.id() == event.shortcut_id())
                    {
                        run(app, action);
                    }
                }
            }
        }
        session.close().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    use super::*;

    #[test]
    fn default_shortcuts_per_system() {
        let shortcuts = Shortcuts::default();
        shortcuts.validate().unwrap();
        let record = parse(&shortcuts.record).unwrap();
        let marker = parse(&shortcuts.marker).unwrap();
        assert_eq!(record.key, Code::KeyR);
        assert_eq!(parse(&shortcuts.note).unwrap().key, Code::KeyN);
        if cfg!(target_os = "macos") {
            assert_eq!(record.mods, Modifiers::SUPER | Modifiers::SHIFT);
            assert_eq!(marker.key, Code::KeyK);
        } else {
            assert_eq!(shortcuts.record, "Ctrl+Alt+R");
            assert_eq!(record.mods, Modifiers::CONTROL | Modifiers::ALT);
            assert_eq!(marker.key, Code::KeyM);
        }
    }

    #[test]
    fn invalid_unmodified_or_duplicate_shortcut_is_rejected() {
        assert!(parse("Ctrl+Alt+").is_err());
        assert!(parse("Ctrl+Banana").is_err());
        assert!(parse("Ctrl+R+Alt").is_err());
        let err = parse("R").unwrap_err();
        assert!(err.to_string().contains("precisa de"), "{err}");
        assert_eq!(parse(" ctrl+shift+f9 ").unwrap().key, Code::F9);

        let shortcuts = Shortcuts {
            marker: "Nada".into(),
            ..Shortcuts::default()
        };
        let err = shortcuts.validate().unwrap_err();
        assert!(err.to_string().contains("Adicionar marcador"), "{err}");

        let shortcuts = Shortcuts {
            note: Shortcuts::default().record.to_lowercase(),
            ..Shortcuts::default()
        };
        let err = shortcuts.validate().unwrap_err();
        assert!(err.to_string().contains("mesmo atalho"), "{err}");
    }

    #[test]
    fn shortcuts_read_partial_config() {
        let shortcuts: Shortcuts = serde_json::from_str(r#"{"note": "Ctrl+Alt+J"}"#).unwrap();
        assert_eq!(shortcuts.note, "Ctrl+Alt+J");
        assert_eq!(shortcuts.record, Shortcuts::default().record);
    }

    #[test]
    fn registration_becomes_audio_tab_notice() {
        assert_eq!(Registration::Registered.label(), None);
        assert_eq!(Registration::InUse.label(), Some("Em uso por outro app"));
        assert_eq!(
            Registration::Unavailable.label(),
            Some("Indisponível nesta sessão")
        );
        assert_eq!(
            serde_json::to_string(&Registration::InUse).unwrap(),
            "\"in_use\""
        );
    }

    #[test]
    fn gnome_shortcut_in_gtk_and_gvariant_formats() {
        assert_eq!(
            gnome::accelerator("Ctrl+Alt+N").as_deref(),
            Some("<Control><Alt>n")
        );
        assert_eq!(
            gnome::accelerator("Cmd+Shift+F9").as_deref(),
            Some("<Super><Shift>F9")
        );
        assert_eq!(gnome::accelerator("N"), None);
        assert_eq!(gnome::parse_strv("@as []"), Vec::<String>::new());
        let paths = gnome::parse_strv("['/a/custom0/', '/b/eclume-note/']");
        assert_eq!(paths, ["/a/custom0/", "/b/eclume-note/"]);
        assert_eq!(
            gnome::format_strv(&paths),
            "['/a/custom0/', '/b/eclume-note/']"
        );
        assert_eq!(gnome::quote("it's"), r"'it\'s'");
        assert!(gnome::is_gnome(Some("ubuntu:GNOME")));
        assert!(!gnome::is_gnome(Some("KDE")));
        assert!(!gnome::is_gnome(None));
    }

    #[test]
    fn system_command_calls_action_flag() {
        assert_eq!(
            command_line("/usr/bin/eclume-desktop", ShortcutAction::Note),
            "/usr/bin/eclume-desktop --nova-nota"
        );
        assert_eq!(
            command_line("/home/ana/Apps/eclume 0.3.AppImage", ShortcutAction::Record),
            "'/home/ana/Apps/eclume 0.3.AppImage' --alternar-gravacao"
        );
        assert_eq!(
            serde_json::to_value(ShortcutMode::Portal).unwrap(),
            serde_json::json!({ "mode": "portal" })
        );
        assert_eq!(
            Registration::System.label(),
            Some("Crie o atalho no sistema")
        );
    }

    #[test]
    fn portal_trigger_follows_xdg_specification() {
        assert_eq!(xdg_trigger("Ctrl+Alt+R").as_deref(), Some("CTRL+ALT+r"));
        assert_eq!(xdg_trigger("Cmd+Shift+K").as_deref(), Some("LOGO+SHIFT+k"));
        assert_eq!(
            xdg_trigger("ctrl+shift+F9").as_deref(),
            Some("CTRL+SHIFT+F9")
        );
        assert_eq!(xdg_trigger("Ctrl+Alt+"), None);
        let ids: Vec<_> = ShortcutAction::ALL.iter().map(|a| a.id()).collect();
        assert_eq!(ids, ["record", "note", "marker"]);
    }

    #[test]
    fn command_line_flag_becomes_action() {
        assert_eq!(
            action_from_args(&["eclume-desktop", "--nova-nota"]),
            Some(ShortcutAction::Note)
        );
        assert_eq!(
            action_from_args(&["/usr/bin/eclume-desktop", "--x", "--marcador"]),
            Some(ShortcutAction::Marker)
        );
        assert_eq!(
            action_from_args(&["eclume-desktop", "--alternar-gravacao"]),
            Some(ShortcutAction::Record)
        );
        // The executable never counts; without a known flag, the instance only shows the window.
        assert_eq!(action_from_args(&["--nova-nota"]), None);
        assert_eq!(action_from_args(&["eclume-desktop"]), None);
    }

    #[test]
    fn wayland_session_has_no_global_shortcut() {
        assert!(wayland_session(Some("wayland"), true, true));
        assert!(wayland_session(None, true, false));
        assert!(!wayland_session(Some("x11"), false, true));
        assert!(!wayland_session(None, true, true));
        assert!(!wayland_session(None, false, false));
    }
}
