//! Anel de amostras entre o callback de áudio (produtor, tempo real) e o gravador (consumidor).
//!
//! Ideia adaptada de fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:crates/audio-actual/src/rt_ring.rs
//! (MIT; ver VENDOR.md), reescrita sem wakers assíncronos: o consumidor lê com prazo.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::AudioSource;

/// Capacidade padrão: ~2,7 s a 48 kHz, folga para o gravador atrasar sem perder amostras.
pub const DEFAULT_CAPACITY: usize = 1 << 17;

const POLL_INTERVAL: Duration = Duration::from_millis(5);

struct Shared {
    alive: AtomicBool,
    sample_rate: AtomicU32,
    dropped: AtomicUsize,
}

/// Cria um anel ligado: o [`RingWriter`] vai para o callback, o [`RingSource`] para o gravador.
pub fn channel(capacity: usize, sample_rate: u32) -> (RingWriter, RingSource) {
    let (producer, consumer) = HeapRb::<f32>::new(capacity).split();
    let shared = Arc::new(Shared {
        alive: AtomicBool::new(true),
        sample_rate: AtomicU32::new(sample_rate),
        dropped: AtomicUsize::new(0),
    });
    (
        RingWriter {
            producer,
            shared: Arc::clone(&shared),
        },
        RingSource {
            consumer,
            shared,
            stop: None,
        },
    )
}

/// Lado do produtor. Não aloca: pode ser usado no callback de tempo real.
pub struct RingWriter {
    producer: HeapProd<f32>,
    shared: Arc<Shared>,
}

impl RingWriter {
    /// Empilha `frames` quadros intercalados de `channels` canais, com downmix por média.
    /// `sample(i)` devolve a amostra de índice intercalado `i`, já em `f32`.
    pub fn push_interleaved(
        &mut self,
        frames: usize,
        channels: usize,
        mut sample: impl FnMut(usize) -> f32,
    ) {
        if channels == 0 {
            return;
        }
        let mut dropped = 0usize;
        for frame in 0..frames {
            let base = frame * channels;
            let mut sum = 0.0f32;
            for channel in 0..channels {
                sum += sample(base + channel);
            }
            if self.producer.try_push(sum / channels as f32).is_err() {
                dropped += 1;
            }
        }
        if dropped > 0 {
            self.shared.dropped.fetch_add(dropped, Ordering::Relaxed);
        }
    }

    /// Empilha bytes `f32` little-endian intercalados.
    pub fn push_f32le_bytes(&mut self, bytes: &[u8], channels: usize) {
        if channels == 0 {
            return;
        }
        let frames = bytes.len() / (channels * 4);
        self.push_interleaved(frames, channels, |i| {
            let at = i * 4;
            f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        });
    }

    pub fn set_sample_rate(&self, rate: u32) {
        if rate > 0 {
            self.shared.sample_rate.store(rate, Ordering::Release);
        }
    }

    /// Marca a fonte como encerrada; o consumidor recebe `None` depois de esvaziar o anel.
    pub fn close(&self) {
        self.shared.alive.store(false, Ordering::Release);
    }

    /// Um marcador que só sabe encerrar a fonte, para callbacks de erro separados do produtor.
    pub fn closer(&self) -> RingCloser {
        RingCloser(Arc::clone(&self.shared))
    }
}

/// Encerra a fonte a partir de outro contexto (callback de erro, thread de controle).
#[derive(Clone)]
pub struct RingCloser(Arc<Shared>);

impl RingCloser {
    pub fn close(&self) {
        self.0.alive.store(false, Ordering::Release);
    }
}

/// Lado do consumidor. Ao ser descartado, executa o `stop` registrado, que desliga o backend.
pub struct RingSource {
    consumer: HeapCons<f32>,
    shared: Arc<Shared>,
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl RingSource {
    /// Registra o que desliga o backend (sinal para a thread de captura, join etc.).
    pub fn on_stop(mut self, stop: impl FnOnce() + Send + 'static) -> Self {
        self.stop = Some(Box::new(stop));
        self
    }

    /// Amostras descartadas por anel cheio desde o início.
    pub fn dropped_samples(&self) -> usize {
        self.shared.dropped.load(Ordering::Relaxed)
    }
}

impl AudioSource for RingSource {
    fn sample_rate(&self) -> u32 {
        self.shared.sample_rate.load(Ordering::Acquire)
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        let deadline = Instant::now() + timeout;
        loop {
            let available = self.consumer.occupied_len();
            if available > 0 {
                let mut out = vec![0.0f32; available];
                let popped = self.consumer.pop_slice(&mut out);
                out.truncate(popped);
                return Some(out);
            }
            if !self.shared.alive.load(Ordering::Acquire) {
                return None;
            }
            let now = Instant::now();
            if now >= deadline {
                return Some(Vec::new());
            }
            std::thread::sleep(POLL_INTERVAL.min(deadline - now));
        }
    }
}

impl Drop for RingSource {
    fn drop(&mut self) {
        self.shared.alive.store(false, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_por_media_dos_canais() {
        let (mut writer, mut source) = channel(16, 48_000);
        writer.push_interleaved(2, 2, |i| [1.0, 0.0, -0.5, -0.5][i]);
        assert_eq!(source.read(Duration::ZERO), Some(vec![0.5, -0.5]));
    }

    #[test]
    fn bytes_f32le_intercalados() {
        let (mut writer, mut source) = channel(16, 48_000);
        let bytes: Vec<u8> = [0.25f32, 0.75, 1.0, 0.0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        writer.push_f32le_bytes(&bytes, 2);
        assert_eq!(source.read(Duration::ZERO), Some(vec![0.5, 0.5]));
    }

    #[test]
    fn prazo_vencido_devolve_vazio_e_fonte_encerrada_devolve_none() {
        let (writer, mut source) = channel(16, 16_000);
        assert_eq!(source.read(Duration::from_millis(10)), Some(Vec::new()));
        writer.close();
        assert_eq!(source.read(Duration::from_millis(10)), None);
    }

    #[test]
    fn anel_cheio_conta_descartes_e_taxa_muda() {
        let (mut writer, source) = channel(4, 44_100);
        writer.push_interleaved(6, 1, |_| 0.1);
        assert_eq!(source.dropped_samples(), 2);
        writer.set_sample_rate(48_000);
        assert_eq!(source.sample_rate(), 48_000);
    }

    #[test]
    fn descartar_a_fonte_executa_o_stop() {
        let flag = Arc::new(AtomicBool::new(false));
        let (_writer, source) = channel(4, 16_000);
        let seen = Arc::clone(&flag);
        drop(source.on_stop(move || seen.store(true, Ordering::Release)));
        assert!(flag.load(Ordering::Acquire));
    }
}
