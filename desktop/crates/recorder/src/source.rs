//! Fontes sintéticas, para testes e para exercitar a gravação sem dispositivo.

use std::collections::VecDeque;
use std::time::Duration;

use crate::AudioSource;

/// Entrega uma senoide em blocos de 10 ms até completar a duração, e então termina.
pub struct SineSource {
    rate: u32,
    freq: f32,
    amplitude: f32,
    produced: usize,
    total: usize,
}

impl SineSource {
    pub fn new(rate: u32, freq: f32, amplitude: f32, duration: Duration) -> Self {
        Self {
            rate,
            freq,
            amplitude,
            produced: 0,
            total: (f64::from(rate) * duration.as_secs_f64()) as usize,
        }
    }
}

impl AudioSource for SineSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn read(&mut self, _timeout: Duration) -> Option<Vec<f32>> {
        if self.produced >= self.total {
            return None;
        }
        let block = (self.rate as usize / 100).min(self.total - self.produced);
        let start = self.produced;
        self.produced += block;
        let step = self.freq * std::f32::consts::TAU / self.rate as f32;
        Some(
            (start..start + block)
                .map(|i| (i as f32 * step).sin() * self.amplitude)
                .collect(),
        )
    }
}

/// Entrega uma sequência roteirizada de leituras (`Some(vec![])` simula prazo vencido).
pub struct ScriptedSource {
    rate: u32,
    reads: VecDeque<Option<Vec<f32>>>,
}

impl ScriptedSource {
    pub fn new(rate: u32, reads: impl IntoIterator<Item = Option<Vec<f32>>>) -> Self {
        Self {
            rate,
            reads: reads.into_iter().collect(),
        }
    }
}

impl AudioSource for ScriptedSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn read(&mut self, _timeout: Duration) -> Option<Vec<f32>> {
        self.reads.pop_front().flatten()
    }
}
