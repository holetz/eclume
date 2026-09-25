//! Mixagem das fontes num único fluxo mono de 16 kHz.
//!
//! Cada fonte (uma "faixa") é reamostrada para [`TARGET_RATE`] e somada às outras em blocos de
//! [`FRAME`] amostras (20 ms), com limitador rígido em ±1,0. Uma faixa que fica mais de
//! `max_lag` atrás das outras é completada com silêncio — um monitor de sink suspenso não entrega
//! nada —, e as amostras dela que chegarem depois descontam essa dívida, para que as faixas não
//! fiquem desalinhadas.

use std::collections::VecDeque;

use anyhow::{Context, Result};
use resampler::{
    Async, FixedAsync, RubatoChunkResampler, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

/// Taxa do fluxo mixado, em Hz.
pub const TARGET_RATE: u32 = 16_000;
/// Amostras por bloco de mixagem e por frame Opus: 20 ms a 16 kHz.
pub const FRAME: usize = 320;
/// Atraso máximo tolerado entre faixas antes de completar a atrasada com silêncio: 200 ms.
pub const DEFAULT_MAX_LAG: usize = 3_200;

/// Bloco de entrada do reamostrador: 10 ms na taxa de origem.
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
    /// Amostras de silêncio já emitidas por esta faixa e ainda não descontadas.
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
            // O dispositivo trocou de taxa: descarrega o reamostrador antigo e recomeça.
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
        for sample in samples {
            if self.debt > 0 {
                self.debt -= 1;
            } else {
                self.queue.push_back(sample);
            }
        }
    }

    /// Tira `n` amostras; o que faltar vira silêncio e dívida (se a faixa ainda está viva).
    fn take_into(&mut self, out: &mut [f32]) {
        let available = self.queue.len().min(out.len());
        for (slot, sample) in out.iter_mut().zip(self.queue.drain(..available)) {
            *slot += sample;
        }
        if !self.ended {
            self.debt += out.len() - available;
        }
    }
}

/// Mixador de N faixas para mono 16 kHz.
pub struct Mixer {
    lanes: Vec<Lane>,
    max_lag: usize,
}

impl Mixer {
    /// Cria o mixador com uma faixa por taxa inicial.
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

    /// Entrega amostras mono da faixa `lane`, na taxa `rate`.
    pub fn push(&mut self, lane: usize, samples: &[f32], rate: u32) -> Result<()> {
        self.lanes[lane].push(samples, rate)
    }

    /// Marca a faixa como encerrada: daqui em diante ela conta como silêncio.
    pub fn end(&mut self, lane: usize) -> Result<()> {
        let lane = &mut self.lanes[lane];
        lane.flush()?;
        lane.ended = true;
        lane.debt = 0;
        Ok(())
    }

    /// Se todas as faixas terminaram.
    pub fn all_ended(&self) -> bool {
        self.lanes.iter().all(|lane| lane.ended)
    }

    /// Devolve os blocos completos já mixáveis (múltiplo de [`FRAME`]).
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

    /// Descarrega tudo ao parar: reamostradores e filas, completando com silêncio.
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
            lane.take_into(block);
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
    fn mix_de_48k_e_44k1_vira_um_fluxo_de_16k() {
        let mut mixer = Mixer::new(&[48_000, 44_100]).unwrap();
        let mic = sine(48_000, 300.0, 0.3, 1.0);
        let sys = sine(44_100, 700.0, 0.3, 1.0);
        // Entrega em pedaços irregulares, como os callbacks de áudio.
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
        assert!(diff <= 2 * FRAME, "saída com {} amostras", out.len());
        // Duas senoides independentes de 0,3 somam RMS ≈ 0,3.
        let middle = &out[2_000..14_000];
        let level = rms(middle);
        assert!((0.25..0.35).contains(&level), "RMS {level}");
    }

    #[test]
    fn limitador_segura_a_soma_em_um() {
        let mut mixer = Mixer::new(&[16_000, 16_000]).unwrap();
        mixer.push(0, &[0.8; FRAME], 16_000).unwrap();
        mixer.push(1, &[0.8; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 1.0).abs() < f32::EPSILON));
    }

    #[test]
    fn faixa_atrasada_vira_silencio_e_depois_desconta_a_divida() {
        let mut mixer = Mixer::with_max_lag(&[16_000, 16_000], FRAME).unwrap();
        // Só a faixa 0 entrega: um bloco não basta, dois blocos ultrapassam o atraso tolerado.
        mixer.push(0, &[0.5; FRAME], 16_000).unwrap();
        assert!(mixer.pop_ready().is_empty());
        mixer.push(0, &[0.5; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 0.5).abs() < 1e-6));

        // A faixa 1 chega atrasada: o primeiro bloco dela paga a dívida e é descartado.
        mixer.push(1, &[0.25; FRAME], 16_000).unwrap();
        mixer.push(1, &[0.25; FRAME], 16_000).unwrap();
        let out = mixer.pop_ready();
        assert_eq!(out.len(), FRAME);
        assert!(out.iter().all(|s| (*s - 0.75).abs() < 1e-6));
    }

    #[test]
    fn faixa_encerrada_conta_como_silencio() {
        let mut mixer = Mixer::new(&[16_000, 16_000]).unwrap();
        mixer.end(1).unwrap();
        mixer.push(0, &[0.1; FRAME * 2], 16_000).unwrap();
        assert_eq!(mixer.pop_ready().len(), FRAME * 2);
        assert!(!mixer.all_ended());
        mixer.end(0).unwrap();
        assert!(mixer.all_ended());
    }

    #[test]
    fn troca_de_taxa_no_meio_reconstroi_o_reamostrador() {
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
        assert!(diff <= 3 * FRAME, "saída com {} amostras", out.len());
    }
}
