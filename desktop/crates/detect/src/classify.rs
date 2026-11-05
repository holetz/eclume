//! Signals observed at an instant and their classification as "meeting in which app".
//!
//! Everything here is pure: actual signal collection lives in `platform`, and tests construct
//! [`Snapshot`] by hand.

use serde::{Deserialize, Serialize};

/// A process using the mic.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioClient {
    /// Stable identifier: binary, executable path or bundle id.
    pub id: String,
    /// Readable name, when the OS provides one.
    pub name: String,
    pub pid: Option<u32>,
}

impl AudioClient {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            pid: None,
        }
    }

    /// Lowercase `id` and `name` in a single string, for substring matching.
    fn haystack(&self) -> String {
        format!("{} {}", self.id, self.name).to_lowercase()
    }
}

/// What OS signals show at an instant.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Identified processes using the mic.
    pub mic_users: Vec<AudioClient>,
    /// The mic is in use by someone the OS did not identify (device state only).
    pub mic_busy: bool,
    /// Names of running processes.
    pub processes: Vec<String>,
    /// Top-level window titles (empty where the OS does not allow reading them).
    pub window_titles: Vec<String>,
}

/// A signal source, queried periodically.
pub trait SignalSource: Send {
    fn snapshot(&mut self) -> anyhow::Result<Snapshot>;
}

/// The app of a detected meeting; the key for per-app policies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKey {
    Teams,
    Zoom,
    Meet,
    Webex,
    Slack,
    Whatsapp,
    /// Browser using the mic, without a window title identifying the meeting.
    Navegador,
    /// Mic in use by an app that is not a known meeting app.
    Outro,
}

impl AppKey {
    pub const ALL: [Self; 8] = [
        Self::Teams,
        Self::Zoom,
        Self::Meet,
        Self::Webex,
        Self::Slack,
        Self::Whatsapp,
        Self::Navegador,
        Self::Outro,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Teams => "teams",
            Self::Zoom => "zoom",
            Self::Meet => "meet",
            Self::Webex => "webex",
            Self::Slack => "slack",
            Self::Whatsapp => "whatsapp",
            Self::Navegador => "navegador",
            Self::Outro => "outro",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|key| key.as_str() == value)
    }

    /// Name shown in the tray, notifications and window.
    pub fn label(self) -> &'static str {
        match self {
            Self::Teams => "Microsoft Teams",
            Self::Zoom => "Zoom",
            Self::Meet => "Google Meet",
            Self::Webex => "Webex",
            Self::Slack => "Slack",
            Self::Whatsapp => "WhatsApp",
            Self::Navegador => "navegador",
            Self::Outro => "outro app",
        }
    }

    /// Value of `capture.meeting_app` in contract v1 (`teams`, `meet`, `zoom` or `other`).
    pub fn meeting_app(self) -> &'static str {
        match self {
            Self::Teams => "teams",
            Self::Meet => "meet",
            Self::Zoom => "zoom",
            Self::Webex | Self::Slack | Self::Whatsapp | Self::Navegador | Self::Outro => "other",
        }
    }
}

/// Meeting apps with native clients, by substring of the binary, name or bundle id
/// (`WhatsApp.exe`, `net.whatsapp.WhatsApp`, `ms-teams.exe`, `MSTeams_8wekyb3d8bbwe`,
/// `teams-for-linux`, `ZOOM VoiceEngine`, `us.zoom.xos`,
/// Zoom's `CptHost`, Webex's `CiscoCollabHost`).
const NATIVE_APPS: [(AppKey, &[&str]); 5] = [
    (AppKey::Teams, &["teams"]),
    (AppKey::Zoom, &["zoom", "cpthost", "aomhost"]),
    (AppKey::Webex, &["webex", "ciscocollabhost"]),
    (AppKey::Slack, &["slack"]),
    (AppKey::Whatsapp, &["whatsapp"]),
];

/// Browsers, by substring of the binary or name (`chrome`, `msedge`, the WebKit GPU process
/// Safari uses for the mic).
const BROWSERS: [&str; 11] = [
    "chrome",
    "chromium",
    "firefox",
    "msedge",
    "microsoft edge",
    "brave",
    "opera",
    "vivaldi",
    "safari",
    "com.apple.webkit",
    "librewolf",
];

/// Window titles identifying a meeting open in a browser, in priority order.
const BROWSER_TITLES: [(AppKey, &[&str]); 5] = [
    (AppKey::Meet, &["meet.google.com", "google meet", "meet - "]),
    (AppKey::Teams, &["microsoft teams"]),
    (
        AppKey::Zoom,
        &["zoom meeting", "zoom workplace", "app.zoom.us"],
    ),
    (AppKey::Webex, &["webex"]),
    // Last: only applies if no actual meeting is open in another tab.
    (AppKey::Whatsapp, &["whatsapp"]),
];

/// Processes that only exist during a meeting, for when the OS says the mic is in use
/// but does not say by whom.
const IN_MEETING_PROCESSES: [(AppKey, &[&str]); 2] = [
    (AppKey::Zoom, &["cpthost", "aomhost"]),
    (AppKey::Teams, &["teams"]),
];

/// The app's own name: eclume recordings use the mic and must not detect themselves.
const SELF_NAME: &str = "eclume";

/// eclume itself, by pid or executable — never by folder: on Windows the id is the full path,
/// and an arbitrary app in `C:\Projetos\eclume\` is not eclume.
pub fn is_self(client: &AudioClient, own_pid: u32) -> bool {
    client.pid == Some(own_pid) || names_self(client)
}

fn names_self(client: &AudioClient) -> bool {
    [&client.id, &client.name].into_iter().any(|value| {
        let file = value.rsplit(['/', '\\']).next().unwrap_or(value);
        file.to_lowercase().contains(SELF_NAME)
    })
}

fn native_app(haystack: &str) -> Option<AppKey> {
    NATIVE_APPS
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| haystack.contains(n)))
        .map(|(key, _)| *key)
}

fn is_browser(haystack: &str) -> bool {
    BROWSERS.iter().any(|b| haystack.contains(b))
}

/// A browser is using the mic: only then is reading window titles useful.
pub fn wants_window_titles(users: &[AudioClient]) -> bool {
    users.iter().any(|client| is_browser(&client.haystack()))
}

fn browser_meeting(titles: &[String]) -> Option<AppKey> {
    let titles: Vec<String> = titles.iter().map(|t| t.to_lowercase()).collect();
    BROWSER_TITLES
        .iter()
        .find(|(_, needles)| {
            titles
                .iter()
                .any(|title| needles.iter().any(|n| title.contains(n)))
        })
        .map(|(key, _)| *key)
}

/// Decides whether there is a meeting and in which app. Without mic use there is no meeting,
/// regardless of open apps.
///
/// Order: a native meeting app using the mic; a browser using the mic, refined by window
/// titles (`navegador` without a known title); mic busy without an identified owner, refined
/// by running meeting processes; any other mic user becomes `outro`.
pub fn classify(snapshot: &Snapshot) -> Option<AppKey> {
    let users: Vec<String> = snapshot
        .mic_users
        .iter()
        .filter(|client| !names_self(client))
        .map(AudioClient::haystack)
        .collect();

    if let Some(key) = users.iter().find_map(|h| native_app(h)) {
        return Some(key);
    }
    if users.iter().any(|h| is_browser(h)) {
        return Some(browser_meeting(&snapshot.window_titles).unwrap_or(AppKey::Navegador));
    }
    if !users.is_empty() {
        return Some(AppKey::Outro);
    }
    if snapshot.mic_busy {
        let processes: Vec<String> = snapshot
            .processes
            .iter()
            .map(|p| p.to_lowercase())
            .collect();
        let running = IN_MEETING_PROCESSES.iter().find(|(_, needles)| {
            processes
                .iter()
                .any(|p| needles.iter().any(|n| p.contains(n)))
        });
        return Some(running.map_or(AppKey::Outro, |(key, _)| *key));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mic(users: &[(&str, &str)]) -> Snapshot {
        Snapshot {
            mic_users: users
                .iter()
                .map(|(id, name)| AudioClient::new(*id, *name))
                .collect(),
            ..Snapshot::default()
        }
    }

    #[test]
    fn detects_native_apps_by_binary() {
        for (id, name, expected) in [
            ("ms-teams", "ms-teams", AppKey::Teams),
            ("MSTeams_8wekyb3d8bbwe", "", AppKey::Teams),
            ("teams-for-linux", "teams-for-linux", AppKey::Teams),
            ("C:#Program Files#Zoom#bin#Zoom.exe", "Zoom", AppKey::Zoom),
            ("zoom", "ZOOM VoiceEngine", AppKey::Zoom),
            ("us.zoom.xos", "zoom.us", AppKey::Zoom),
            ("CiscoCollabHost", "", AppKey::Webex),
            ("slack", "Slack", AppKey::Slack),
            ("WhatsApp.exe", "WhatsApp", AppKey::Whatsapp),
            (
                "5319275A.WhatsAppDesktop_cv1g1gvanyjgm",
                "",
                AppKey::Whatsapp,
            ),
            ("net.whatsapp.WhatsApp", "WhatsApp", AppKey::Whatsapp),
        ] {
            assert_eq!(classify(&mic(&[(id, name)])), Some(expected), "{id}");
        }
    }

    #[test]
    fn meet_in_browser_by_window_title() {
        let mut snapshot = mic(&[("chrome", "Google Chrome")]);
        snapshot.window_titles = vec![
            "Caixa de entrada - Gmail".into(),
            "Meet - abc-defg-hij - Google Chrome".into(),
        ];
        assert_eq!(classify(&snapshot), Some(AppKey::Meet));
        assert!(wants_window_titles(&snapshot.mic_users));
        assert!(!wants_window_titles(&[AudioClient::new("zoom", "zoom")]));

        snapshot.window_titles = vec!["Chat | Microsoft Teams - Microsoft Edge".into()];
        snapshot.mic_users = vec![AudioClient::new("msedge", "Microsoft Edge")];
        assert_eq!(classify(&snapshot), Some(AppKey::Teams));
    }

    #[test]
    fn whatsapp_web_by_title_and_actual_meeting_wins() {
        let mut snapshot = mic(&[("chrome", "Google Chrome")]);
        snapshot.window_titles = vec!["(2) WhatsApp Web - Google Chrome".into()];
        assert_eq!(classify(&snapshot), Some(AppKey::Whatsapp));
        snapshot
            .window_titles
            .push("Meet - abc-defg-hij - Google Chrome".into());
        assert_eq!(classify(&snapshot), Some(AppKey::Meet));
        assert_eq!(AppKey::Whatsapp.meeting_app(), "other");
        assert_eq!(AppKey::Whatsapp.label(), "WhatsApp");
    }

    #[test]
    fn browser_without_known_title_becomes_browser() {
        let mut snapshot = mic(&[("firefox", "Firefox")]);
        assert_eq!(classify(&snapshot), Some(AppKey::Navegador));
        snapshot.window_titles = vec!["Documento sem título".into()];
        assert_eq!(classify(&snapshot), Some(AppKey::Navegador));
    }

    #[test]
    fn native_app_wins_over_browser() {
        let snapshot = mic(&[("chrome", "Google Chrome"), ("zoom", "zoom")]);
        assert_eq!(classify(&snapshot), Some(AppKey::Zoom));
    }

    #[test]
    fn eclume_itself_does_not_count() {
        assert_eq!(classify(&mic(&[("eclume-desktop", "eclume")])), None);
        assert_eq!(
            classify(&mic(&[("eclume-desktop", "eclume"), ("teams", "Teams")])),
            Some(AppKey::Teams)
        );
        let mut client = AudioClient::new("app", "app");
        client.pid = Some(42);
        assert!(is_self(&client, 42));
        assert!(!is_self(&client, 7));
        assert!(is_self(
            &AudioClient::new("/opt/eclume/eclume-desktop", ""),
            7
        ));
    }

    #[test]
    fn app_in_eclume_folder_is_not_eclume_itself() {
        let executable_path = r"C:\Projetos\eclume\x\gravador.exe";
        assert!(!is_self(&AudioClient::new(executable_path, "gravador"), 7));
        assert_eq!(
            classify(&mic(&[(executable_path, "gravador")])),
            Some(AppKey::Outro)
        );
        let installed = r"C:\Users\u\AppData\Local\eclume\eclume-desktop.exe";
        assert!(is_self(&AudioClient::new(installed, "eclume-desktop"), 7));
        assert!(is_self(&AudioClient::new("io.github.holetz.eclume", ""), 7));
    }

    #[test]
    fn idle_mic_is_not_a_meeting_even_with_teams_open() {
        let snapshot = Snapshot {
            processes: vec!["ms-teams".into(), "zoom".into()],
            window_titles: vec!["Chat | Microsoft Teams".into()],
            ..Snapshot::default()
        };
        assert_eq!(classify(&snapshot), None);
    }

    #[test]
    fn busy_mic_without_owner_uses_processes() {
        let mut snapshot = Snapshot {
            mic_busy: true,
            processes: vec!["Finder".into(), "CptHost".into()],
            ..Snapshot::default()
        };
        assert_eq!(classify(&snapshot), Some(AppKey::Zoom));
        snapshot.processes = vec!["MSTeams".into()];
        assert_eq!(classify(&snapshot), Some(AppKey::Teams));
        snapshot.processes = vec!["Finder".into()];
        assert_eq!(classify(&snapshot), Some(AppKey::Outro));
    }

    #[test]
    fn other_mic_user_becomes_other() {
        assert_eq!(
            classify(&mic(&[("obs", "OBS Studio")])),
            Some(AppKey::Outro)
        );
    }

    #[test]
    fn contract_keys_and_values() {
        for key in AppKey::ALL {
            assert_eq!(AppKey::parse(key.as_str()), Some(key));
        }
        assert_eq!(AppKey::parse("skype"), None);
        assert_eq!(AppKey::Meet.meeting_app(), "meet");
        assert_eq!(AppKey::Navegador.meeting_app(), "other");
        for key in AppKey::ALL {
            assert_eq!(
                serde_json::to_string(&key).unwrap(),
                format!("\"{}\"", key.as_str())
            );
        }
    }
}
