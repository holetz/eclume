//! Atalhos globais: gravar, nova nota e marcador, registrados no Rust pelo
//! `tauri-plugin-global-shortcut` (a janela não tem permissão para eles).
//!
//! No Windows e no Linux, `Ctrl+Alt`: o `Ctrl+Shift` do DS roubaria atalhos de uso diário
//! (`Ctrl+Shift+M` é o mudo do Teams, `Ctrl+Shift+N` a janela anônima do Chrome e `Ctrl+Shift+R`
//! o recarregar sem cache), e o AltGr do ABNT2 não usa R, N nem M. No macOS, `⌘⇧R` e `⌘⇧N` do DS
//! e o marcador em `⌘⇧K`, porque `⌘⇧M` é o mudo do Teams no Mac.

use std::collections::BTreeMap;
use std::str::FromStr;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcut, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;

/// O que um atalho global faz.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutAction {
    /// Inicia ou para a gravação.
    Record,
    /// Começa uma nota ou para a nota em curso.
    Note,
    /// Marca o instante da gravação em curso.
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

    /// O id estável do atalho (o do portal e o da config).
    pub fn id(self) -> &'static str {
        match self {
            Self::Record => "record",
            Self::Note => "note",
            Self::Marker => "marker",
        }
    }

    /// A flag de linha de comando que faz a ação na instância aberta (`eclume-desktop --nova-nota`),
    /// para o atalho do sistema onde o app não registra atalho global.
    pub fn cli_flag(self) -> &'static str {
        match self {
            Self::Record => "--alternar-gravacao",
            Self::Note => "--nova-nota",
            Self::Marker => "--marcador",
        }
    }
}

/// A ação pedida na linha de comando (o primeiro argumento é o executável).
pub fn action_from_args<S: AsRef<str>>(args: &[S]) -> Option<ShortcutAction> {
    args.iter().skip(1).find_map(|arg| {
        ShortcutAction::ALL
            .into_iter()
            .find(|action| action.cli_flag() == arg.as_ref())
    })
}

/// As combinações dos três atalhos, no formato do `global-hotkey` (`Ctrl+Alt+R`, `Cmd+Shift+N`).
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

    /// Cada atalho é uma combinação válida, com modificador, e nenhum repete outro.
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

/// Lê uma combinação. Sem modificador, o atalho tomaria uma tecla do sistema inteiro.
pub fn parse(text: &str) -> Result<Shortcut> {
    let shortcut = Shortcut::from_str(text.trim())
        .map_err(|err| anyhow!("combinação inválida \"{text}\": {err}"))?;
    if shortcut.mods.is_empty() {
        bail!("\"{text}\" precisa de Ctrl, Alt, Shift ou ⌘");
    }
    Ok(shortcut)
}

/// Como ficou o registro de um atalho.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Registration {
    Registered,
    /// O sistema recusou: outro app já usa a combinação.
    InUse,
    /// Sem atalhos globais nesta sessão (Wayland, ou o plugin não subiu).
    Unavailable,
}

impl Registration {
    /// O aviso da aba Áudio; `None` quando o atalho funciona.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Registered => None,
            Self::InUse => Some("Em uso por outro app"),
            Self::Unavailable => Some("Indisponível nesta sessão"),
        }
    }
}

/// O registro de cada atalho.
pub type Registrations = BTreeMap<ShortcutAction, Registration>;

/// A combinação no formato da especificação "shortcuts" do XDG, que o portal pede como gatilho
/// preferido: `Ctrl+Alt+R` vira `CTRL+ALT+r`.
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

/// Numa sessão Wayland, o `global-hotkey` só ouve janelas X11: o atalho não vale no sistema.
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

/// Liga o plugin. Uma falha (sem servidor X, por exemplo) não impede o app de abrir: os atalhos
/// ficam indisponíveis, e o botão e a bandeja continuam valendo.
pub fn init(app: &AppHandle) {
    if let Err(err) = app.plugin(tauri_plugin_global_shortcut::Builder::new().build()) {
        log::warn!("atalhos globais indisponíveis: {err}");
    }
    register(app);
}

/// (Re)registra os atalhos da config e guarda o resultado de cada um no estado.
pub fn register(app: &AppHandle) {
    let state = app.state::<AppState>();
    let shortcuts = match state.shortcuts() {
        Ok(shortcuts) => shortcuts,
        Err(err) => {
            log::error!("{err:#}");
            return;
        }
    };
    let registrations = if is_wayland() {
        // O portal responde depois (e pode pedir confirmação à pessoa): até lá, indisponível.
        #[cfg(target_os = "linux")]
        portal::spawn(app.clone(), shortcuts);
        all(Registration::Unavailable)
    } else {
        match app.try_state::<GlobalShortcut<Wry>>() {
            Some(_) => register_with_plugin(app, &shortcuts),
            None => all(Registration::Unavailable),
        }
    };
    if let Err(err) = state.set_shortcut_registrations(registrations) {
        log::error!("{err:#}");
    }
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
        log::warn!("falha ao soltar os atalhos anteriores: {err}");
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
                    log::warn!("atalho {text} não registrado: {err:#}");
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
            // Abrir o microfone pode levar segundos: fora da thread do evento.
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = crate::toggle_note(&app);
            });
        }
        ShortcutAction::Marker => crate::add_marker(app),
    }
}

/// Os atalhos pelo portal `org.freedesktop.portal.GlobalShortcuts`, numa sessão que vive enquanto
/// o app escuta. Registrar de novo (a config mudou) troca a sessão.
#[cfg(target_os = "linux")]
mod portal {
    use std::sync::Mutex;

    use anyhow::Result;
    use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
    use ashpd::desktop::CreateSessionOptions;
    use futures_util::StreamExt;
    use tauri::async_runtime::JoinHandle;
    use tauri::{AppHandle, Manager};

    use super::{all, run, xdg_trigger, Registration, ShortcutAction, Shortcuts};
    use crate::state::AppState;

    static LISTENER: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

    pub fn spawn(app: AppHandle, shortcuts: Shortcuts) {
        let task = tauri::async_runtime::spawn(async move {
            if let Err(err) = listen(&app, &shortcuts).await {
                log::info!("portal de atalhos globais indisponível: {err:#}");
            }
        });
        let previous = LISTENER.lock().ok().and_then(|mut slot| slot.replace(task));
        if let Some(previous) = previous {
            previous.abort();
        }
    }

    async fn listen(app: &AppHandle, shortcuts: &Shortcuts) -> Result<()> {
        let proxy = GlobalShortcuts::new().await?;
        let session = proxy.create_session(CreateSessionOptions::default()).await?;
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
            .set_shortcut_registrations(all(Registration::Registered))?;
        crate::refresh_ui(app);
        while let Some(event) = activated.next().await {
            // O sinal chega de todas as sessões do app; só vale a desta escuta.
            if event.session_handle().as_str() != session.path().as_str() {
                continue;
            }
            if let Some(action) = ShortcutAction::ALL
                .into_iter()
                .find(|action| action.id() == event.shortcut_id())
            {
                run(app, action);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    use super::*;

    #[test]
    fn atalhos_padrao_por_sistema() {
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
    fn atalho_invalido_sem_modificador_ou_repetido_e_recusado() {
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
    fn atalhos_leem_config_parcial() {
        let shortcuts: Shortcuts = serde_json::from_str(r#"{"note": "Ctrl+Alt+J"}"#).unwrap();
        assert_eq!(shortcuts.note, "Ctrl+Alt+J");
        assert_eq!(shortcuts.record, Shortcuts::default().record);
    }

    #[test]
    fn registro_vira_aviso_da_aba_audio() {
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
    fn gatilho_do_portal_segue_a_especificacao_do_xdg() {
        assert_eq!(xdg_trigger("Ctrl+Alt+R").as_deref(), Some("CTRL+ALT+r"));
        assert_eq!(xdg_trigger("Cmd+Shift+K").as_deref(), Some("LOGO+SHIFT+k"));
        assert_eq!(xdg_trigger("ctrl+shift+F9").as_deref(), Some("CTRL+SHIFT+F9"));
        assert_eq!(xdg_trigger("Ctrl+Alt+"), None);
        let ids: Vec<_> = ShortcutAction::ALL.iter().map(|a| a.id()).collect();
        assert_eq!(ids, ["record", "note", "marker"]);
    }

    #[test]
    fn flag_de_linha_de_comando_vira_acao() {
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
        // O executável nunca conta, e sem flag conhecida a instância só mostra a janela.
        assert_eq!(action_from_args(&["--nova-nota"]), None);
        assert_eq!(action_from_args(&["eclume-desktop"]), None);
    }

    #[test]
    fn sessao_wayland_nao_tem_atalho_global() {
        assert!(wayland_session(Some("wayland"), true, true));
        assert!(wayland_session(None, true, false));
        assert!(!wayland_session(Some("x11"), false, true));
        assert!(!wayland_session(None, true, true));
        assert!(!wayland_session(None, false, false));
    }
}
