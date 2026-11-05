//! Mixes sources into a single mono 16 kHz stream.
//!
//! Each source (a "lane") is resampled to [`TARGET_RATE`] and added to the others in blocks of
//! [`FRAME`] samples (20 ms), with hard limiting at ±1.0. A lane more than `max_lag` behind the
//! others is padded with silence — a suspended sink monitor or idle WASAPI loopback delivers
//! nothing. This silence becomes a debt of at most `max_lag`, deducted only when the lane
//! delivers a burst ahead of the others; a lane that resumes real-time delivery joins in sync
//! without losing samples.

use std::collections::VecDeque;

use anyhow::{Context, Result};
use resampler::{
    Async, FixedAsync, RubatoChunkResampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

/// Mixed stream rate, in Hz.
pub const TARGET_RATE: u32 = 16_000;
/// Samples per mixing block and per Opus frame: 20 ms at 16 kHz.
pub const FRAME: usize = 320;
/// Maximum tolerated lag between lanes before padding the late one with silence: 200 ms.
pub const DEFAULT_MAX_LAG: usize = 3_200;

/// Resampler input block: 10 ms at the source rate.
fn input_block(rate: u32) -> usize {
    (rate as usize / 100).max(1)
}

fn build_resampler(rate: u32) -> Result<RubatoChunkResampler<Async<f32>, 1>> {
    let block = input_block(rate);
    let params = SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.925,
        oversampling_factor: 256,
        interpolation: SincInterpolationType::Linear,
        window: WindowFunction::BlackmanHarris2,
    };
    let resampler = Async::<f32>::new_sinc(
        f64::from(TARGET_RATE) / f64::from(rate),
        1.0,
        &params,
        block,
        1,
        FixedAsync::Input,
    )
    .with_context(|| format!("falha ao criar o reamostrador de {rate} Hz"))?;
    Ok(RubatoChunkResampler::new(resampler, FRAME, block))
}

struct Lane {
    rate: u32,
    resampler: Option<RubatoChunkResampler<Async<f32>, 1>>,
    queue: VecDeque<f32>,
    /// Silence samples already emitted by this lane and not yet deducted.
    debt: usize,
    ended: bool,
}

impl Lane {
    fn new(rate: u32) -> Result<Self> {
        Ok(Self {
            rate,
            resampler: Self::resampler_for(rate)?,
            queue: VecDeque::new(),
            debt: 0,
            ended: false,
        })
    }

    fn resampler_for(rate: u32) -> Result<Option<RubatoChunkResampler<Async<f32>, 1>>> {
        if rate == TARGET_RATE {
            Ok(None)
        } else {
            build_resampler(rate).map(Some)
        }
    }

    fn push(&mut self, samples: &[f32], rate: u32) -> Result<()> {
        if rate != self.rate && rate > 0 {
            // The device changed rate: flush the old resampler and start over.
            self.flush()?;
            self.rate = rate;
            self.resampler = Self::resampler_for(rate)?;
        }
        match &mut self.resampler {
            None => self.enqueue(samples.iter().copied()),
            Some(resampler) => {
                for sample in samples {
                    resampler.push_sample(*sample);
                }
                resampler.process_all_ready_blocks()?;
                if let Some(out) = resampler.take_all_output() {
                    self.enqueue(out);
                }
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        if let Some(resampler) = &mut self.resampler {
            resampler.process_partial_block(true)?;
            if let Some(out) = resampler.take_all_output() {
                self.enqueue(out);
            }
        }
        Ok(())
    }

    fn enqueue(&mut self, samples: impl IntoIterator<Item = f32>) {
        self.queue.extend(samples);
    }

    /// Deducts debt only from what the lane has ahead of `ahead_of`: a late burst pays it off,
    /// and a lane resuming real-time delivery after silence with no packets (idle WASAPI
    /// loopback) loses nothing.
    fn pay_debt(&mut self, ahead_of: usize) {
        let excess = self.queue.len().saturating_sub(ahead_of);
        let paid = self.debt.min(excess);
        self.queue.drain(..paid);
        self.debt -= paid;
    }

    /// Takes `n` samples; missing samples become silence and debt (if the lane is still live),
    /// up to `max_lag`.
    fn take_into(&mut self, out: &mut [f32], max_lag: usize) {
        let available = self.queue.len().min(out.len());
        for (slot, sample) in out.iter_mut().zip(self.queue.drain(..available)) {
            *slot += sample;
        }
        if !self.ended {
            self.debt = (self.debt + out.len() - available).min(max_lag);
        }
    }
}

/// Mixer from N lanes to mono 16 kHz.
pub struct Mixer {
    lanes: Vec<Lane>,
    max_lag: usize,
}

impl Mixer {
    /// Creates the mixer with one lane per initial rate.
    pub fn new(rates: &[u32]) -> Result<Self> {
        Self::with_max_lag(rates, DEFAULT_MAX_LAG)
    }

    pub fn with_max_lag(rates: &[u32], max_lag: usize) -> Result<Self> {
        Ok(Self {
            lanes: rates
                .iter()
                .map(|rate| Lane::new(*rate))
                .collect::<Result<_>>()?,
            max_lag,
        })
    }

    /// Delivers mono samples from lane `lane`, at rate `rate`.
    pub fn push(&mut self, lane: usize, samples: &[f32], rate: u32) -> Result<()> {
        self.lanes[lane].push(samples, rate)?;
        let ahead_of = self
            .lanes
            .iter()
            .enumerate()
            .filter(|(index, other)| *index != lane && !other.ended)
            .map(|(_, other)| other.queue.len())
            .max()
            .unwrap_or(0);
        self.lanes[lane].pay_debt(ahead_of);
        Ok(())
    }

    /// Marks the lane as ended: from now on it counts as silence.
    pub fn end(&mut self, lane: usize) -> Result<()> {
        let lane = &mut self.lanes[lane];
        lane.flush()?;
        lane.ended = true;
        lane.debt = 0;
        Ok(())
    }

    /// Returns complete blocks ready to mix (a multiple of [`FRAME`]).
    pub fn pop_ready(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        loop {
            let longest = self.lanes.iter().map(|l| l.queue.len()).max().unwrap_or(0);
            if longest < FRAME {
                break;
            }
            let all_ready = self
                .lanes
                .iter()
                .all(|lane| lane.ended || lane.queue.len() >= FRAME);
            if !all_ready && longest < FRAME + self.max_lag {
                break;
            }
            self.mix_block(FRAME, &mut out);
        }
        out
    }

    /// Flushes everything on stop: resamplers and queues, padding with silence.
    pub fn drain(&mut self) -> Result<Vec<f32>> {
        for lane in &mut self.lanes {
            lane.flush()?;
            lane.ended = true;
            lane.debt = 0;
        }
        let mut out = self.pop_ready();
        let rest = self.lanes.iter().map(|l| l.queue.len()).max().unwrap_or(0);
        if rest > 0 {
            self.mix_block(rest, &mut out);
        }
        Ok(out)
    }

    fn mix_block(&mut self, len: usize, out: &mut Vec<f32>) {
        let start = out.len();
        out.resize(start + len, 0.0);
        let block = &mut out[start..];
        for lane in &mut self.lanes {
            lane.take_into(block, self.max_lag);
        }
        for sample in block {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, amp: f32, seconds: f32) -> Vec<f32> {
        let n = (rate as f32 * seconds) as usize;
        (0..n)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * amp)
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn mix_of_48k_and_44k1_becomes_a_16k_stream() {
        let mut mixer = Mixer::new(&[48_000, 44_100]).unwrap();
        let mic = sine(48_000, 300.0, 0.3, 1.0);
        let sys = sine(44_100, 700.0, 0.3, 1.0);
        // Deliver in irregular chunks, like audio callbacks.
        let mut out = Vec::new();
        for (a, b) in mic.chunks(480).zip(sys.chunks(441)) {
            mixer.push(0, a, 48_000).unwrap();
            mixer.push(1, b, 44_100).unwrap();
            out.extend(mixer.pop_ready());
        }
        assert_eq!(out.len() % FRAME, 0);
        out.extend(mixer.drain().unwrap());

        let expected = TARGET_RATE as usize;
        let diff = out.len().abs_diff(expected);
        assert!(diff <= 2 * FRAME, "output with {} samples", out.len());
        // Two independent sine waves of 0.3 add up to RMS ≈ 0.3.
        let middle = &out[2_000..14_000];
        let level = rms(middle);
        assert!((0.25..0.35).contains(&level), "RMS {level}");
    }

    #[test]
    fn limiter_caps_sum_at_one() {
        let mut mixer = Mixer::new(&[16_000, 16_000]).unwrap();
        mixer.push(0, &[0.8; FRAME], 16_000).unwrap();
        mixer.push(1, &[0.8; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 1.0).abs() < f32::EPSILON));
    }

    #[test]
    fn late_lane_becomes_silence_then_pays_off_debt() {
        let mut mixer = Mixer::with_max_lag(&[16_000, 16_000], FRAME).unwrap();
        // Only lane 0 delivers: one block is not enough; two exceed the tolerated lag.
        mixer.push(0, &[0.5; FRAME], 16_000).unwrap();
        assert!(mixer.pop_ready().is_empty());
        mixer.push(0, &[0.5; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 0.5).abs() < 1e-6));

        // Lane 1 arrives late: its first block pays off the debt and is discarded.
        mixer.push(1, &[0.25; FRAME], 16_000).unwrap();
        mixer.push(1, &[0.25; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 0.75).abs() < 1e-6));
    }

    /// Continuous mic at 48 kHz; the system lane at 44.1 kHz only delivers in seconds indicated
    /// by `system_plays`, like WASAPI loopback. Returns the RMS of each output second.
    fn rms_per_second(seconds: usize, system_plays: impl Fn(usize) -> bool) -> Vec<f32> {
        let mut mixer = Mixer::new(&[48_000, 44_100]).unwrap();
        let mic = sine(48_000, 300.0, 0.005, 0.01);
        let sys = sine(44_100, 700.0, 0.3, 0.01);
        let mut out = Vec::new();
        for tick in 0..seconds * 100 {
            mixer.push(0, &mic, 48_000).unwrap();
            if system_plays(tick / 100) {
                mixer.push(1, &sys, 44_100).unwrap();
            }
            out.extend(mixer.pop_ready());
        }
        out.extend(mixer.drain().unwrap());
        out.chunks(TARGET_RATE as usize).map(rms).collect()
    }

    #[test]
    fn lane_resuming_after_silence_without_packets_is_preserved() {
        let levels = rms_per_second(10, |second| second >= 3);
        for (second, level) in levels.iter().enumerate().take(10).skip(4) {
            assert!((0.15..0.3).contains(level), "second {second}: RMS {level}");
        }
    }

    #[test]
    fn intermittent_lane_preserves_every_signal_segment() {
        let levels = rms_per_second(12, |second| (second / 2) % 2 == 1);
        for (second, level) in levels.iter().enumerate().take(12) {
            // One second at each edge mixes signal and silence due to tolerated lag; the others
            // follow what the lane delivered.
            let playing = (second / 2) % 2 == 1;
            let edge = second % 2 == 0;
            if playing && !edge {
                assert!((0.15..0.3).contains(level), "second {second}: RMS {level}");
            }
        }
        let with_signal = levels.iter().filter(|level| **level > 0.15).count();
        assert!(
            with_signal >= 5,
            "only {with_signal} seconds with system audio: {levels:?}"
        );
    }

    #[test]
    fn debt_never_exceeds_tolerated_lag() {
        let mut mixer = Mixer::with_max_lag(&[16_000, 16_000], FRAME).unwrap();
        for _ in 0..50 {
            mixer.push(0, &[0.1; FRAME], 16_000).unwrap();
            mixer.pop_ready();
        }
        assert!(mixer.lanes[1].debt <= FRAME, "debt {}", mixer.lanes[1].debt);
    }

    #[test]
    fn ended_lane_counts_as_silence() {
        let mut mixer = Mixer::new(&[16_000, 16_000]).unwrap();
        mixer.end(1).unwrap();
        mixer.push(0, &[0.1; FRAME * 2], 16_000).unwrap();
        assert_eq!(mixer.pop_ready().len(), FRAME * 2);
    }

    #[test]
    fn rate_change_midway_rebuilds_resampler() {
        let mut mixer = Mixer::new(&[48_000]).unwrap();
        mixer
            .push(0, &sine(48_000, 440.0, 0.5, 0.5), 48_000)
            .unwrap();
        mixer
            .push(0, &sine(44_100, 440.0, 0.5, 0.5), 44_100)
            .unwrap();
        let mut out = mixer.pop_ready();
        out.extend(mixer.drain().unwrap());
        let diff = out.len().abs_diff(TARGET_RATE as usize);
        assert!(diff <= 3 * FRAME, "output with {} samples", out.len());
    }
}
