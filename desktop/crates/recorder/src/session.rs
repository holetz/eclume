//! A recording session: sources → mixer → Ogg/Opus on disk → queue.
//!
//! The file starts as `<id>.ogg.part` and only becomes `<id>.ogg` on stop. The queue row starts
//! in `recording` and changes to `pending` at the same time. Stopping always closes: a
//! recording thread failure or panic becomes `pending` with `interrupted = 1`. If the process
//! dies midway, or the `.part` remains locked, [`recover_orphans`] fixes the file and row later
//! (on startup, through [`recover`], or during a scan while the app is open).
//!
//! A paused session keeps reading sources and discards samples: the device stays open
//! (reopening it in the background would hit mobile restrictions), and audio time
//! ([`Progress::position_ms`]) only advances while recording.
//!
//! A voice note passes mixed samples through [`SilenceDetector`]: the loop ends automatically
//! after the configured silence, or when there was no speech, and [`Progress`] reports why.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::encode::{OggOpusWriter, DEFAULT_BITRATE};
use crate::mix::{Mixer, TARGET_RATE};
use crate::queue::{now_ms, Kind, Queue, QueuedRecording, Source};
use crate::vad::{SilenceDetector, VadEvent, METER_BARS};
use crate::{AudioSource, SourceState};

/// Maximum time each source read waits for samples.
const READ_TIMEOUT: Duration = Duration::from_millis(10);
const PART_SUFFIX: &str = ".part";
/// Minimum interval between two drop warnings in the log.
const DROP_LOG_EVERY: Duration = Duration::from_secs(10);
/// Attempts to rename the `.part` on stop, with waits doubling from [`RENAME_WAIT`] (~3 s
/// total): on Windows, antivirus and indexers briefly hold the file.
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_WAIT: Duration = Duration::from_millis(200);

/// Where and how to record.
#[derive(Clone, Debug)]
pub struct RecorderConfig {
    /// Recording directory.
    pub dir: PathBuf,
    /// Opus bitrate, in bits/s.
    pub bitrate: i32,
    /// The source stored in the queue (`desktop` or `mobile`).
    pub source: Source,
    /// On stop, the recording waits for title and agenda type before upload
    /// (`details_pending`).
    pub ask_details: bool,
}

impl RecorderConfig {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            bitrate: DEFAULT_BITRATE,
            source: Source::Desktop,
            ask_details: false,
        }
    }
}

/// What to record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartOptions {
    pub kind: Kind,
    /// For a voice note, the silence that ends it; `None` ("Never") does not stop
    /// automatically. Ignored for a meeting.
    pub stop_after_silence: Option<Duration>,
}

impl StartOptions {
    /// A meeting or manual recording: stops only on request or when sources go down.
    pub const MEETING: Self = Self {
        kind: Kind::Meeting,
        stop_after_silence: None,
    };

    pub fn note(stop_after_silence: Option<Duration>) -> Self {
        Self {
            kind: Kind::Note,
            stop_after_silence,
        }
    }
}

/// Why the recording loop ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// Stop request (button, shortcut, tray, meeting end).
    Requested,
    /// All sources ended.
    SourcesEnded,
    /// Voice note: speech followed by the configured silence.
    Silence,
    /// Voice note: no speech in the first few seconds.
    NoSpeech,
    /// Recording failed (I/O error or recording thread panic).
    Failed,
}

impl StopReason {
    const ALL: [Self; 5] = [
        Self::Requested,
        Self::SourcesEnded,
        Self::Silence,
        Self::NoSpeech,
        Self::Failed,
    ];
}

/// Recording progress, shared with the recording thread.
#[derive(Debug)]
pub struct Progress {
    /// Samples recorded, at 16 kHz.
    samples: AtomicU64,
    /// 0 while recording; afterwards, 1 + the index in [`StopReason::ALL`].
    reason: AtomicU8,
    /// Silence remaining before the voice note stops; `u64::MAX` when not counting.
    stops_in_ms: AtomicU64,
    meter: Mutex<[f32; METER_BARS]>,
    paused: AtomicBool,
    /// RMS level of the last mixed segment, as `f32` bits.
    level: AtomicU32,
    /// State of each lane (source), in source order.
    sources: Mutex<Vec<SourceState>>,
    /// Samples dropped due to full rings, summed across lanes.
    dropped: AtomicU64,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            samples: AtomicU64::new(0),
            reason: AtomicU8::new(0),
            stops_in_ms: AtomicU64::new(u64::MAX),
            meter: Mutex::new([0.0; METER_BARS]),
            paused: AtomicBool::new(false),
            level: AtomicU32::new(0),
            sources: Mutex::new(Vec::new()),
            dropped: AtomicU64::new(0),
        }
    }
}

impl Progress {
    /// Audio time, in ms: recorded time, excluding pauses. This is the basis for markers and
    /// does not drift with a source gap as a clock would.
    pub fn position_ms(&self) -> i64 {
        let samples = self.samples.load(Ordering::Acquire);
        i64::try_from(samples * 1_000 / u64::from(TARGET_RATE)).unwrap_or(i64::MAX)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    /// RMS level of the last recorded segment, from 0 to 1; 0 while paused.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Acquire))
    }

    /// The voice note's latest levels, from 0 to 1 (empty for a meeting).
    pub fn meter(&self) -> [f32; METER_BARS] {
        self.meter.lock().map_or([0.0; METER_BARS], |meter| *meter)
    }

    /// Silence remaining before the voice note stops, while the person is silent.
    pub fn stops_in_ms(&self) -> Option<u64> {
        match self.stops_in_ms.load(Ordering::Acquire) {
            u64::MAX => None,
            ms => Some(ms),
        }
    }

    /// State of each lane, in source order: a lane in [`SourceState::Reconnecting`] delivers
    /// silence while the device returns.
    pub fn source_states(&self) -> Vec<SourceState> {
        self.sources
            .lock()
            .map_or_else(|_| Vec::new(), |states| states.clone())
    }

    /// Samples dropped due to full rings so far, summed across lanes.
    pub fn dropped_samples(&self) -> u64 {
        self.dropped.load(Ordering::Acquire)
    }

    /// Copies source states and drops; returns the total drops.
    fn track_sources(&self, sources: &[Box<dyn AudioSource>]) -> u64 {
        if let Ok(mut states) = self.sources.lock() {
            states.clear();
            states.extend(sources.iter().map(|source| source.state()));
        }
        let dropped = sources.iter().map(|source| source.dropped_samples()).sum();
        self.dropped.store(dropped, Ordering::Release);
        dropped
    }

    /// Why recording ended; `None` while recording.
    pub fn stop_reason(&self) -> Option<StopReason> {
        match self.reason.load(Ordering::Acquire) {
            0 => None,
            n => StopReason::ALL.get(usize::from(n - 1)).copied(),
        }
    }

    /// Stores the first reason; later reasons do not replace it.
    fn finish(&self, reason: StopReason) {
        let code = StopReason::ALL
            .iter()
            .position(|r| *r == reason)
            .map_or(0, |i| i as u8 + 1);
        let _ = self
            .reason
            .compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
    }

    fn set_level(&self, level: f32) {
        self.level.store(level.to_bits(), Ordering::Release);
    }

    fn record(&self, samples: &[f32], detector: Option<&SilenceDetector>) {
        self.samples
            .fetch_add(samples.len() as u64, Ordering::AcqRel);
        if !samples.is_empty() {
            self.set_level(rms(samples));
        }
        if let Some(detector) = detector {
            if let Ok(mut meter) = self.meter.lock() {
                *meter = detector.meter();
            }
            self.stops_in_ms.store(
                detector.stops_in_ms().unwrap_or(u64::MAX),
                Ordering::Release,
            );
        }
    }
}

/// A recording in progress.
pub struct ActiveRecording {
    id: String,
    kind: Kind,
    part_path: PathBuf,
    final_path: PathBuf,
    started_at: i64,
    ask_details: bool,
    stop: Arc<AtomicBool>,
    progress: Arc<Progress>,
    worker: JoinHandle<Result<u64>>,
}

/// Starts recording the given sources (mic and system for a meeting, only mic for a voice note)
/// and registers the recording in the queue.
pub fn start(
    config: &RecorderConfig,
    queue: &Queue,
    sources: Vec<Box<dyn AudioSource>>,
    options: StartOptions,
) -> Result<ActiveRecording> {
    if sources.is_empty() {
        return Err(anyhow!("nenhuma fonte de áudio para gravar"));
    }
    std::fs::create_dir_all(&config.dir)
        .with_context(|| format!("falha ao criar {}", config.dir.display()))?;

    let started_at = now_ms();
    let id = new_id(started_at);
    let final_path = config.dir.join(format!("{id}.ogg"));
    let part_path = config.dir.join(format!("{id}.ogg{PART_SUFFIX}"));

    let file = File::create(&part_path)
        .with_context(|| format!("falha ao criar {}", part_path.display()))?;
    let writer = OggOpusWriter::new(BufWriter::new(file), config.bitrate, serial_for(&id))?;
    queue.begin(&id, &part_path, started_at)?;
    if options.kind != Kind::Meeting {
        queue.set_kind(&id, options.kind)?;
    }
    if config.source != Source::Desktop {
        queue.set_source(&id, config.source)?;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Progress::default());
    let detector =
        (options.kind == Kind::Note).then(|| SilenceDetector::new(options.stop_after_silence));
    let worker = {
        let stop = Arc::clone(&stop);
        let progress = Arc::clone(&progress);
        std::thread::Builder::new()
            .name("eclume-gravacao".into())
            .spawn(move || record_loop(sources, writer, detector, &stop, &progress))
            .context("falha ao criar a thread de gravação")?
    };
    log::info!(
        "recording {id} ({}) started at {}",
        options.kind.as_str(),
        part_path.display()
    );

    Ok(ActiveRecording {
        id,
        kind: options.kind,
        part_path,
        final_path,
        started_at,
        ask_details: config.ask_details,
        stop,
        progress,
        worker,
    })
}

impl ActiveRecording {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// Start, in milliseconds since the Unix epoch.
    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    pub fn progress(&self) -> &Progress {
        &self.progress
    }

    /// Pauses (or resumes) without closing sources: while paused, read samples are discarded.
    pub fn set_paused(&self, paused: bool) {
        self.progress.paused.store(paused, Ordering::Release);
    }

    pub fn is_paused(&self) -> bool {
        self.progress.is_paused()
    }

    /// Audio time, in ms (excluding pauses).
    pub fn audio_ms(&self) -> i64 {
        self.progress.position_ms()
    }

    /// RMS level of the last recorded segment, from 0 to 1.
    pub fn level(&self) -> f32 {
        self.progress.level()
    }

    /// Whether recording ended on its own (sources ended, error, or the voice note stopped on
    /// silence); the reason is in [`Progress::stop_reason`].
    pub fn is_finished(&self) -> bool {
        self.worker.is_finished()
    }

    /// Stops recording, closes the file and delivers it to the queue as `pending` (with
    /// `details_pending` when config requests title and type on stop):
    /// [`ActiveRecording::close`] followed by [`Closed::deliver`]. Always closes: a recording
    /// thread error or panic is logged and the row gets `interrupted = 1`, the duration
    /// recorded, and Ogg readable through the last written page. Only fails when the queue
    /// fails or the `.part` stays locked after retries; then the row stays `recording` for
    /// [`recover_orphans`].
    pub fn stop(self, queue: &Queue) -> Result<QueuedRecording> {
        self.close()?.deliver(queue)
    }

    /// The slow part of stopping, without the queue: signals, waits for the recording thread
    /// (which releases devices and performs `fsync`) and renames the `.part`. Callers holding
    /// locks release them first.
    pub fn close(self) -> Result<Closed> {
        self.stop.store(true, Ordering::Release);
        let interrupted = match self.worker.join() {
            Ok(Ok(_)) => false,
            Ok(Err(err)) => {
                log::error!("recording {} failed: {err:#}", self.id);
                true
            }
            Err(_) => {
                log::error!("recording thread {} panicked", self.id);
                self.progress.finish(StopReason::Failed);
                true
            }
        };
        rename_retrying(&self.part_path, &self.final_path)?;
        let bytes = i64::try_from(std::fs::metadata(&self.final_path)?.len())?;
        Ok(Closed {
            id: self.id,
            final_path: self.final_path,
            ask_details: self.ask_details,
            duration_ms: self.progress.position_ms(),
            bytes,
            interrupted,
            dropped: self.progress.dropped_samples(),
        })
    }
}

/// A recording already closed on disk, still `recording` in the queue until
/// [`Closed::deliver`].
#[derive(Debug)]
pub struct Closed {
    id: String,
    final_path: PathBuf,
    ask_details: bool,
    duration_ms: i64,
    bytes: i64,
    interrupted: bool,
    /// Samples dropped due to full rings throughout the recording.
    dropped: u64,
}

impl Closed {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Delivers the closed recording to the queue: `pending`, with `interrupted` if recording
    /// failed and `details_pending` when config requests title and type on stop.
    pub fn deliver(self, queue: &Queue) -> Result<QueuedRecording> {
        let Self {
            id,
            final_path,
            ask_details,
            duration_ms,
            bytes,
            interrupted,
            dropped,
        } = self;
        queue.finish(&id, &final_path, now_ms(), duration_ms, bytes)?;
        if interrupted {
            queue.mark_interrupted(&id)?;
        }
        if ask_details {
            queue.set_details_pending(&id)?;
        }
        log::info!(
            "recording {id} closed: {duration_ms} ms, {bytes} bytes, {dropped} samples dropped"
        );
        queue
            .get(&id)?
            .context("a gravação sumiu da fila ao fechar")
    }
}

/// Reads sources until a stop request (or all end, or the voice note detector requests it),
/// mixes and encodes. Returns samples recorded, at 16 kHz.
fn record_loop(
    sources: Vec<Box<dyn AudioSource>>,
    writer: OggOpusWriter<BufWriter<File>>,
    detector: Option<SilenceDetector>,
    stop: &AtomicBool,
    progress: &Progress,
) -> Result<u64> {
    let result = record_until_done(sources, writer, detector, stop, progress);
    progress.finish(if result.is_err() {
        StopReason::Failed
    } else if stop.load(Ordering::Acquire) {
        StopReason::Requested
    } else {
        StopReason::SourcesEnded
    });
    result
}

fn record_until_done(
    mut sources: Vec<Box<dyn AudioSource>>,
    mut writer: OggOpusWriter<BufWriter<File>>,
    mut detector: Option<SilenceDetector>,
    stop: &AtomicBool,
    progress: &Progress,
) -> Result<u64> {
    let rates: Vec<u32> = sources.iter().map(|s| s.sample_rate()).collect();
    let mut mixer = Mixer::new(&rates)?;
    let mut live = vec![true; sources.len()];
    // Drops are logged at most every `DROP_LOG_EVERY`.
    let mut drops_logged = (0u64, Instant::now());

    while !stop.load(Ordering::Acquire) && live.iter().any(|alive| *alive) {
        for (lane, source) in sources.iter_mut().enumerate() {
            if !live[lane] {
                continue;
            }
            match source.read(READ_TIMEOUT) {
                Some(samples) if !samples.is_empty() => {
                    mixer.push(lane, &samples, source.sample_rate())?;
                }
                Some(_) => {}
                None => {
                    log::warn!("recording source {lane} ended");
                    live[lane] = false;
                    mixer.end(lane)?;
                }
            }
        }
        let dropped = progress.track_sources(&sources);
        if dropped > drops_logged.0 && drops_logged.1.elapsed() >= DROP_LOG_EVERY {
            log::warn!("{dropped} samples dropped due to full rings so far");
            drops_logged = (dropped, Instant::now());
        }
        let ready = mixer.pop_ready();
        if progress.is_paused() {
            progress.set_level(0.0);
            continue;
        }
        writer.write(&ready)?;
        let event = detector.as_mut().and_then(|d| d.push(&ready));
        progress.record(&ready, detector.as_ref());
        if let Some(event) = event {
            progress.finish(match event {
                VadEvent::Silence => StopReason::Silence,
                VadEvent::NoSpeech => StopReason::NoSpeech,
            });
            break;
        }
    }

    // Release devices before closing the file.
    drop(sources);
    writer.write(&mixer.drain()?)?;
    let samples = writer.samples();
    let file = writer
        .finish()?
        .into_inner()
        .map_err(|err| anyhow!("falha ao descarregar a gravação: {}", err.error()))?;
    file.sync_all()?;
    Ok(samples)
}

/// App startup: fixes what an unexpected shutdown left behind ([`recover_orphans`], without a
/// live session) and returns unfinished uploads to the queue.
pub fn recover(queue: &Queue) -> Result<Vec<QueuedRecording>> {
    let recovered = recover_orphans(queue, &[])?;
    queue.release_stale_syncing()?;
    queue.release_details_pending()?;
    Ok(recovered)
}

/// Each recording in `recording` whose id is not in `live` (the process's live sessions) has
/// its `.part` renamed to `.ogg` (Ogg is readable through the last written page) and becomes
/// `pending` with `interrupted = 1`. One row at a time: a still-locked `.part` stays as is,
/// logged, for the next scan.
pub fn recover_orphans(queue: &Queue, live: &[&str]) -> Result<Vec<QueuedRecording>> {
    let recovered = queue.recover_interrupted(live, |orphan| {
        let final_path = strip_part(&orphan.path);
        if orphan.path.exists() {
            std::fs::rename(&orphan.path, &final_path)
                .with_context(|| format!("falha ao renomear {}", orphan.path.display()))?;
        }
        let bytes = std::fs::metadata(&final_path).map_or(0, |m| m.len());
        Ok((final_path, i64::try_from(bytes)?))
    })?;
    for rec in &recovered {
        log::warn!("recording {} recovered (interrupted)", rec.id);
    }
    Ok(recovered)
}

/// Renames the `.part`, retrying while the OS refuses (see [`RENAME_ATTEMPTS`]).
fn rename_retrying(from: &Path, to: &Path) -> Result<()> {
    let mut wait = RENAME_WAIT;
    let mut attempt = 1;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) if attempt < RENAME_ATTEMPTS => {
                log::warn!("renaming {} failed ({err}); retrying", from.display());
                std::thread::sleep(wait);
                wait *= 2;
                attempt += 1;
            }
            Err(err) => {
                return Err(err).with_context(|| format!("falha ao renomear {}", from.display()))
            }
        }
    }
}

/// Root mean square, from 0 to 1 for samples in [-1, 1].
fn rms(samples: &[f32]) -> f32 {
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt().min(1.0)
}

fn strip_part(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    PathBuf::from(text.strip_suffix(PART_SUFFIX).unwrap_or(&text))
}

fn new_id(started_at: i64) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    format!("{started_at}-{:04x}", (nanos ^ std::process::id()) & 0xffff)
}

/// Ogg stream serial number, derived from the id (FNV-1a).
fn serial_for(id: &str) -> u32 {
    id.bytes().fold(0x811c_9dc5u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::Status;
    use crate::source::{ScriptedSource, SineSource};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-{name}-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn session_records_two_sources_and_delivers_to_queue() {
        let dir = temp_dir("sessao");
        let queue = Queue::open_in_memory().unwrap();
        let sources: Vec<Box<dyn AudioSource>> = vec![
            Box::new(SineSource::new(
                48_000,
                300.0,
                0.3,
                Duration::from_millis(1_500),
            )),
            Box::new(SineSource::new(
                44_100,
                900.0,
                0.3,
                Duration::from_millis(1_500),
            )),
        ];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            sources,
            StartOptions::MEETING,
        )
        .unwrap();
        assert_eq!(
            queue.get(active.id()).unwrap().unwrap().status,
            Status::Recording
        );

        // Synthetic sources end on their own; recording ends without a stop request.
        while !active.is_finished() {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            active.progress().stop_reason(),
            Some(StopReason::SourcesEnded)
        );
        let rec = active.stop(&queue).unwrap();

        assert_eq!(rec.status, Status::Pending);
        assert_eq!(rec.kind, Kind::Meeting);
        assert!(!rec.interrupted);
        assert_eq!(rec.path.extension().unwrap(), "ogg");
        assert!(rec.path.exists());
        let duration = rec.duration_ms.unwrap();
        assert!((1_450..1_600).contains(&duration), "{duration} ms");
        let bytes = rec.bytes.unwrap();
        assert!(bytes > 1_000 && bytes < 10_000, "{bytes} bytes");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_stops_on_request_with_silent_source() {
        let dir = temp_dir("parada");
        let queue = Queue::open_in_memory().unwrap();
        // A source that never delivers (suspended monitor) does not stall recording.
        let silent = ScriptedSource::new(48_000, std::iter::repeat_n(Some(Vec::new()), 10_000));
        // Test sources are not paced: with 30 s of tone, a fast runner consumed everything
        // before `stop`, resulting in `SourcesEnded`. An hour does not end within 100 ms.
        let sources: Vec<Box<dyn AudioSource>> = vec![
            Box::new(SineSource::new(
                16_000,
                440.0,
                0.3,
                Duration::from_secs(3600),
            )),
            Box::new(silent),
        ];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            sources,
            StartOptions::MEETING,
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let position = active.progress().position_ms();
        assert!(position > 0, "position {position} ms");
        let progress = Arc::clone(&active.progress);
        let rec = active.stop(&queue).unwrap();
        assert_eq!(progress.stop_reason(), Some(StopReason::Requested));
        assert_eq!(rec.status, Status::Pending);
        assert!(rec.duration_ms.unwrap() > 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Pushes 10 ms of tone into the ring every 10 ms, until `until` (or `stop`), and closes
    /// it.
    fn feed(
        mut writer: eclume_audio_capture::ring::RingWriter,
        until: Duration,
        stop: Arc<AtomicBool>,
    ) {
        std::thread::spawn(move || {
            let started = Instant::now();
            while started.elapsed() < until && !stop.load(Ordering::Acquire) {
                writer.push_interleaved(160, 1, |i| (i as f32 * 0.1).sin() * 0.3);
                std::thread::sleep(Duration::from_millis(10));
            }
            writer.close();
        });
    }

    #[test]
    fn session_reconnects_dropped_microphone_without_ending_lane() {
        use eclume_audio_capture::reconnect::{Opener, Reconnecting};
        use eclume_audio_capture::ring;

        let dir = temp_dir("reconecta");
        let queue = Queue::open_in_memory().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        // The microphone plays for 1 s, drops, and the device only returns 1.2 s after the
        // drop.
        let (writer, first) = ring::channel(1 << 14, 16_000);
        feed(writer, Duration::from_secs(1), Arc::clone(&stop));
        let opened = Instant::now();
        let mut first = Some(first);
        let feeder_stop = Arc::clone(&stop);
        let opener: Opener = Box::new(move || {
            if let Some(first) = first.take() {
                return Ok(first);
            }
            if opened.elapsed() < Duration::from_millis(2_200) {
                return Err(anyhow!("microfone fora"));
            }
            let (writer, again) = ring::channel(1 << 14, 16_000);
            feed(writer, Duration::from_secs(60), Arc::clone(&feeder_stop));
            Ok(again)
        });
        let mic = Reconnecting::open(opener).unwrap();
        let sources: Vec<Box<dyn AudioSource>> = vec![
            Box::new(SineSource::new(48_000, 300.0, 0.3, Duration::from_secs(60))),
            Box::new(mic),
        ];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            sources,
            StartOptions::MEETING,
        )
        .unwrap();
        let started = Instant::now();

        let mut saw_reconnecting = false;
        while started.elapsed() < Duration::from_millis(4_000) {
            let states = active.progress().source_states();
            if let [SourceState::Live, SourceState::Reconnecting { .. }] = states.as_slice() {
                saw_reconnecting = true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            saw_reconnecting,
            "the microphone lane did not go through reconnection"
        );
        assert_eq!(
            active.progress().source_states(),
            vec![SourceState::Live, SourceState::Live]
        );
        assert!(!active.is_finished());
        let elapsed_ms = i64::try_from(started.elapsed().as_millis()).unwrap();
        let rec = active.stop(&queue).unwrap();
        stop.store(true, Ordering::Release);
        // The gap without a microphone became silence: duration follows the clock.
        let duration = rec.duration_ms.unwrap();
        assert!(
            duration > elapsed_ms * 8 / 10 && duration < elapsed_ms * 12 / 10,
            "{duration} ms recorded in {elapsed_ms} ms"
        );
        assert!(!rec.interrupted);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A source delivering in real time, like a microphone: 10 ms per read.
    struct Paced(SineSource);

    impl AudioSource for Paced {
        fn sample_rate(&self) -> u32 {
            self.0.sample_rate()
        }

        fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
            std::thread::sleep(Duration::from_millis(10));
            self.0.read(timeout)
        }
    }

    #[test]
    fn session_pause_discards_samples_and_counts_only_audio_time() {
        let dir = temp_dir("pausa");
        let queue = Queue::open_in_memory().unwrap();
        let sources: Vec<Box<dyn AudioSource>> = vec![Box::new(Paced(SineSource::new(
            16_000,
            440.0,
            0.5,
            Duration::from_secs(30),
        )))];
        let config = RecorderConfig {
            source: Source::Mobile,
            ask_details: true,
            ..RecorderConfig::new(&dir)
        };
        let active = start(&config, &queue, sources, StartOptions::MEETING).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        // A sine wave with amplitude 0.5 has RMS 0.5/√2.
        let level = active.level();
        assert!((0.3..0.4).contains(&level), "level {level}");

        active.set_paused(true);
        assert!(active.is_paused());
        std::thread::sleep(Duration::from_millis(30));
        let paused_at = active.audio_ms();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(active.audio_ms(), paused_at);
        assert_eq!(active.level(), 0.0);

        active.set_paused(false);
        std::thread::sleep(Duration::from_millis(150));
        assert!(active.audio_ms() > paused_at);
        let audio_ms = active.audio_ms();
        let rec = active.stop(&queue).unwrap();
        // Duration is audio time, excluding the pause.
        let duration = rec.duration_ms.unwrap();
        assert!(
            duration >= audio_ms && duration < audio_ms + 200,
            "{duration} ms"
        );
        assert_eq!(rec.source, Source::Mobile);
        assert!(rec.details_pending);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_recovers_orphaned_part() {
        let dir = temp_dir("recuperacao");
        let queue = Queue::open_in_memory().unwrap();
        let part = dir.join("orfa.ogg.part");
        std::fs::write(&part, b"OggS parcial").unwrap();
        queue.begin("orfa", &part, 1).unwrap();

        let recovered = recover(&queue).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].path, dir.join("orfa.ogg"));
        assert!(recovered[0].interrupted);
        assert_eq!(recovered[0].bytes, Some(12));
        assert!(dir.join("orfa.ogg").exists());
        assert!(!part.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_recovers_others_when_one_destination_is_locked() {
        let dir = temp_dir("recuperacao-bloqueada");
        let queue = Queue::open_in_memory().unwrap();
        for id in ["presa", "livre"] {
            let part = dir.join(format!("{id}.ogg.part"));
            std::fs::write(&part, b"OggS").unwrap();
            queue.begin(id, &part, 1).unwrap();
        }
        // `rename(file, directory)` fails: simulates the locked `.part`.
        std::fs::create_dir(dir.join("presa.ogg")).unwrap();

        let recovered = recover(&queue).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, "livre");
        let locked = queue.get("presa").unwrap().unwrap();
        assert_eq!(locked.status, Status::Recording);
        assert!(dir.join("presa.ogg.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_recovers_orphans_without_touching_live_recording() {
        let dir = temp_dir("recuperacao-viva");
        let queue = Queue::open_in_memory().unwrap();
        for id in ["viva", "orfa"] {
            let part = dir.join(format!("{id}.ogg.part"));
            std::fs::write(&part, b"OggS").unwrap();
            queue.begin(id, &part, 1).unwrap();
        }

        let recovered = recover_orphans(&queue, &["viva"]).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, "orfa");
        let live = queue.get("viva").unwrap().unwrap();
        assert_eq!(live.status, Status::Recording);
        assert!(dir.join("viva.ogg.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A source that panics after a few reads.
    struct Panicking(SineSource, u32);

    impl AudioSource for Panicking {
        fn sample_rate(&self) -> u32 {
            self.0.sample_rate()
        }

        fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
            assert!(self.1 > 0, "broken source");
            self.1 -= 1;
            self.0.read(timeout)
        }
    }

    #[test]
    fn session_closes_as_interrupted_when_source_panics() {
        let dir = temp_dir("panico");
        let queue = Queue::open_in_memory().unwrap();
        let sine = SineSource::new(16_000, 440.0, 0.3, Duration::from_secs(30));
        let sources: Vec<Box<dyn AudioSource>> = vec![Box::new(Panicking(sine, 20))];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            sources,
            StartOptions::MEETING,
        )
        .unwrap();
        while !active.is_finished() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(active.progress().stop_reason(), None);

        let rec = active.stop(&queue).unwrap();
        assert_eq!(rec.status, Status::Pending);
        assert!(rec.interrupted);
        assert!(rec.path.exists());
        assert!(rec.duration_ms.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_stop_with_locked_part_leaves_row_for_scan() {
        let dir = temp_dir("parada-presa");
        let queue = Queue::open_in_memory().unwrap();
        let sources: Vec<Box<dyn AudioSource>> = vec![Box::new(SineSource::new(
            16_000,
            440.0,
            0.3,
            Duration::from_secs(30),
        ))];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            sources,
            StartOptions::MEETING,
        )
        .unwrap();
        let id = active.id().to_string();
        std::fs::create_dir(dir.join(format!("{id}.ogg"))).unwrap();

        assert!(active.stop(&queue).is_err());
        let row = queue.get(&id).unwrap().unwrap();
        assert_eq!(row.status, Status::Recording);
        assert!(dir.join(format!("{id}.ogg.part")).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_refuses_recording_without_sources() {
        let queue = Queue::open_in_memory().unwrap();
        assert!(start(
            &RecorderConfig::new(temp_dir("vazia")),
            &queue,
            Vec::new(),
            StartOptions::MEETING
        )
        .is_err());
    }

    /// Speech (bursts of tone) for `speech_ms`, then digital silence until `total_ms`.
    fn voice_then_silence(speech_ms: u64, total_ms: u64) -> ScriptedSource {
        let chunk_ms = 10;
        let chunks = (0..total_ms / chunk_ms).map(move |i| {
            let t = i * chunk_ms;
            let samples = (0..160)
                .map(|n| {
                    if t < speech_ms && t % 300 < 200 {
                        0.3 * (2.0 * std::f32::consts::PI * 220.0 * (t * 16 + n) as f32 / 16_000.0)
                            .sin()
                    } else {
                        0.0
                    }
                })
                .collect::<Vec<f32>>();
            Some(samples)
        });
        ScriptedSource::new(16_000, chunks)
    }

    fn wait_finished(active: &ActiveRecording) {
        for _ in 0..2_000 {
            if active.is_finished() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("recording did not finish on its own");
    }

    #[test]
    fn voice_note_stops_on_silence_with_meter_and_position() {
        let dir = temp_dir("nota-silencio");
        let queue = Queue::open_in_memory().unwrap();
        let source: Vec<Box<dyn AudioSource>> = vec![Box::new(voice_then_silence(1_000, 60_000))];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            source,
            StartOptions::note(Some(Duration::from_secs(2))),
        )
        .unwrap();
        assert_eq!(queue.get(active.id()).unwrap().unwrap().kind, Kind::Note);
        wait_finished(&active);

        let progress = active.progress();
        assert_eq!(progress.stop_reason(), Some(StopReason::Silence));
        // Speech until 1 s (last burst until 0.9 s), then 2 s of silence since it.
        let position = progress.position_ms();
        assert!(
            (2_800..=3_100).contains(&position),
            "stopped at {position} ms"
        );
        assert_eq!(progress.stops_in_ms(), None);
        let rec = active.stop(&queue).unwrap();
        assert_eq!(rec.kind, Kind::Note);
        let duration = rec.duration_ms.unwrap();
        assert!((2_700..=3_200).contains(&duration), "{duration} ms");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_note_without_voice_stops_due_to_no_speech() {
        let dir = temp_dir("nota-muda");
        let queue = Queue::open_in_memory().unwrap();
        let source: Vec<Box<dyn AudioSource>> = vec![Box::new(voice_then_silence(0, 60_000))];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            source,
            StartOptions::note(Some(Duration::from_secs(4))),
        )
        .unwrap();
        wait_finished(&active);
        assert_eq!(active.progress().stop_reason(), Some(StopReason::NoSpeech));
        assert!(active.progress().meter().iter().all(|bar| *bar == 0.0));
        active.stop(&queue).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_note_shows_level_and_remaining_time_while_recording() {
        let dir = temp_dir("nota-medidor");
        let queue = Queue::open_in_memory().unwrap();
        let source: Vec<Box<dyn AudioSource>> = vec![Box::new(voice_then_silence(1_500, 1_500))];
        // "Never": the source ends first, and the loop ends because of the sources.
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            source,
            StartOptions::note(None),
        )
        .unwrap();
        wait_finished(&active);
        assert_eq!(
            active.progress().stop_reason(),
            Some(StopReason::SourcesEnded)
        );
        assert_eq!(active.progress().stops_in_ms(), None);
        assert!(active.progress().meter().iter().any(|bar| *bar > 0.5));
        active.stop(&queue).unwrap();

        let source: Vec<Box<dyn AudioSource>> = vec![Box::new(voice_then_silence(600, 2_000))];
        let active = start(
            &RecorderConfig::new(&dir),
            &queue,
            source,
            StartOptions::note(Some(Duration::from_secs(8))),
        )
        .unwrap();
        wait_finished(&active);
        // Speech ends at 0.5 s and the source at 2 s: about 6.5 s remained.
        let left = active.progress().stops_in_ms().unwrap();
        assert!((6_300..=6_700).contains(&left), "{left} ms remained");
        active.stop(&queue).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
