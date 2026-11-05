//! Detection debounce: a meeting only starts after a few continuous seconds of signal and only
//! ends after a longer silence, so brief mic releases (device switches, reconnection)
//! do not open and close recordings.

use std::time::{Duration, Instant};

use eclume_recorder::{MeetingDetector, MeetingEvent};

use crate::classify::{classify, AppKey, SignalSource};

/// How long the signal must last to start, or be absent to end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DebounceConfig {
    pub start_after: Duration,
    pub end_after: Duration,
}

impl Default for DebounceConfig {
    fn default() -> Self {
        Self {
            start_after: Duration::from_secs(3),
            end_after: Duration::from_secs(15),
        }
    }
}

/// Turns classification at each instant into meeting start and end events.
#[derive(Clone, Debug)]
pub struct Debouncer {
    config: DebounceConfig,
    /// Since when detection has been continuous, before the meeting starts.
    present_since: Option<Instant>,
    /// Since when detection has been absent, during an ongoing meeting.
    absent_since: Option<Instant>,
    active: Option<AppKey>,
}

impl Debouncer {
    pub fn new(config: DebounceConfig) -> Self {
        Self {
            config,
            present_since: None,
            absent_since: None,
            active: None,
        }
    }

    /// The ongoing meeting, after debounce.
    pub fn active(&self) -> Option<AppKey> {
        self.active
    }

    /// Records the classification observed at `now`. The app announced at the start is from the
    /// last
    /// observation; an app switch during the meeting does not generate an event.
    pub fn observe(&mut self, now: Instant, detection: Option<AppKey>) -> Option<MeetingEvent> {
        match (self.active, detection) {
            (None, Some(app)) => {
                let since = *self.present_since.get_or_insert(now);
                if now.duration_since(since) < self.config.start_after {
                    return None;
                }
                self.present_since = None;
                self.active = Some(app);
                Some(MeetingEvent::Started {
                    app: app.as_str().to_string(),
                })
            }
            (None, None) => {
                self.present_since = None;
                None
            }
            (Some(_), Some(_)) => {
                self.absent_since = None;
                None
            }
            (Some(_), None) => {
                let since = *self.absent_since.get_or_insert(now);
                if now.duration_since(since) < self.config.end_after {
                    return None;
                }
                self.absent_since = None;
                self.active = None;
                Some(MeetingEvent::Ended)
            }
        }
    }
}

/// `MeetingDetector` over a signal source: each `poll` takes a snapshot, classifies it and passes
/// it through debounce. The clock is injectable for tests.
pub struct DebouncedDetector<S> {
    source: S,
    debouncer: Debouncer,
    clock: Box<dyn FnMut() -> Instant + Send>,
    /// Last failure logged, to avoid repeating the same one every second.
    last_error: Option<String>,
}

impl<S: SignalSource> DebouncedDetector<S> {
    pub fn new(source: S, config: DebounceConfig) -> Self {
        Self::with_clock(source, config, Instant::now)
    }

    pub fn with_clock(
        source: S,
        config: DebounceConfig,
        clock: impl FnMut() -> Instant + Send + 'static,
    ) -> Self {
        Self {
            source,
            debouncer: Debouncer::new(config),
            clock: Box::new(clock),
            last_error: None,
        }
    }

    pub fn active(&self) -> Option<AppKey> {
        self.debouncer.active()
    }
}

impl<S: SignalSource> MeetingDetector for DebouncedDetector<S> {
    fn poll(&mut self) -> Option<MeetingEvent> {
        let now = (self.clock)();
        match self.source.snapshot() {
            Ok(snapshot) => {
                self.last_error = None;
                self.debouncer.observe(now, classify(&snapshot))
            }
            // No signal at this instant: counts as neither presence nor absence.
            Err(err) => {
                let message = format!("{err:#}");
                if self.last_error.as_deref() != Some(message.as_str()) {
                    log::warn!("failed to read meeting signals: {message}");
                    self.last_error = Some(message);
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::classify::{AudioClient, Snapshot};

    fn secs(start: Instant, s: u64) -> Instant {
        start + Duration::from_secs(s)
    }

    #[test]
    fn starts_only_after_continuous_signal() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        assert_eq!(d.observe(t0, Some(AppKey::Teams)), None);
        assert_eq!(d.observe(secs(t0, 2), Some(AppKey::Teams)), None);
        // A gap resets the count.
        assert_eq!(d.observe(secs(t0, 2), None), None);
        assert_eq!(d.observe(secs(t0, 4), Some(AppKey::Teams)), None);
        assert_eq!(d.observe(secs(t0, 6), Some(AppKey::Teams)), None);
        assert_eq!(
            d.observe(secs(t0, 7), Some(AppKey::Teams)),
            Some(MeetingEvent::Started {
                app: "teams".into()
            })
        );
        assert_eq!(d.active(), Some(AppKey::Teams));
        assert_eq!(d.observe(secs(t0, 8), Some(AppKey::Teams)), None);
    }

    #[test]
    fn ends_only_after_long_silence() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        d.observe(t0, Some(AppKey::Zoom));
        assert!(d.observe(secs(t0, 3), Some(AppKey::Zoom)).is_some());
        // The mic releases for 10 s and returns: the meeting continues.
        assert_eq!(d.observe(secs(t0, 10), None), None);
        assert_eq!(d.observe(secs(t0, 20), None), None);
        assert_eq!(d.observe(secs(t0, 21), Some(AppKey::Zoom)), None);
        assert_eq!(d.observe(secs(t0, 30), None), None);
        assert_eq!(d.observe(secs(t0, 44), None), None);
        assert_eq!(d.observe(secs(t0, 45), None), Some(MeetingEvent::Ended));
        assert_eq!(d.active(), None);
        assert_eq!(d.observe(secs(t0, 60), None), None);
    }

    #[test]
    fn app_switch_mid_meeting_emits_no_event_and_announces_last_app() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        d.observe(t0, Some(AppKey::Navegador));
        assert_eq!(
            d.observe(secs(t0, 3), Some(AppKey::Meet)),
            Some(MeetingEvent::Started { app: "meet".into() })
        );
        assert_eq!(d.observe(secs(t0, 4), Some(AppKey::Navegador)), None);
        assert_eq!(d.active(), Some(AppKey::Meet));
    }

    struct Scripted(Vec<anyhow::Result<Snapshot>>);

    impl SignalSource for Scripted {
        fn snapshot(&mut self) -> anyhow::Result<Snapshot> {
            if self.0.is_empty() {
                Ok(Snapshot::default())
            } else {
                self.0.remove(0)
            }
        }
    }

    #[test]
    fn detector_classifies_each_snapshot_and_ignores_read_failure() {
        let teams = || {
            Ok(Snapshot {
                mic_users: vec![AudioClient::new("ms-teams", "Microsoft Teams")],
                ..Snapshot::default()
            })
        };
        let script = vec![
            teams(),
            Err(anyhow::anyhow!("pulse fora")),
            teams(),
            teams(),
        ];
        let t0 = Instant::now();
        let tick = Arc::new(Mutex::new(0_u64));
        let clock_tick = Arc::clone(&tick);
        let mut detector =
            DebouncedDetector::with_clock(Scripted(script), DebounceConfig::default(), move || {
                let mut n = clock_tick.lock().unwrap();
                let now = t0 + Duration::from_secs(*n);
                *n += 1;
                now
            });
        assert_eq!(detector.poll(), None); // t=0, starts counting
        assert_eq!(detector.poll(), None); // t=1, failure: ignored
        assert_eq!(detector.poll(), None); // t=2
        assert_eq!(
            detector.poll(),
            Some(MeetingEvent::Started {
                app: "teams".into()
            })
        ); // t=3
        assert_eq!(detector.active(), Some(AppKey::Teams));
    }
}
