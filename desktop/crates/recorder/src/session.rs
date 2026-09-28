//! Uma sessão de gravação: fontes → mixer → Ogg/Opus em disco → fila.
//!
//! O arquivo nasce como `<id>.ogg.part` e só vira `<id>.ogg` ao parar. A linha da fila nasce em
//! `recording` e passa a `pending` no mesmo momento. Se o processo morrer no meio,
//! [`recover`] acerta arquivo e linha na abertura seguinte.
//!
//! Uma sessão pausada continua lendo as fontes e descarta as amostras: o dispositivo segue aberto
//! (reabri-lo em segundo plano esbarraria nas restrições do celular), e o tempo de áudio
//! ([`Progress::position_ms`]) só anda gravando.
//!
//! Uma nota por voz passa as amostras mixadas pelo [`SilenceDetector`]: o laço encerra sozinho no
//! silêncio configurado, ou quando não houve voz, e o [`Progress`] conta por quê.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::encode::{OggOpusWriter, DEFAULT_BITRATE};
use crate::mix::{Mixer, TARGET_RATE};
use crate::queue::{now_ms, Kind, Queue, QueuedRecording, Source};
use crate::vad::{SilenceDetector, VadEvent, METER_BARS};
use crate::AudioSource;

/// Quanto cada leitura de fonte espera, no máximo, por amostras.
const READ_TIMEOUT: Duration = Duration::from_millis(10);
const PART_SUFFIX: &str = ".part";

/// Onde e como gravar.
#[derive(Clone, Debug)]
pub struct RecorderConfig {
    /// Diretório das gravações.
    pub dir: PathBuf,
    /// Taxa de bits do Opus, em bits/s.
    pub bitrate: i32,
    /// A origem gravada na fila (`desktop` ou `mobile`).
    pub source: Source,
    /// Ao parar, a gravação espera título e tipo de agenda antes de subir (`details_pending`).
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

/// O que gravar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartOptions {
    pub kind: Kind,
    /// Numa nota, o silêncio que a encerra; `None` ("Nunca") não para sozinha. Ignorado numa
    /// reunião.
    pub stop_after_silence: Option<Duration>,
}

impl StartOptions {
    /// Uma reunião ou gravação manual: para só a pedido ou quando as fontes caem.
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

/// Por que o laço de gravação terminou.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// Pedido de parada (botão, atalho, bandeja, fim da reunião).
    Requested,
    /// Todas as fontes acabaram, ou houve erro.
    SourcesEnded,
    /// Nota: houve voz e depois o silêncio configurado.
    Silence,
    /// Nota: nenhuma voz nos primeiros segundos.
    NoSpeech,
}

impl StopReason {
    const ALL: [Self; 4] = [
        Self::Requested,
        Self::SourcesEnded,
        Self::Silence,
        Self::NoSpeech,
    ];
}

/// O andamento de uma gravação, compartilhado com a thread que grava.
#[derive(Debug)]
pub struct Progress {
    /// Amostras gravadas, a 16 kHz.
    samples: AtomicU64,
    /// 0 enquanto grava; depois, 1 + o índice em [`StopReason::ALL`].
    reason: AtomicU8,
    /// Quanto falta de silêncio para a nota parar; `u64::MAX` quando não conta.
    stops_in_ms: AtomicU64,
    meter: Mutex<[f32; METER_BARS]>,
    paused: AtomicBool,
    /// O nível RMS do último trecho mixado, em bits de `f32`.
    level: AtomicU32,
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
        }
    }
}

impl Progress {
    /// O tempo de áudio, em ms: o gravado, sem as pausas. É a base dos marcadores e não se
    /// desalinha com um vazio de fonte como o relógio se desalinharia.
    pub fn position_ms(&self) -> i64 {
        let samples = self.samples.load(Ordering::Acquire);
        i64::try_from(samples * 1_000 / u64::from(TARGET_RATE)).unwrap_or(i64::MAX)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    /// O nível RMS do último trecho gravado, de 0 a 1; 0 pausado.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Acquire))
    }

    /// Os últimos níveis da nota, de 0 a 1 (vazio numa reunião).
    pub fn meter(&self) -> [f32; METER_BARS] {
        self.meter.lock().map_or([0.0; METER_BARS], |meter| *meter)
    }

    /// Quanto falta de silêncio para a nota parar, enquanto a pessoa está calada.
    pub fn stops_in_ms(&self) -> Option<u64> {
        match self.stops_in_ms.load(Ordering::Acquire) {
            u64::MAX => None,
            ms => Some(ms),
        }
    }

    /// Por que a gravação terminou; `None` enquanto grava.
    pub fn stop_reason(&self) -> Option<StopReason> {
        match self.reason.load(Ordering::Acquire) {
            0 => None,
            n => StopReason::ALL.get(usize::from(n - 1)).copied(),
        }
    }

    /// Guarda o primeiro motivo; os seguintes não o trocam.
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

/// Uma gravação em andamento.
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

/// Começa a gravar as fontes dadas (mic e sistema numa reunião, só o mic numa nota) e registra a
/// gravação na fila.
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
        "gravação {id} ({}) iniciada em {}",
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

    /// Início, em milissegundos desde a época Unix.
    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    pub fn progress(&self) -> &Progress {
        &self.progress
    }

    /// Pausa (ou retoma) sem fechar as fontes: pausada, as amostras lidas são descartadas.
    pub fn set_paused(&self, paused: bool) {
        self.progress.paused.store(paused, Ordering::Release);
    }

    pub fn is_paused(&self) -> bool {
        self.progress.is_paused()
    }

    /// O tempo de áudio, em ms (sem as pausas).
    pub fn audio_ms(&self) -> i64 {
        self.progress.position_ms()
    }

    /// O nível RMS do último trecho gravado, de 0 a 1.
    pub fn level(&self) -> f32 {
        self.progress.level()
    }

    /// Se a gravação terminou sozinha (fontes acabaram, erro, ou a nota parou no silêncio); o
    /// motivo está em [`Progress::stop_reason`].
    pub fn is_finished(&self) -> bool {
        self.worker.is_finished()
    }

    /// Para a gravação, fecha o arquivo e o entrega à fila como `pending` (com `details_pending`
    /// quando a config pede título e tipo ao parar).
    pub fn stop(self, queue: &Queue) -> Result<QueuedRecording> {
        self.stop.store(true, Ordering::Release);
        let samples = self
            .worker
            .join()
            .map_err(|_| anyhow!("a thread de gravação entrou em pânico"))??;

        std::fs::rename(&self.part_path, &self.final_path)
            .with_context(|| format!("falha ao renomear {}", self.part_path.display()))?;
        let bytes = std::fs::metadata(&self.final_path)?.len();
        let duration_ms = i64::try_from(samples * 1_000 / u64::from(TARGET_RATE))?;
        queue.finish(
            &self.id,
            &self.final_path,
            now_ms(),
            duration_ms,
            i64::try_from(bytes)?,
        )?;
        if self.ask_details {
            queue.set_details_pending(&self.id)?;
        }
        log::info!(
            "gravação {} fechada: {duration_ms} ms, {bytes} bytes",
            self.id
        );
        queue
            .get(&self.id)?
            .context("a gravação sumiu da fila ao fechar")
    }
}

/// Lê as fontes até o pedido de parada (ou até todas acabarem, ou até o detector da nota pedir),
/// mixa e codifica. Devolve as amostras gravadas, a 16 kHz.
fn record_loop(
    sources: Vec<Box<dyn AudioSource>>,
    writer: OggOpusWriter<BufWriter<File>>,
    detector: Option<SilenceDetector>,
    stop: &AtomicBool,
    progress: &Progress,
) -> Result<u64> {
    let result = record_until_done(sources, writer, detector, stop, progress);
    progress.finish(if stop.load(Ordering::Acquire) {
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
                    log::warn!("fonte {lane} da gravação terminou");
                    live[lane] = false;
                    mixer.end(lane)?;
                }
            }
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

    // Solta os dispositivos antes de fechar o arquivo.
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

/// Acerta o que um encerramento inesperado deixou para trás: cada gravação ainda em `recording`
/// tem o `.part` renomeado para `.ogg` (o Ogg é legível até a última página escrita) e vira
/// `pending` com `interrupted = 1`. Também devolve à fila os uploads que ficaram pela metade.
pub fn recover(queue: &Queue) -> Result<Vec<QueuedRecording>> {
    let recovered = queue.recover_interrupted(|orphan| {
        let final_path = strip_part(&orphan.path);
        if orphan.path.exists() {
            std::fs::rename(&orphan.path, &final_path)
                .with_context(|| format!("falha ao renomear {}", orphan.path.display()))?;
        }
        let bytes = std::fs::metadata(&final_path).map_or(0, |m| m.len());
        Ok((final_path, i64::try_from(bytes)?))
    })?;
    queue.release_stale_syncing()?;
    queue.release_details_pending()?;
    for rec in &recovered {
        log::warn!(
            "gravação {} recuperada após encerramento inesperado",
            rec.id
        );
    }
    Ok(recovered)
}

/// A raiz da média dos quadrados, de 0 a 1 para amostras em [-1, 1].
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

/// Número de série do stream Ogg, derivado do id (FNV-1a).
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
    fn session_grava_duas_fontes_e_entrega_a_fila() {
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

        // As fontes sintéticas acabam sozinhas; a gravação termina sem pedido de parada.
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
    fn session_para_a_pedido_com_fonte_silenciosa() {
        let dir = temp_dir("parada");
        let queue = Queue::open_in_memory().unwrap();
        // Uma fonte que nunca entrega (monitor suspenso) não trava a gravação.
        let silent = ScriptedSource::new(48_000, std::iter::repeat_n(Some(Vec::new()), 10_000));
        let sources: Vec<Box<dyn AudioSource>> = vec![
            Box::new(SineSource::new(16_000, 440.0, 0.3, Duration::from_secs(30))),
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
        assert!(position > 0, "posição {position} ms");
        let progress = Arc::clone(&active.progress);
        let rec = active.stop(&queue).unwrap();
        assert_eq!(progress.stop_reason(), Some(StopReason::Requested));
        assert_eq!(rec.status, Status::Pending);
        assert!(rec.duration_ms.unwrap() > 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Uma fonte que entrega em tempo real, como um microfone: 10 ms por leitura.
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
    fn session_pausa_descarta_amostras_e_conta_so_o_tempo_de_audio() {
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
        // Um seno de amplitude 0,5 tem RMS de 0,5/√2.
        let level = active.level();
        assert!((0.3..0.4).contains(&level), "nível {level}");

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
        // A duração é o tempo de áudio, sem a pausa.
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
    fn session_recupera_part_orfao() {
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
    fn session_recusa_gravar_sem_fontes() {
        let queue = Queue::open_in_memory().unwrap();
        assert!(start(
            &RecorderConfig::new(temp_dir("vazia")),
            &queue,
            Vec::new(),
            StartOptions::MEETING
        )
        .is_err());
    }

    /// Fala (tom em rajadas) por `speech_ms` e depois silêncio digital até `total_ms`.
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
        panic!("a gravação não terminou sozinha");
    }

    #[test]
    fn nota_para_sozinha_no_silencio_com_medidor_e_posicao() {
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
        // Fala até 1 s (última rajada até 0,9 s) e 2 s de silêncio desde ela.
        let position = progress.position_ms();
        assert!(
            (2_800..=3_100).contains(&position),
            "parou em {position} ms"
        );
        assert_eq!(progress.stops_in_ms(), None);
        let rec = active.stop(&queue).unwrap();
        assert_eq!(rec.kind, Kind::Note);
        let duration = rec.duration_ms.unwrap();
        assert!((2_700..=3_200).contains(&duration), "{duration} ms");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nota_sem_voz_para_por_falta_de_fala() {
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
    fn nota_mostra_o_nivel_e_quanto_falta_enquanto_grava() {
        let dir = temp_dir("nota-medidor");
        let queue = Queue::open_in_memory().unwrap();
        let source: Vec<Box<dyn AudioSource>> = vec![Box::new(voice_then_silence(1_500, 1_500))];
        // "Nunca": a fonte acaba antes, e o laço termina pelas fontes.
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
        // A fala acaba em 0,5 s e a fonte em 2 s: faltavam uns 6,5 s.
        let left = active.progress().stops_in_ms().unwrap();
        assert!((6_300..=6_700).contains(&left), "faltavam {left} ms");
        active.stop(&queue).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
