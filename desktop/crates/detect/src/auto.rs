//! Gravação automática: das políticas por app e dos eventos de reunião para as ações que o app
//! executa (iniciar, parar, perguntar). Pura; quem executa as ações e mostra a indicação visível
//! é o app.

use std::collections::BTreeMap;

use eclume_recorder::MeetingEvent;
use serde::{Deserialize, Serialize};

use crate::classify::AppKey;

/// O que fazer quando uma reunião começa num app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Gravar sem perguntar (com a indicação na bandeja e uma notificação).
    Auto,
    /// Perguntar ao usuário, por notificação, bandeja e janela.
    #[default]
    Ask,
    /// Não fazer nada.
    Ignore,
}

/// Política de quem não tem uma configurada: perguntar, menos para `outro` (ditado, gravador de
/// voz, jogos), que é ignorado.
pub fn default_policy(app: AppKey) -> Policy {
    match app {
        AppKey::Outro => Policy::Ignore,
        _ => Policy::Ask,
    }
}

/// A seção `detection` da config do app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectionConfig {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Só as políticas que o usuário mudou; o resto vem de [`default_policy`].
    #[serde(default)]
    pub policies: BTreeMap<AppKey, Policy>,
}

fn enabled_by_default() -> bool {
    true
}

impl Default for DetectionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            policies: BTreeMap::new(),
        }
    }
}

impl DetectionConfig {
    pub fn policy(&self, app: AppKey) -> Policy {
        self.policies
            .get(&app)
            .copied()
            .unwrap_or_else(|| default_policy(app))
    }
}

/// A gravação em curso, do ponto de vista da detecção.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recording {
    Idle,
    /// Iniciada pelo usuário: a detecção nunca a para.
    Manual,
    /// Iniciada pela detecção: para quando a reunião termina.
    Auto,
}

/// O que o app deve fazer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Start(AppKey),
    Stop,
    /// Perguntar se grava a reunião deste app.
    Ask(AppKey),
    /// Tirar a pergunta pendente da tela.
    Dismiss,
}

/// A máquina de gravação automática.
#[derive(Clone, Debug, Default)]
pub struct AutoRecorder {
    meeting: Option<AppKey>,
    asking: Option<AppKey>,
}

impl AutoRecorder {
    /// A reunião em curso, se houver.
    pub fn meeting(&self) -> Option<AppKey> {
        self.meeting
    }

    /// A pergunta esperando resposta, se houver.
    pub fn pending_ask(&self) -> Option<AppKey> {
        self.asking
    }

    /// Um evento do detector. Uma reunião só dispara uma vez: o detector não repete `Started`
    /// antes do `Ended`, então parar à mão ou responder "Ignorar" vale até ela acabar.
    pub fn on_event(
        &mut self,
        event: &MeetingEvent,
        config: &DetectionConfig,
        recording: Recording,
    ) -> Action {
        match event {
            MeetingEvent::Started { app } => {
                let app = AppKey::parse(app).unwrap_or(AppKey::Outro);
                self.meeting = Some(app);
                self.asking = None;
                if !config.enabled || recording != Recording::Idle {
                    return Action::None;
                }
                match config.policy(app) {
                    Policy::Auto => Action::Start(app),
                    Policy::Ask => {
                        self.asking = Some(app);
                        Action::Ask(app)
                    }
                    Policy::Ignore => Action::None,
                }
            }
            MeetingEvent::Ended => {
                self.meeting = None;
                let was_asking = self.asking.take().is_some();
                if recording == Recording::Auto {
                    Action::Stop
                } else if was_asking {
                    Action::Dismiss
                } else {
                    Action::None
                }
            }
        }
    }

    /// A resposta do usuário à pergunta pendente: `true` grava, `false` ignora esta reunião.
    pub fn answer(&mut self, record: bool, recording: Recording) -> Action {
        match self.asking.take() {
            Some(app) if record && recording == Recording::Idle => Action::Start(app),
            Some(_) => Action::Dismiss,
            None => Action::None,
        }
    }

    /// O usuário iniciou uma gravação à mão: a pergunta pendente perde o sentido.
    pub fn on_manual_start(&mut self) -> Action {
        if self.asking.take().is_some() {
            Action::Dismiss
        } else {
            Action::None
        }
    }

    /// A config mudou: desligar a detecção, ou a política do app perguntado deixar de ser
    /// `ask`, tira a pergunta pendente.
    pub fn on_config_change(&mut self, config: &DetectionConfig) -> Action {
        match self.asking {
            Some(app) if !config.enabled || config.policy(app) != Policy::Ask => {
                self.asking = None;
                Action::Dismiss
            }
            _ => Action::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started(app: &str) -> MeetingEvent {
        MeetingEvent::Started { app: app.into() }
    }

    fn config(pairs: &[(AppKey, Policy)]) -> DetectionConfig {
        DetectionConfig {
            enabled: true,
            policies: pairs.iter().copied().collect(),
        }
    }

    #[test]
    fn politicas_padrao() {
        let config = DetectionConfig::default();
        assert!(config.enabled);
        assert_eq!(config.policy(AppKey::Teams), Policy::Ask);
        assert_eq!(config.policy(AppKey::Navegador), Policy::Ask);
        assert_eq!(config.policy(AppKey::Outro), Policy::Ignore);
        let custom = self::config(&[(AppKey::Outro, Policy::Auto)]);
        assert_eq!(custom.policy(AppKey::Outro), Policy::Auto);
    }

    #[test]
    fn auto_grava_e_para_no_fim_da_reuniao() {
        let config = config(&[(AppKey::Zoom, Policy::Auto)]);
        let mut auto = AutoRecorder::default();
        assert_eq!(
            auto.on_event(&started("zoom"), &config, Recording::Idle),
            Action::Start(AppKey::Zoom)
        );
        assert_eq!(auto.meeting(), Some(AppKey::Zoom));
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Auto),
            Action::Stop
        );
        assert_eq!(auto.meeting(), None);
    }

    #[test]
    fn chamada_do_whatsapp_tem_politica_propria() {
        let mut auto = AutoRecorder::default();
        assert_eq!(
            auto.on_event(
                &started("whatsapp"),
                &DetectionConfig::default(),
                Recording::Idle
            ),
            Action::Ask(AppKey::Whatsapp)
        );
        auto.on_event(
            &MeetingEvent::Ended,
            &DetectionConfig::default(),
            Recording::Idle,
        );
        let config = config(&[(AppKey::Whatsapp, Policy::Auto)]);
        assert_eq!(
            auto.on_event(&started("whatsapp"), &config, Recording::Idle),
            Action::Start(AppKey::Whatsapp)
        );
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Auto),
            Action::Stop
        );
    }

    #[test]
    fn gravacao_manual_nunca_e_parada_nem_substituida() {
        let config = config(&[(AppKey::Teams, Policy::Auto)]);
        let mut auto = AutoRecorder::default();
        assert_eq!(
            auto.on_event(&started("teams"), &config, Recording::Manual),
            Action::None
        );
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Manual),
            Action::None
        );
    }

    #[test]
    fn perguntar_espera_a_resposta() {
        let config = DetectionConfig::default();
        let mut auto = AutoRecorder::default();
        assert_eq!(
            auto.on_event(&started("meet"), &config, Recording::Idle),
            Action::Ask(AppKey::Meet)
        );
        assert_eq!(auto.pending_ask(), Some(AppKey::Meet));
        assert_eq!(
            auto.answer(true, Recording::Idle),
            Action::Start(AppKey::Meet)
        );
        assert_eq!(auto.pending_ask(), None);
        assert_eq!(auto.answer(true, Recording::Idle), Action::None);
        // Gravação aceita pela pergunta é automática: para no fim.
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Auto),
            Action::Stop
        );
    }

    #[test]
    fn ignorar_a_pergunta_vale_ate_o_fim_da_reuniao() {
        let config = DetectionConfig::default();
        let mut auto = AutoRecorder::default();
        auto.on_event(&started("teams"), &config, Recording::Idle);
        assert_eq!(auto.answer(false, Recording::Idle), Action::Dismiss);
        assert_eq!(auto.pending_ask(), None);
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Idle),
            Action::None
        );
    }

    #[test]
    fn pergunta_some_quando_a_reuniao_acaba_ou_o_usuario_grava_a_mao() {
        let config = DetectionConfig::default();
        let mut auto = AutoRecorder::default();
        auto.on_event(&started("zoom"), &config, Recording::Idle);
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Idle),
            Action::Dismiss
        );

        auto.on_event(&started("zoom"), &config, Recording::Idle);
        assert_eq!(auto.on_manual_start(), Action::Dismiss);
        assert_eq!(auto.on_manual_start(), Action::None);
        // Resposta atrasada com gravação já em curso não inicia outra.
        auto.on_event(&MeetingEvent::Ended, &config, Recording::Manual);
        auto.on_event(&started("zoom"), &config, Recording::Idle);
        assert_eq!(auto.answer(true, Recording::Manual), Action::Dismiss);
    }

    #[test]
    fn ignorar_e_deteccao_desligada_nao_fazem_nada() {
        let mut auto = AutoRecorder::default();
        let ignore = config(&[(AppKey::Slack, Policy::Ignore)]);
        assert_eq!(
            auto.on_event(&started("slack"), &ignore, Recording::Idle),
            Action::None
        );
        let off = DetectionConfig {
            enabled: false,
            ..config(&[(AppKey::Teams, Policy::Auto)])
        };
        assert_eq!(
            auto.on_event(&started("teams"), &off, Recording::Idle),
            Action::None
        );
        // App desconhecido cai em `outro`, ignorado por padrão.
        assert_eq!(
            auto.on_event(
                &started("skype"),
                &DetectionConfig::default(),
                Recording::Idle
            ),
            Action::None
        );
    }

    #[test]
    fn mudar_a_config_tira_a_pergunta_pendente() {
        let mut auto = AutoRecorder::default();
        auto.on_event(
            &started("teams"),
            &DetectionConfig::default(),
            Recording::Idle,
        );
        assert_eq!(
            auto.on_config_change(&DetectionConfig::default()),
            Action::None
        );
        let now_auto = config(&[(AppKey::Teams, Policy::Auto)]);
        assert_eq!(auto.on_config_change(&now_auto), Action::Dismiss);
        assert_eq!(auto.pending_ask(), None);
    }

    #[test]
    fn config_le_json_parcial_e_grava_chaves_legiveis() {
        let config: DetectionConfig =
            serde_json::from_str(r#"{"policies": {"teams": "auto", "outro": "ask"}}"#).unwrap();
        assert!(config.enabled);
        assert_eq!(config.policy(AppKey::Teams), Policy::Auto);
        assert_eq!(config.policy(AppKey::Outro), Policy::Ask);
        assert_eq!(config.policy(AppKey::Zoom), Policy::Ask);
        let text = serde_json::to_string(&config).unwrap();
        assert!(text.contains(r#""teams":"auto""#), "{text}");
    }
}
