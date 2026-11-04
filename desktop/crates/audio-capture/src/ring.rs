//! Sample ring buffer between the audio callback (producer, real time) and the recorder (consumer).
//!
//! Idea adapted from fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:
//! crates/audio-actual/src/rt_ring.rs
//! (MIT; see VENDOR.md), rewritten without async wakers: the consumer reads with a timeout.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::AudioSource;

/// Default capacity: ~2.7 s at 48 kHz, allowing the recorder to lag without losing samples.
pub const DEFAULT_CAPACITY: usize = 1 << 17;

const POLL_INTERVAL: Duration = Duration::from_millis(5);

struct Shared {
    alive: AtomicBool,
    sample_rate: AtomicU32,
    dropped: AtomicUsize,
}

/// Creates a connected ring: [`RingWriter`] goes to the callback, [`RingSource`] to the recorder.
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

/// Producer side. Does not allocate: safe to use in the real-time callback.
pub struct RingWriter {
    producer: HeapProd<f32>,
    shared: Arc<Shared>,
}

impl RingWriter {
    /// Pushes `frames` interleaved frames of `channels` channels, downmixing by averaging.
    /// `sample(i)` returns the sample at interleaved index `i`, already in `f32`.
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

    /// Pushes interleaved little-endian `f32` bytes.
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

    /// Marks the source as closed; the consumer receives `None` after draining the ring.
    pub fn close(&self) {
        self.shared.alive.store(false, Ordering::Release);
    }

    /// A handle that can only close the source, for error callbacks separate from the producer.
    pub fn closer(&self) -> RingCloser {
        RingCloser(Arc::clone(&self.shared))
    }
}

/// Closes the source from another context (error callback, control thread).
#[derive(Clone)]
pub struct RingCloser(Arc<Shared>);

impl RingCloser {
    pub fn close(&self) {
        self.0.alive.store(false, Ordering::Release);
    }
}

/// Consumer side. On drop, runs the registered `stop`, which shuts down the backend.
pub struct RingSource {
    consumer: HeapCons<f32>,
    shared: Arc<Shared>,
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl RingSource {
    /// Registers what shuts down the backend (capture thread signal, join, etc.).
    pub fn on_stop(mut self, stop: impl FnOnce() + Send + 'static) -> Self {
        self.stop = Some(Box::new(stop));
        self
    }
}

impl AudioSource for RingSource {
    fn sample_rate(&self) -> u32 {
        self.shared.sample_rate.load(Ordering::Acquire)
    }

    /// Samples dropped because the ring buffer was full since startup.
    fn dropped_samples(&self) -> u64 {
        self.shared.dropped.load(Ordering::Relaxed) as u64
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
    fn downmix_averages_channels() {
        let (mut writer, mut source) = channel(16, 48_000);
        writer.push_interleaved(2, 2, |i| [1.0, 0.0, -0.5, -0.5][i]);
        assert_eq!(source.read(Duration::ZERO), Some(vec![0.5, -0.5]));
    }

    #[test]
    fn interleaved_f32le_bytes() {
        let (mut writer, mut source) = channel(16, 48_000);
        let bytes: Vec<u8> = [0.25f32, 0.75, 1.0, 0.0]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        writer.push_f32le_bytes(&bytes, 2);
        assert_eq!(source.read(Duration::ZERO), Some(vec![0.5, 0.5]));
    }

    #[test]
    fn timeout_returns_empty_and_closed_source_returns_none() {
        let (writer, mut source) = channel(16, 16_000);
        assert_eq!(source.read(Duration::from_millis(10)), Some(Vec::new()));
        writer.close();
        assert_eq!(source.read(Duration::from_millis(10)), None);
    }

    #[test]
    fn full_ring_counts_dropped_samples_and_rate_changes() {
        let (mut writer, source) = channel(4, 44_100);
        writer.push_interleaved(6, 1, |_| 0.1);
        assert_eq!(source.dropped_samples(), 2);
        writer.set_sample_rate(48_000);
        assert_eq!(source.sample_rate(), 48_000);
    }

    #[test]
    fn dropping_source_runs_stop() {
        let flag = Arc::new(AtomicBool::new(false));
        let (_writer, source) = channel(4, 16_000);
        let seen = Arc::clone(&flag);
        drop(source.on_stop(move || seen.store(true, Ordering::Release)));
        assert!(flag.load(Ordering::Acquire));
    }
}
