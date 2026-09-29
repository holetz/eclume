//! Sinais observados num instante e a classificação deles em "reunião em qual app".
//!
//! Tudo aqui é puro: a coleta real dos sinais fica em `platform`, e os testes montam o
//! [`Snapshot`] à mão.

use serde::{Deserialize, Serialize};

/// Um processo usando o mic.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioClient {
    /// Identificador estável: binário, caminho do executável ou bundle id.
    pub id: String,
    /// Nome legível, quando o SO dá um.
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

    /// `id` e `name` em minúsculas, num texto só, para casar por trecho.
    fn haystack(&self) -> String {
        format!("{} {}", self.id, self.name).to_lowercase()
    }
}

/// O que os sinais do SO mostram num instante.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Processos usando o mic, identificados.
    pub mic_users: Vec<AudioClient>,
    /// O mic está em uso por alguém que o SO não identificou (só o estado do dispositivo).
    pub mic_busy: bool,
    /// Nomes dos processos em execução.
    pub processes: Vec<String>,
    /// Títulos das janelas de topo (vazio onde o SO não deixa ler).
    pub window_titles: Vec<String>,
}

/// Fonte de sinais, consultada periodicamente.
pub trait SignalSource: Send {
    fn snapshot(&mut self) -> anyhow::Result<Snapshot>;
}

/// O app de uma reunião detectada; é a chave das políticas por app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKey {
    Teams,
    Zoom,
    Meet,
    Webex,
    Slack,
    Whatsapp,
    /// Navegador usando o mic, sem título de janela que diga qual reunião.
    Navegador,
    /// Mic em uso por um app que não é de reunião conhecido.
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

    /// Nome exibido na bandeja, nas notificações e na janela.
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

    /// Valor de `capture.meeting_app` no contrato v1 (`teams`, `meet`, `zoom` ou `other`).
    pub fn meeting_app(self) -> &'static str {
        match self {
            Self::Teams => "teams",
            Self::Meet => "meet",
            Self::Zoom => "zoom",
            Self::Webex | Self::Slack | Self::Whatsapp | Self::Navegador | Self::Outro => "other",
        }
    }
}

/// Apps de reunião com cliente próprio, pelo trecho do binário, nome ou bundle id
/// (`WhatsApp.exe`, `net.whatsapp.WhatsApp`, `ms-teams.exe`, `MSTeams_8wekyb3d8bbwe`, `teams-for-linux`, `ZOOM VoiceEngine`, `us.zoom.xos`,
/// `CptHost` do Zoom, `CiscoCollabHost` do Webex).
const NATIVE_APPS: [(AppKey, &[&str]); 5] = [
    (AppKey::Teams, &["teams"]),
    (AppKey::Zoom, &["zoom", "cpthost", "aomhost"]),
    (AppKey::Webex, &["webex", "ciscocollabhost"]),
    (AppKey::Slack, &["slack"]),
    (AppKey::Whatsapp, &["whatsapp"]),
];

/// Navegadores, pelo trecho do binário ou nome (`chrome`, `msedge`, o processo GPU do WebKit
/// que o Safari usa para o mic).
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

/// Títulos de janela que identificam a reunião aberta num navegador, em ordem de prioridade.
const BROWSER_TITLES: [(AppKey, &[&str]); 5] = [
    (AppKey::Meet, &["meet.google.com", "google meet", "meet - "]),
    (AppKey::Teams, &["microsoft teams"]),
    (
        AppKey::Zoom,
        &["zoom meeting", "zoom workplace", "app.zoom.us"],
    ),
    (AppKey::Webex, &["webex"]),
    // Por último: só vale se nenhuma reunião de verdade estiver aberta em outra aba.
    (AppKey::Whatsapp, &["whatsapp"]),
];

/// Processos que só existem com uma reunião em andamento, para o caso em que o SO diz que o mic
/// está em uso mas não diz por quem.
const IN_MEETING_PROCESSES: [(AppKey, &[&str]); 2] = [
    (AppKey::Zoom, &["cpthost", "aomhost"]),
    (AppKey::Teams, &["teams"]),
];

/// Nome do próprio app: a gravação do eclume usa o mic e não pode se detectar.
const SELF_NAME: &str = "eclume";

/// O próprio eclume, pelo pid ou pelo executável — nunca pela pasta: no Windows o id é o caminho
/// inteiro, e um app qualquer em `C:\Projetos\eclume\` não é o eclume.
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

/// Algum navegador usa o mic: só então vale ler os títulos de janela.
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

/// Decide se há reunião e em qual app. Sem mic em uso não há reunião, com qualquer app aberto.
///
/// Ordem: um app de reunião nativo usando o mic; um navegador usando o mic, refinado pelo título
/// das janelas (`navegador` sem título conhecido); mic ocupado sem dono identificado, refinado
/// pelos processos de reunião em execução; qualquer outro usuário do mic vira `outro`.
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
    fn detecta_apps_nativos_pelo_binario() {
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
    fn meet_no_navegador_pelo_titulo_da_janela() {
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
    fn whatsapp_web_pelo_titulo_e_reuniao_de_verdade_ganha() {
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
    fn navegador_sem_titulo_conhecido_vira_navegador() {
        let mut snapshot = mic(&[("firefox", "Firefox")]);
        assert_eq!(classify(&snapshot), Some(AppKey::Navegador));
        snapshot.window_titles = vec!["Documento sem título".into()];
        assert_eq!(classify(&snapshot), Some(AppKey::Navegador));
    }

    #[test]
    fn app_nativo_ganha_do_navegador() {
        let snapshot = mic(&[("chrome", "Google Chrome"), ("zoom", "zoom")]);
        assert_eq!(classify(&snapshot), Some(AppKey::Zoom));
    }

    #[test]
    fn o_proprio_eclume_nao_conta() {
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
    fn app_numa_pasta_do_eclume_nao_e_o_proprio_app() {
        let caminho = r"C:\Projetos\eclume\x\gravador.exe";
        assert!(!is_self(&AudioClient::new(caminho, "gravador"), 7));
        assert_eq!(
            classify(&mic(&[(caminho, "gravador")])),
            Some(AppKey::Outro)
        );
        let instalado = r"C:\Users\u\AppData\Local\eclume\eclume-desktop.exe";
        assert!(is_self(&AudioClient::new(instalado, "eclume-desktop"), 7));
        assert!(is_self(
            &AudioClient::new("io.github.holetz.eclume", ""),
            7
        ));
    }

    #[test]
    fn mic_livre_nao_e_reuniao_mesmo_com_teams_aberto() {
        let snapshot = Snapshot {
            processes: vec!["ms-teams".into(), "zoom".into()],
            window_titles: vec!["Chat | Microsoft Teams".into()],
            ..Snapshot::default()
        };
        assert_eq!(classify(&snapshot), None);
    }

    #[test]
    fn mic_ocupado_sem_dono_usa_os_processos() {
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
    fn outro_usuario_do_mic_vira_outro() {
        assert_eq!(
            classify(&mic(&[("obs", "OBS Studio")])),
            Some(AppKey::Outro)
        );
    }

    #[test]
    fn chaves_e_valores_do_contrato() {
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
