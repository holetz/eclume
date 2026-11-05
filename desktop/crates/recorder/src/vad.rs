//! Energy-based silence detector for voice notes: indicates when the person stopped speaking
//! (`Silence`) or never spoke (`NoSpeech`), and stores recent levels for the meter.
//!
//! Pure, without devices: takes the mixed 16 kHz samples the session already produces and
//! splits them into 20 ms frames. Each frame has its RMS in dBFS. The noise floor is the 20th
//! percentile of levels over the last 3 s: new background noise becomes the floor in about 2.4
//! s, and speech, which has pauses, does not raise it. Digital silence is never a floor: when
//! the percentile falls into it (muted mic, or a noise suppressor that zeroes pauses), only
//! absolute thresholds apply. A frame becomes speech above `max(floor + 12 dB, −55 dBFS)` and
//! remains speech above `max(floor + 8 dB, −58 dBFS)`. Only sustained speech (5 of the last 10
//! frames) counts: a click, a keystroke or a slamming door does not reset silence. After the
//! first speech, only sound close to it resets silence: sustained speech within 25 dB of the
//! recent speech peak (which decays at 2.5 dB/s). A breath, a distant hum or chair noise is
//! excluded. Silence counts from the last sustained speech frame, and the voice note stops
//! exactly at the configured time; the countdown only appears after 300 ms without speech, to
//! avoid flickering between syllables. With a single speaker close to the microphone, energy
//! with an adaptive floor suffices; a trained VAD would bring a native dependency.

use std::collections::VecDeque;
use std::time::Duration;

use crate::mix::TARGET_RATE;

/// Frame duration, in ms.
pub const FRAME_MS: u64 = 20;
/// Samples per frame at 16 kHz.
pub const FRAME_SAMPLES: usize = (TARGET_RATE as usize) * (FRAME_MS as usize) / 1000;
/// Meter bars.
pub const METER_BARS: usize = 16;

/// How far above the floor a frame must be to become speech.
const VOICE_MARGIN_DB: f32 = 12.0;
/// Below this, it never becomes speech, however quiet the floor.
const VOICE_MIN_DBFS: f32 = -55.0;
/// How far above the floor ongoing speech must stay to remain speech.
const KEEP_MARGIN_DB: f32 = 8.0;
/// Below this, ongoing speech ends.
const KEEP_MIN_DBFS: f32 = -58.0;
/// Frames considered by the floor: the last 3 s.
const FLOOR_FRAMES: usize = 150;
/// The floor is this percentile of recent levels.
const FLOOR_PERCENTILE: usize = 20;
/// Frames below this are digital silence (muted, stopped source, zeroed pause): not a floor.
const DIGITAL_SILENCE_DBFS: f32 = -90.0;
/// Sustained speech: at least `SUSTAINED_FRAMES` speech frames in the last `SUSTAIN_WINDOW`.
const SUSTAINED_FRAMES: u32 = 5;
const SUSTAIN_WINDOW: u32 = 10;
/// The countdown only appears after this long without speech.
const COUNTDOWN_AFTER_MS: u64 = 300;
/// After the first speech, speech resetting silence stays at most this far below its peak.
const SPEECH_GATE_DB: f32 = 25.0;
/// Speech peak decay per frame (2.5 dB/s), to follow someone who starts speaking more quietly.
const SPEECH_PEAK_DECAY_DB: f32 = 0.05;
/// Without any speech in this time, the voice note is discarded.
const NO_SPEECH_MS: u64 = 10_000;
/// Digital silence frame level (zero RMS).
const SILENT_DBFS: f32 = -100.0;
/// The meter ranges from −60 dBFS (empty) to 0 dBFS (full).
const METER_MIN_DBFS: f32 = -60.0;

/// Why the detector requests a stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    /// Speech followed by the configured silence.
    Silence,
    /// No speech in the first 10 s.
    NoSpeech,
}

/// The detector state throughout a voice note.
#[derive(Debug)]
pub struct SilenceDetector {
    /// Silence that ends the voice note; `None` ("Never") only feeds the meter.
    stop_after_ms: Option<u64>,
    /// Samples that do not yet fill a frame.
    pending: Vec<f32>,
    /// Levels of the last [`FLOOR_FRAMES`] frames, which define the floor.
    floor_history: VecDeque<f32>,
    /// The previous frame was speech (hysteresis).
    voiced: bool,
    /// One bit per recent frame, newest at bit 0: it was speech.
    recent_voiced: u32,
    /// Recent sustained speech peak, in dBFS, decaying by [`SPEECH_PEAK_DECAY_DB`] per frame.
    speech_peak: f32,
    heard_voice: bool,
    silence_ms: u64,
    elapsed_ms: u64,
    levels: VecDeque<f32>,
    event: Option<VadEvent>,
}

impl SilenceDetector {
    pub fn new(stop_after_silence: Option<Duration>) -> Self {
        Self {
            stop_after_ms: stop_after_silence
                .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
            pending: Vec::with_capacity(FRAME_SAMPLES),
            floor_history: VecDeque::with_capacity(FLOOR_FRAMES),
            voiced: false,
            recent_voiced: 0,
            speech_peak: f32::NEG_INFINITY,
            heard_voice: false,
            silence_ms: 0,
            elapsed_ms: 0,
            levels: VecDeque::with_capacity(METER_BARS),
            event: None,
        }
    }

    /// Consumes samples (16 kHz, mono). Returns the stop event as soon as it happens;
    /// afterwards, the same event remains available in [`Self::event`].
    pub fn push(&mut self, samples: &[f32]) -> Option<VadEvent> {
        let before = self.event;
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (FRAME_SAMPLES - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == FRAME_SAMPLES {
                let level = frame_dbfs(&self.pending);
                self.pending.clear();
                self.on_frame(level);
            }
        }
        if before.is_none() {
            self.event
        } else {
            None
        }
    }

    fn on_frame(&mut self, level: f32) {
        self.elapsed_ms += FRAME_MS;
        if self.levels.len() == METER_BARS {
            self.levels.pop_front();
        }
        self.levels.push_back(level);

        // Without a floor (startup or digital silence), absolute thresholds apply.
        let floor = self.floor().unwrap_or(f32::NEG_INFINITY);
        if self.floor_history.len() == FLOOR_FRAMES {
            self.floor_history.pop_front();
        }
        self.floor_history.push_back(level);

        self.voiced = if self.voiced {
            level > (floor + KEEP_MARGIN_DB).max(KEEP_MIN_DBFS)
        } else {
            level > (floor + VOICE_MARGIN_DB).max(VOICE_MIN_DBFS)
        };
        let window = (1 << SUSTAIN_WINDOW) - 1;
        self.recent_voiced = ((self.recent_voiced << 1) | u32::from(self.voiced)) & window;
        self.speech_peak -= SPEECH_PEAK_DECAY_DB;
        let sustained = self.voiced
            && self.recent_voiced.count_ones() >= SUSTAINED_FRAMES
            && (!self.heard_voice || level >= self.speech_peak - SPEECH_GATE_DB);

        if sustained {
            self.heard_voice = true;
            self.speech_peak = self.speech_peak.max(level);
            self.silence_ms = 0;
        } else {
            self.silence_ms += FRAME_MS;
        }

        if self.event.is_some() {
            return;
        }
        let Some(stop_after) = self.stop_after_ms else {
            return;
        };
        if self.heard_voice && self.silence_ms >= stop_after {
            self.event = Some(VadEvent::Silence);
        } else if !self.heard_voice && self.elapsed_ms >= NO_SPEECH_MS {
            self.event = Some(VadEvent::NoSpeech);
        }
    }

    /// The 20th percentile of recent levels; `None` without frames or when it is digital
    /// silence.
    fn floor(&self) -> Option<f32> {
        if self.floor_history.is_empty() {
            return None;
        }
        let mut levels: Vec<f32> = self.floor_history.iter().copied().collect();
        let index = levels.len() * FLOOR_PERCENTILE / 100;
        let (_, floor, _) = levels.select_nth_unstable_by(index, f32::total_cmp);
        Some(*floor).filter(|floor| *floor >= DIGITAL_SILENCE_DBFS)
    }

    /// The stop event, if it has happened.
    pub fn event(&self) -> Option<VadEvent> {
        self.event
    }

    /// Whether there has been sustained speech.
    pub fn heard_voice(&self) -> bool {
        self.heard_voice
    }

    /// Continuous silence since the last speech, in ms.
    pub fn silence_ms(&self) -> u64 {
        self.silence_ms
    }

    /// Silence remaining before stopping, after speech has occurred and while silent; `None`
    /// otherwise or with "Never".
    pub fn stops_in_ms(&self) -> Option<u64> {
        let stop_after = self.stop_after_ms?;
        (self.heard_voice && self.silence_ms > COUNTDOWN_AFTER_MS && self.event.is_none())
            .then(|| stop_after.saturating_sub(self.silence_ms))
    }

    /// The last [`METER_BARS`] levels, oldest to newest, from 0 (−60 dBFS or less) to 1 (0
    /// dBFS). Before enough frames exist, the beginning stays at 0.
    pub fn meter(&self) -> [f32; METER_BARS] {
        let mut bars = [0.0; METER_BARS];
        let offset = METER_BARS - self.levels.len();
        for (bar, level) in bars[offset..].iter_mut().zip(&self.levels) {
            *bar = ((level - METER_MIN_DBFS) / -METER_MIN_DBFS).clamp(0.0, 1.0);
        }
        bars
    }
}

/// Frame RMS in dBFS (digital silence becomes −100).
fn frame_dbfs(frame: &[f32]) -> f32 {
    let energy = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    if energy <= 0.0 {
        return SILENT_DBFS;
    }
    (10.0 * energy.log10()).max(SILENT_DBFS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: usize = TARGET_RATE as usize;

    /// Deterministic white noise with peak amplitude `amplitude`.
    struct Noise(u32);

    impl Noise {
        fn samples(&mut self, ms: usize, amplitude: f32) -> Vec<f32> {
            (0..RATE * ms / 1000)
                .map(|_| {
                    self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (self.0 >> 8) as f32 / (1 << 24) as f32 * 2.0 - 1.0
                })
                .map(|s| s * amplitude)
                .collect()
        }
    }

    /// "Speech": 220 Hz tone in 200 ms bursts with 100 ms pauses, over the noise.
    fn speech(noise: &mut Noise, ms: usize) -> Vec<f32> {
        let mut out = noise.samples(ms, 0.002);
        for (i, sample) in out.iter_mut().enumerate() {
            let t_ms = i * 1000 / RATE;
            if t_ms % 300 < 200 {
                *sample +=
                    0.3 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / RATE as f32).sin();
            }
        }
        out
    }

    /// Feeds in 10 ms blocks, like the recording loop, and returns the event time (ms since the
    /// segment started).
    fn feed(detector: &mut SilenceDetector, samples: &[f32]) -> Option<(VadEvent, usize)> {
        let block = RATE / 100;
        for (i, chunk) in samples.chunks(block).enumerate() {
            if let Some(event) = detector.push(chunk) {
                return Some((event, (i + 1) * 10));
            }
        }
        None
    }

    #[test]
    fn stops_after_configured_silence() {
        let mut noise = Noise(1);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        assert_eq!(feed(&mut detector, &speech(&mut noise, 3_000)), None);
        assert!(detector.heard_voice());

        let (event, at) = feed(&mut detector, &noise.samples(10_000, 0.002)).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // The last burst ends 100 ms before speech ends: 4 s after it.
        assert!((3_880..=3_920).contains(&at), "stopped at {at} ms");
        assert_eq!(detector.event(), Some(VadEvent::Silence));
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn short_pause_does_not_stop_and_counts_remaining_time() {
        let mut noise = Noise(2);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        assert_eq!(feed(&mut detector, &noise.samples(2_300, 0.002)), None);
        let left = detector.stops_in_ms().unwrap();
        assert!((1_600..=1_800).contains(&left), "{left} ms remaining");
        // Speech resumed: silence resets.
        feed(&mut detector, &speech(&mut noise, 500));
        assert_eq!(detector.silence_ms(), 0);
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn no_voice_in_ten_seconds_is_a_voice_note_without_speech() {
        let mut noise = Noise(3);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let (event, at) = feed(&mut detector, &noise.samples(12_000, 0.002)).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
        assert_eq!(at, 10_000);
        assert!(!detector.heard_voice());
    }

    #[test]
    fn digital_silence_is_also_no_speech() {
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(8)));
        let (event, _) = feed(&mut detector, &vec![0.0; RATE * 11]).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
    }

    #[test]
    fn never_only_feeds_the_meter() {
        let mut noise = Noise(4);
        let mut detector = SilenceDetector::new(None);
        assert_eq!(feed(&mut detector, &noise.samples(12_000, 0.002)), None);
        assert_eq!(feed(&mut detector, &speech(&mut noise, 1_000)), None);
        assert_eq!(feed(&mut detector, &noise.samples(10_000, 0.002)), None);
        assert_eq!(detector.event(), None);
        assert_eq!(detector.stops_in_ms(), None);
        assert!(detector.meter().iter().all(|bar| *bar < 0.2));
    }

    #[test]
    fn new_background_noise_becomes_floor_and_voice_note_stops() {
        let mut noise = Noise(5);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        // A fan starts after speech, about 20 dB above the earlier noise: the floor rises to
        // it, and silence starts counting.
        let fan = noise.samples(60_000, 0.02);
        let (event, at) = feed(&mut detector, &fan).unwrap();
        assert_eq!(event, VadEvent::Silence);
        assert!(at < 40_000, "only stopped at {at} ms");
    }

    /// Background noise with loud `burst_ms` bursts every `every_ms`, starting at `first_ms`:
    /// clicks, keystrokes or a slamming door.
    fn noise_with_bursts(
        noise: &mut Noise,
        ms: usize,
        first_ms: usize,
        every_ms: usize,
        burst_ms: usize,
    ) -> Vec<f32> {
        let mut out = noise.samples(ms, 0.002);
        let loud = noise.samples(ms, 0.5);
        for (i, sample) in out.iter_mut().enumerate() {
            let t_ms = i * 1000 / RATE;
            if t_ms >= first_ms && (t_ms - first_ms) % every_ms < burst_ms {
                *sample = loud[i];
            }
        }
        out
    }

    #[test]
    fn clicks_and_keystrokes_do_not_reset_silence() {
        let mut noise = Noise(6);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 3_000));
        // 30 ms clicks (one or two frames) every 700 ms, out of alignment with frames.
        let clicks = noise_with_bursts(&mut noise, 10_000, 510, 700, 30);
        let (event, at) = feed(&mut detector, &clicks).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // The same time as without clicks (see `stops_after_configured_silence`).
        assert!((3_880..=3_920).contains(&at), "stopped at {at} ms");
    }

    #[test]
    fn clicks_alone_are_not_speech() {
        let mut noise = Noise(7);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let clicks = noise_with_bursts(&mut noise, 12_000, 300, 450, 40);
        let (event, at) = feed(&mut detector, &clicks).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
        assert_eq!(at, 10_000);
        assert!(!detector.heard_voice());
    }

    #[test]
    fn slamming_door_does_not_prevent_stop() {
        let mut noise = Noise(8);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 3_000));
        // A 60 ms bang in the middle of silence.
        let door = noise_with_bursts(&mut noise, 10_000, 2_000, 20_000, 60);
        let (event, at) = feed(&mut detector, &door).unwrap();
        assert_eq!(event, VadEvent::Silence);
        assert!((3_880..=3_920).contains(&at), "stopped at {at} ms");
    }

    #[test]
    fn breathing_after_speech_does_not_reset_silence() {
        let mut noise = Noise(12);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 3_000));
        // A 200 ms breath 1.5 s later: ~14 dB above the background (becomes sustained speech),
        // but ~30 dB below speech, as in the real voice note that took 5.8 s to stop instead of
        // 4.
        let mut quiet = noise.samples(10_000, 0.002);
        let breath = noise.samples(200, 0.0097);
        quiet[RATE * 3 / 2..RATE * 17 / 10].copy_from_slice(&breath);
        let (event, at) = feed(&mut detector, &quiet).unwrap();
        assert_eq!(event, VadEvent::Silence);
        assert!((3_880..=3_920).contains(&at), "stopped at {at} ms");
    }

    #[test]
    fn modulated_speech_resets_silence() {
        let mut noise = Noise(9);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        feed(&mut detector, &noise.samples(2_300, 0.002));
        assert!(detector.silence_ms() > 1_500);
        // 400 ms tone with amplitude varying at 4 Hz, like syllables.
        let mut talk = noise.samples(400, 0.002);
        for (i, sample) in talk.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32;
            let envelope = 0.6 + 0.4 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
            *sample += 0.05 * envelope * (2.0 * std::f32::consts::PI * 180.0 * t).sin();
        }
        feed(&mut detector, &talk);
        assert_eq!(detector.silence_ms(), 0);
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn fan_starting_midway_becomes_floor() {
        let mut noise = Noise(10);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        // Steady noise 10 dB above the earlier noise, starting right after speech.
        let fan = noise.samples(20_000, 0.002 * 10f32.powf(10.0 / 20.0));
        feed(&mut detector, &fan[..RATE * 3]);
        // Right after speech, hysteresis holds speech until the floor rises to the fan.
        assert!(
            detector.floor().unwrap() > -50.0,
            "piso em {:?}",
            detector.floor()
        );
        let before = detector.silence_ms();
        assert!(before > 1_000, "only {before} ms of silence");
        // With the floor already at the fan, silence keeps counting without resetting until
        // stop.
        let (event, at) = feed(&mut detector, &fan[RATE * 3..]).unwrap();
        assert_eq!(event, VadEvent::Silence);
        let expected = 4_000 - before as usize;
        assert!(
            at <= expected + 20,
            "stopped at {at} ms, expected {expected}"
        );
    }

    #[test]
    fn zeroed_pauses_do_not_become_floor() {
        // A noise suppressor that zeroes pauses: speech must count even without background
        // noise.
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let mut gated = speech(&mut Noise(11), 2_000);
        for (i, sample) in gated.iter_mut().enumerate() {
            if (i * 1000 / RATE) % 300 >= 200 {
                *sample = 0.0;
            }
        }
        feed(&mut detector, &gated);
        assert!(detector.heard_voice());
        let (event, at) = feed(&mut detector, &vec![0.0; RATE * 5]).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // The last burst ends at 2 s, with the segment: 2 s after it.
        assert!((1_980..=2_020).contains(&at), "stopped at {at} ms");
    }

    #[test]
    fn sixteen_level_meter_from_oldest_to_newest() {
        let mut detector = SilenceDetector::new(None);
        assert_eq!(detector.meter(), [0.0; METER_BARS]);
        // 0 dBFS RMS (full square wave) fills the bar; silence empties it.
        detector.push(&vec![1.0; FRAME_SAMPLES * 2]);
        let bars = detector.meter();
        assert_eq!(&bars[..METER_BARS - 2], &[0.0; METER_BARS - 2]);
        assert!(bars[METER_BARS - 2..]
            .iter()
            .all(|b| (*b - 1.0).abs() < 1e-3));
        // −30 dBFS is in the middle.
        detector.push(&vec![10f32.powf(-30.0 / 20.0); FRAME_SAMPLES]);
        assert!((detector.meter()[METER_BARS - 1] - 0.5).abs() < 0.01);
        detector.push(&vec![0.0; FRAME_SAMPLES * 20]);
        assert_eq!(detector.meter(), [0.0; METER_BARS]);
    }

    #[test]
    fn incomplete_frame_waits_for_remainder() {
        let mut detector = SilenceDetector::new(None);
        detector.push(&vec![1.0; FRAME_SAMPLES - 1]);
        assert_eq!(detector.meter()[METER_BARS - 1], 0.0);
        detector.push(&[1.0]);
        assert!(detector.meter()[METER_BARS - 1] > 0.99);
    }
}
