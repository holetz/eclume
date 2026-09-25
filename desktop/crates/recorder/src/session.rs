//! Uma sessão de gravação: fontes → mixer → Ogg/Opus em disco → fila.
//!
//! O arquivo nasce como `<id>.ogg.part` e só vira `<id>.ogg` ao parar. A linha da fila nasce em
//! `recording` e passa a `pending` no mesmo momento. Se o processo morrer no meio,
//! [`recover`] acerta arquivo e linha na abertura seguinte.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use crate::encode::{OggOpusWriter, DEFAULT_BITRATE};
use crate::mix::{Mixer, TARGET_RATE};
use crate::queue::{now_ms, Queue, QueuedRecording};
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
}

impl RecorderConfig {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            bitrate: DEFAULT_BITRATE,
        }
    }
}

/// Uma gravação em andamento.
pub struct ActiveRecording {
    id: String,
    part_path: PathBuf,
    final_path: PathBuf,
    started_at: i64,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<Result<u64>>,
}

/// Começa a gravar as fontes dadas (tipicamente mic e sistema) e registra a gravação na fila.
pub fn start(
    config: &RecorderConfig,
    queue: &Queue,
    sources: Vec<Box<dyn AudioSource>>,
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

    let stop = Arc::new(AtomicBool::new(false));
    let worker = {
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("eclume-gravacao".into())
            .spawn(move || record_loop(sources, writer, &stop))
            .context("falha ao criar a thread de gravação")?
    };
    log::info!("gravação {id} iniciada em {}", part_path.display());

    Ok(ActiveRecording {
        id,
        part_path,
        final_path,
        started_at,
        stop,
        worker,
    })
}

impl ActiveRecording {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Início, em milissegundos desde a época Unix.
    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    /// Se a gravação terminou sozinha (todas as fontes acabaram, ou houve erro).
    pub fn is_finished(&self) -> bool {
        self.worker.is_finished()
    }

    /// Para a gravação, fecha o arquivo e o entrega à fila como `pending`.
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
        log::info!(
            "gravação {} fechada: {duration_ms} ms, {bytes} bytes",
            self.id
        );
        queue
            .get(&self.id)?
            .context("a gravação sumiu da fila ao fechar")
    }
}

/// Lê as fontes até o pedido de parada (ou até todas acabarem), mixa e codifica. Devolve as
/// amostras gravadas, a 16 kHz.
fn record_loop(
    mut sources: Vec<Box<dyn AudioSource>>,
    mut writer: OggOpusWriter<BufWriter<File>>,
    stop: &AtomicBool,
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
        writer.write(&mixer.pop_ready())?;
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
    for rec in &recovered {
        log::warn!(
            "gravação {} recuperada após encerramento inesperado",
            rec.id
        );
    }
    Ok(recovered)
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
        let active = start(&RecorderConfig::new(&dir), &queue, sources).unwrap();
        assert_eq!(
            queue.get(active.id()).unwrap().unwrap().status,
            Status::Recording
        );

        // As fontes sintéticas acabam sozinhas; a gravação termina sem pedido de parada.
        while !active.is_finished() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let rec = active.stop(&queue).unwrap();

        assert_eq!(rec.status, Status::Pending);
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
        let active = start(&RecorderConfig::new(&dir), &queue, sources).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let rec = active.stop(&queue).unwrap();
        assert_eq!(rec.status, Status::Pending);
        assert!(rec.duration_ms.unwrap() > 0);
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
        assert!(start(&RecorderConfig::new(temp_dir("vazia")), &queue, Vec::new()).is_err());
    }
}
