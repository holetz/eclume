//! A reconnecting source: when the device's ring buffer closes (stream error, unplugged device,
//! Bluetooth profile switch) or a follower requests a switch, it releases the old ring and reopens
//! through the opener on a separate thread, waiting 0.5 s and doubling up to 5 s, retrying as long
//! as
//! the recording exists. While reconnecting, it delivers silence at wall-clock pace at the last
//! rate:
//! the track does not fall behind, and its duration matches the meeting.
//! Contract: docs/standards/code/desktop-gravacao.md §Sources.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::ring::RingSource;
use crate::{AudioSource, SourceState};

const FIRST_WAIT: Duration = Duration::from_millis(500);
const MAX_WAIT: Duration = Duration::from_secs(5);

/// Opens (or reopens) the device and returns its ring buffer.
pub type Opener = Box<dyn FnMut() -> Result<RingSource> + Send>;

/// A source wrapping an opener that reopens the device when it disconnects.
pub struct Reconnecting {
    open: Arc<Mutex<Opener>>,
    current: Option<RingSource>,
    /// The last ring buffer's rate, used for silence during reconnection.
    rate: u32,
    /// When the device disconnected, and how many silent samples have been emitted since.
    lost: Option<(Instant, u64)>,
    /// The ongoing reopen attempt, on a separate thread.
    pending: Option<Receiver<Result<RingSource>>>,
    next_try: Instant,
    wait: Duration,
    /// Dropped samples from already released ring buffers.
    dropped_before: u64,
    /// Set by a follower when the active device should switch (the OS default changed).
    switch: Option<Arc<AtomicBool>>,
}

impl Reconnecting {
    /// Opens the device for the first time; a failure here is an error for the recording caller.
    pub fn open(mut open: Opener) -> Result<Self> {
        let first = open()?;
        Ok(Self {
            rate: first.sample_rate(),
            current: Some(first),
            open: Arc::new(Mutex::new(open)),
            lost: None,
            pending: None,
            next_try: Instant::now(),
            wait: FIRST_WAIT,
            dropped_before: 0,
            switch: None,
        })
    }

    /// Connects a follower's switch request: when it becomes `true`, the source reopens.
    pub fn with_switch(mut self, switch: Arc<AtomicBool>) -> Self {
        self.switch = Some(switch);
        self
    }

    /// Releases the current ring buffer on a separate thread: tearing down a failed driver may take
    /// time, and the recording loop does not wait for it.
    fn release(&mut self) {
        if let Some(ring) = self.current.take() {
            self.dropped_before += ring.dropped_samples();
            let _ = std::thread::Builder::new()
                .name("eclume-solta".into())
                .spawn(move || drop(ring));
        }
    }

    /// The device disconnected: releases the ring buffer and starts reconnecting immediately.
    fn lose(&mut self, now: Instant) {
        self.release();
        if self.lost.is_none() {
            log::warn!("audio device disconnected; trying to reopen");
            self.lost = Some((now, 0));
        }
        self.wait = FIRST_WAIT;
        self.next_try = now;
    }

    /// Starts reopening on a separate thread so the recording loop does not wait for the driver.
    fn try_reopen(&mut self) {
        let (tx, rx) = mpsc::channel();
        let open = Arc::clone(&self.open);
        let spawned = std::thread::Builder::new()
            .name("eclume-reabre".into())
            .spawn(move || {
                let result = match open.lock() {
                    Ok(mut open) => open(),
                    Err(_) => Err(anyhow::anyhow!("abridor envenenado por um pânico")),
                };
                let _ = tx.send(result);
            });
        match spawned {
            Ok(_) => self.pending = Some(rx),
            Err(err) => log::warn!("failed to create device reopening thread: {err}"),
        }
    }

    /// Receives the result of the ongoing reopen attempt, if available.
    fn poll_pending(&mut self, now: Instant) {
        let Some(rx) = &self.pending else {
            return;
        };
        let result = match rx.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => Err(anyhow::anyhow!("a reabertura parou no meio")),
        };
        self.pending = None;
        match result {
            Ok(ring) => {
                self.release();
                self.rate = ring.sample_rate();
                self.current = Some(ring);
                if let Some((since, _)) = self.lost.take() {
                    log::info!("audio device back after {:?}", now - since);
                }
                self.wait = FIRST_WAIT;
            }
            Err(err) => {
                log::warn!(
                    "reopening device failed ({err:#}); retrying in {:?}",
                    self.wait
                );
                self.next_try = now + self.wait;
                self.wait = (self.wait * 2).min(MAX_WAIT);
            }
        }
    }

    /// Silence due since disconnection, at the last rate.
    fn silence(&mut self, now: Instant) -> Vec<f32> {
        let Some((since, emitted)) = &mut self.lost else {
            return Vec::new();
        };
        let due = (now - *since).as_secs_f64() * f64::from(self.rate);
        let due = due as u64;
        let missing = due.saturating_sub(*emitted);
        *emitted = due.max(*emitted);
        vec![0.0; usize::try_from(missing).unwrap_or(0)]
    }
}

impl AudioSource for Reconnecting {
    fn sample_rate(&self) -> u32 {
        self.current
            .as_ref()
            .map_or(self.rate, AudioSource::sample_rate)
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        let now = Instant::now();
        if self.pending.is_none()
            && self
                .switch
                .as_ref()
                .is_some_and(|switch| switch.swap(false, Ordering::AcqRel))
        {
            // Device switch: reopens now, keeping the current ring buffer until the new one
            // arrives.
            self.try_reopen();
        }
        self.poll_pending(now);
        if let Some(ring) = self.current.as_mut() {
            if let Some(samples) = ring.read(timeout) {
                return Some(samples);
            }
            self.lose(Instant::now());
        }
        let now = Instant::now();
        if self.pending.is_none() && now >= self.next_try {
            self.try_reopen();
        }
        // Waits as a real read would, and delivers silence for the interval.
        std::thread::sleep(timeout);
        let now = Instant::now();
        self.poll_pending(now);
        Some(self.silence(now))
    }

    fn state(&self) -> SourceState {
        match self.lost {
            Some((since, _)) => SourceState::Reconnecting { since },
            None => SourceState::Live,
        }
    }

    fn dropped_samples(&self) -> u64 {
        self.dropped_before
            + self
                .current
                .as_ref()
                .map_or(0, AudioSource::dropped_samples)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::ring::{self, RingWriter};

    /// A scripted opener: each call takes the next result from the queue and gives the opened ring
    /// buffer's writer to the test.
    fn scripted(
        script: Vec<Result<u32, &'static str>>,
    ) -> (Opener, Arc<Mutex<VecDeque<RingWriter>>>) {
        let writers = Arc::new(Mutex::new(VecDeque::new()));
        let mut script: VecDeque<_> = script.into();
        let out = Arc::clone(&writers);
        let opener: Opener = Box::new(move || match script.pop_front() {
            Some(Ok(rate)) => {
                let (writer, source) = ring::channel(1 << 12, rate);
                out.lock().unwrap().push_back(writer);
                Ok(source)
            }
            Some(Err(message)) => Err(anyhow::anyhow!(message)),
            None => Err(anyhow::anyhow!("sem dispositivo")),
        });
        (opener, writers)
    }

    #[test]
    fn reconnect_delivers_silence_and_returns_to_device() {
        let (opener, writers) = scripted(vec![Ok(16_000), Err("sumiu"), Ok(8_000)]);
        let mut source = Reconnecting::open(opener).unwrap();
        writers.lock().unwrap()[0].push_interleaved(160, 1, |_| 0.5);
        assert_eq!(source.read(Duration::from_millis(10)).unwrap().len(), 160);
        assert_eq!(source.state(), SourceState::Live);

        // The device stream disconnects.
        writers.lock().unwrap()[0].close();
        let started = Instant::now();
        let mut silence = 0;
        while started.elapsed() < Duration::from_millis(1_200) {
            let chunk = source.read(Duration::from_millis(10)).unwrap();
            assert!(chunk.iter().all(|s| *s == 0.0));
            silence += chunk.len();
            if source.state() == SourceState::Live {
                break;
            }
        }
        // The first reopen fails; the second, 0.5 s later, returns at 8 kHz.
        assert_eq!(source.state(), SourceState::Live);
        assert_eq!(source.sample_rate(), 8_000);
        let elapsed = started.elapsed().as_secs_f64();
        // Silence at wall-clock pace, at 16 kHz (the last rate before disconnection).
        let expected = elapsed * 16_000.0;
        assert!(
            (silence as f64) > expected * 0.8 && (silence as f64) <= expected * 1.05,
            "{silence} silent samples in {elapsed:.2} s"
        );
        writers.lock().unwrap()[1].push_interleaved(80, 1, |_| 0.25);
        let back = source.read(Duration::from_millis(10)).unwrap();
        assert_eq!(back, vec![0.25; 80]);
    }

    #[test]
    fn reconnect_reports_disconnection_and_sums_dropped_samples() {
        let (opener, writers) = scripted(vec![Ok(16_000)]);
        let mut source = Reconnecting::open(opener).unwrap();
        // Ring buffer of 4096: 5000 samples drop 904.
        writers.lock().unwrap()[0].push_interleaved(5_000, 1, |_| 0.1);
        assert_eq!(source.dropped_samples(), 904);
        writers.lock().unwrap()[0].close();
        while source.read(Duration::ZERO).is_some_and(|c| !c.is_empty()) {}
        let SourceState::Reconnecting { since } = source.state() else {
            panic!("expected reconnecting");
        };
        assert!(since.elapsed() < Duration::from_secs(1));
        assert_eq!(source.dropped_samples(), 904);
    }

    #[test]
    fn reconnect_switches_when_follower_requests() {
        let (opener, writers) = scripted(vec![Ok(16_000), Ok(48_000)]);
        let switch = Arc::new(AtomicBool::new(false));
        let mut source = Reconnecting::open(opener)
            .unwrap()
            .with_switch(Arc::clone(&switch));
        switch.store(true, Ordering::Release);
        let started = Instant::now();
        while source.sample_rate() != 48_000 && started.elapsed() < Duration::from_secs(2) {
            source.read(Duration::from_millis(10)).unwrap();
        }
        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.state(), SourceState::Live);
        assert_eq!(writers.lock().unwrap().len(), 2);
    }
}
