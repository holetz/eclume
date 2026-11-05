//! The recording session through the core, with a synthetic source in place of the microphone.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{temp_dirs, FakeTransports, Script};
use eclume_mobile_core::session::MicState;
use eclume_mobile_core::{Badge, Core, StopReason};
use eclume_recorder::source::SineSource;
use eclume_recorder::{AudioSource, Queue, Source, SourceState, Status};

/// A sine delivered in real time, like a microphone: 10 ms per read.
struct Microphone(SineSource);

impl AudioSource for Microphone {
    fn sample_rate(&self) -> u32 {
        self.0.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        std::thread::sleep(Duration::from_millis(10));
        self.0.read(timeout)
    }
}

fn microphone(seconds: u64) -> Box<dyn AudioSource> {
    Box::new(Microphone(SineSource::new(
        48_000,
        440.0,
        0.4,
        Duration::from_secs(seconds),
    )))
}

fn open(dirs: eclume_mobile_core::config::Dirs) -> Core {
    Core::open(dirs, "0.1.0", Arc::new(FakeTransports(Script::default()))).unwrap()
}

#[test]
fn record_pause_mark_stop_and_save() {
    let (dirs, _guard) = temp_dirs("sessao");
    let mut core = open(dirs.clone());
    core.set_device("Pixel 8").unwrap();
    let id = core.record(microphone(30)).unwrap();
    assert!(core.record(microphone(1)).is_err());
    std::thread::sleep(Duration::from_millis(200));

    let marker = core.mark(None).unwrap();
    assert!(marker.at_ms > 0);
    let annotated = core
        .annotate_marker(&marker.client_id, Some("Decisão do orçamento"))
        .unwrap();
    assert_eq!(annotated.note.as_deref(), Some("Decisão do orçamento"));

    core.pause().unwrap();
    std::thread::sleep(Duration::from_millis(30));
    let state = core.state().unwrap();
    let session = state.session.unwrap();
    assert!(session.paused);
    assert_eq!(session.markers.len(), 1);
    let paused_at = session.audio_ms;
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(core.state().unwrap().session.unwrap().audio_ms, paused_at);
    core.resume().unwrap();
    std::thread::sleep(Duration::from_millis(100));

    let recording = core.stop().unwrap();
    assert_eq!(recording.id, id);
    assert_eq!(recording.source, Source::Mobile);
    assert!(recording.details_pending);
    let sheet = core.state().unwrap().sheet.unwrap();
    assert_eq!((sheet.id.as_str(), sheet.markers), (id.as_str(), 1));
    assert_eq!(core.state().unwrap().pending, 1);

    core.save_details(&id, Some("Visita ao cliente"), None, Some("en"))
        .unwrap();
    assert_eq!(core.state().unwrap().sheet, None);
    let list = core.recordings().unwrap();
    assert_eq!(list[0].title.as_deref(), Some("Visita ao cliente"));
    assert_eq!(list[0].badge, Badge::Waiting);
    assert_eq!(list[0].markers, 1);
    let queue = core.queue().lock().unwrap();
    assert_eq!(
        queue.get(&id).unwrap().unwrap().language.as_deref(),
        Some("en")
    );
    drop(queue);
    let detail = core.recording(&id).unwrap();
    assert!(detail.path.unwrap().ends_with(".ogg"));
    // It only leaves the phone after being synced.
    assert!(core.delete_local(&id).is_err());
}

#[test]
fn crash_midway_stays_interrupted_and_without_sheet() {
    let (dirs, _guard) = temp_dirs("queda");
    {
        let queue = Queue::open(&dirs.queue()).unwrap();
        std::fs::create_dir_all(dirs.recordings()).unwrap();
        let part = dirs.recordings().join("orfa.ogg.part");
        std::fs::write(&part, b"OggS parcial").unwrap();
        queue.begin("orfa", &part, 1).unwrap();
        queue.set_details_pending("orfa").unwrap();
    }
    let core = open(dirs.clone());
    let list = core.recordings().unwrap();
    assert_eq!(list[0].badge, Badge::Interrupted);
    let rec = core.queue().lock().unwrap().get("orfa").unwrap().unwrap();
    assert_eq!(rec.status, Status::Pending);
    assert!(!rec.details_pending);
    assert!(dirs.recordings().join("orfa.ogg").exists());
}

#[test]
fn limits_stop_without_space_and_warn() {
    let (dirs, _guard) = temp_dirs("limites");
    let mut core = open(dirs);
    core.store_device_locale(Some("pt-BR".into())).unwrap();
    // 40 min of space at 24 kbps: a warning on the home screen.
    core.update_device(80, false, 7_200_000);
    let warning = core.state().unwrap().warnings.storage.unwrap();
    assert_eq!(warning.remaining, "cerca de 40 min");
    assert_eq!(
        core.state().unwrap().free_space.as_deref(),
        Some("cerca de 40 min")
    );

    core.record(microphone(30)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(core.check_limits().unwrap().is_none());
    // Less than 5 min free: stops and saves on its own.
    core.update_device(12, false, 600_000);
    assert_eq!(core.state().unwrap().warnings.battery.unwrap().pct, 12);
    let (stopped, reason) = core.check_limits().unwrap().unwrap();
    assert_eq!(stopped.status, Status::Pending);
    assert_eq!(reason, StopReason::NoSpace);
    assert_eq!(
        serde_json::to_value(reason).unwrap(),
        serde_json::json!("sem_espaco")
    );
    assert!(core.state().unwrap().session.is_none());
    assert!(core.state().unwrap().warnings.battery.is_none());
}

#[test]
fn estimates_follow_the_english_locale() {
    let (dirs, _guard) = temp_dirs("english-estimates");
    let mut core = open(dirs);
    core.store_device_locale(Some("en".into())).unwrap();
    core.update_device(80, false, 7_200_000);
    let state = core.state().unwrap();
    assert_eq!(state.warnings.storage.unwrap().remaining, "about 40 min");
    assert_eq!(state.free_space.as_deref(), Some("about 40 min"));
}

#[test]
fn language_options_follow_the_locale_and_keep_autonyms() {
    let (dirs, _guard) = temp_dirs("language-options");
    let mut core = open(dirs);
    for (locale, default, auto) in [
        ("en", "Account default", "Detect automatically"),
        ("pt-BR", "Padrão da conta", "Detectar automaticamente"),
    ] {
        core.store_device_locale(Some(locale.into())).unwrap();
        let options = core.language_options();
        let actual: Vec<(&str, &str)> = options
            .iter()
            .map(|option| (option.value.as_str(), option.label.as_str()))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("", default),
                ("auto", auto),
                ("pt", "Português"),
                ("es", "Español"),
                ("en", "English"),
            ]
        );
    }
    core.store_account_language("pt-BR".into()).unwrap();
    for (locale, expected) in [
        ("en", "Account default: Português"),
        ("pt-BR", "Padrão da conta: Português"),
    ] {
        core.store_device_locale(Some(locale.into())).unwrap();
        assert_eq!(core.language_options()[0].label, expected);
    }
}

/// A microphone that drops at `away.0` and returns at `away.1` (since opening), as the reconnecting
/// source reports: silence and `Reconnecting` while it is away.
struct DroppingMicrophone {
    sine: Microphone,
    opened: std::time::Instant,
    away: (Duration, Duration),
}

impl AudioSource for DroppingMicrophone {
    fn sample_rate(&self) -> u32 {
        self.sine.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        let samples = self.sine.read(timeout)?;
        Some(match self.state() {
            SourceState::Live => samples,
            SourceState::Reconnecting { .. } => vec![0.0; samples.len()],
        })
    }

    fn state(&self) -> SourceState {
        let now = self.opened.elapsed();
        if now >= self.away.0 && now < self.away.1 {
            SourceState::Reconnecting {
                since: self.opened + self.away.0,
            }
        } else {
            SourceState::Live
        }
    }
}

#[test]
fn dropping_microphone_keeps_recording_and_becomes_markers() {
    let (dirs, _guard) = temp_dirs("microfone");
    let mut core = open(dirs);
    let source = DroppingMicrophone {
        sine: Microphone(SineSource::new(48_000, 440.0, 0.4, Duration::from_secs(60))),
        opened: std::time::Instant::now(),
        away: (Duration::from_millis(300), Duration::from_millis(6_000)),
    };
    core.record(Box::new(source)).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    core.watch().unwrap();
    let session = core.state().unwrap().session.unwrap();
    assert_eq!(session.mic, MicState::Reconnecting);
    // Less than 5 s away: no marker yet.
    assert!(session.markers.is_empty());

    std::thread::sleep(Duration::from_millis(4_800));
    core.watch().unwrap();
    let markers = core.state().unwrap().session.unwrap().markers;
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].note.as_deref(), Some("microfone perdido"));

    std::thread::sleep(Duration::from_millis(700));
    core.watch().unwrap();
    let session = core.state().unwrap().session.unwrap();
    assert_eq!(session.mic, MicState::Ok);
    assert_eq!(session.markers.len(), 2);
    assert_eq!(
        session.markers[1].note.as_deref(),
        Some("microfone de volta")
    );
    assert!(
        core.check_limits().unwrap().is_none(),
        "the recording went on"
    );
    core.stop().unwrap();
}

#[test]
fn silence_imposed_by_the_system_shows_and_marks() {
    let (dirs, _guard) = temp_dirs("silenciada");
    let mut core = open(dirs);
    assert!(
        core.set_muted(true).is_err(),
        "with no recording, nothing to mute"
    );
    core.record(microphone(30)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    core.set_muted(true).unwrap();
    core.set_muted(true).unwrap();
    let session = core.state().unwrap().session.unwrap();
    assert!(session.muted);
    assert_eq!(session.markers.len(), 1);
    assert_eq!(
        session.markers[0].note.as_deref(),
        Some("silenciado pelo sistema")
    );
    core.set_muted(false).unwrap();
    assert!(!core.state().unwrap().session.unwrap().muted);
    core.stop().unwrap();
}
