//! Automatic recording: from per-app policies and meeting events to actions the app
//! executes (start, stop, ask). Pure; the app executes the actions and shows the visible
//! indicator.

use std::collections::BTreeMap;

use eclume_recorder::MeetingEvent;
use serde::{Deserialize, Serialize};

use crate::classify::AppKey;

/// What to do when a meeting starts in an app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    /// Record without asking (with a tray indicator and a notification).
    Auto,
    /// Ask the user through notification, tray and window.
    #[default]
    Ask,
    /// Do nothing.
    Ignore,
}

/// Policy when none is configured: ask, except for `outro` (dictation, voice recorder,
/// games), which is ignored.
pub fn default_policy(app: AppKey) -> Policy {
    match app {
        AppKey::Outro => Policy::Ignore,
        _ => Policy::Ask,
    }
}

/// The `detection` section of the app config.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectionConfig {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Only policies the user changed; the rest comes from [`default_policy`].
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

/// The ongoing recording from detection's point of view.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recording {
    Idle,
    /// Started by the user: detection never stops it.
    Manual,
    /// Started by detection: stops when the meeting ends.
    Auto,
}

/// What the app should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    Start(AppKey),
    Stop,
    /// Ask whether to record this app's meeting.
    Ask(AppKey),
    /// Remove the pending question from the screen.
    Dismiss,
}

/// The automatic recording state machine.
#[derive(Clone, Debug, Default)]
pub struct AutoRecorder {
    meeting: Option<AppKey>,
    asking: Option<AppKey>,
}

impl AutoRecorder {
    /// The ongoing meeting, if any.
    pub fn meeting(&self) -> Option<AppKey> {
        self.meeting
    }

    /// The question awaiting an answer, if any.
    pub fn pending_ask(&self) -> Option<AppKey> {
        self.asking
    }

    /// A detector event. A meeting triggers only once: the detector never repeats `Started`
    /// before `Ended`, so stopping manually or answering "Ignore" lasts until it ends.
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

    /// The user's answer to the pending question: `true` records, `false` ignores this meeting.
    pub fn answer(&mut self, record: bool, recording: Recording) -> Action {
        match self.asking.take() {
            Some(app) if record && recording == Recording::Idle => Action::Start(app),
            Some(_) => Action::Dismiss,
            None => Action::None,
        }
    }

    /// The user started a recording manually: the pending question no longer applies.
    pub fn on_manual_start(&mut self) -> Action {
        if self.asking.take().is_some() {
            Action::Dismiss
        } else {
            Action::None
        }
    }

    /// Config changed: disabling detection, or changing the policy of the app being asked about
    /// from
    /// `ask`, removes the pending question.
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
    fn default_policies() {
        let config = DetectionConfig::default();
        assert!(config.enabled);
        assert_eq!(config.policy(AppKey::Teams), Policy::Ask);
        assert_eq!(config.policy(AppKey::Navegador), Policy::Ask);
        assert_eq!(config.policy(AppKey::Outro), Policy::Ignore);
        let custom = self::config(&[(AppKey::Outro, Policy::Auto)]);
        assert_eq!(custom.policy(AppKey::Outro), Policy::Auto);
    }

    #[test]
    fn auto_records_and_stops_at_meeting_end() {
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
    fn whatsapp_call_has_its_own_policy() {
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
    fn manual_recording_is_never_stopped_or_replaced() {
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
    fn asking_waits_for_answer() {
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
        // A recording accepted through the question is automatic: stops at the end.
        assert_eq!(
            auto.on_event(&MeetingEvent::Ended, &config, Recording::Auto),
            Action::Stop
        );
    }

    #[test]
    fn ignoring_question_lasts_until_meeting_end() {
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
    fn question_disappears_when_meeting_ends_or_user_records_manually() {
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
        // A late answer when recording is already in progress does not start another.
        auto.on_event(&MeetingEvent::Ended, &config, Recording::Manual);
        auto.on_event(&started("zoom"), &config, Recording::Idle);
        assert_eq!(auto.answer(true, Recording::Manual), Action::Dismiss);
    }

    #[test]
    fn ignore_and_disabled_detection_do_nothing() {
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
        // An unknown app falls back to `outro`, ignored by default.
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
    fn config_change_removes_pending_question() {
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
    fn config_reads_partial_json_and_writes_readable_keys() {
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
