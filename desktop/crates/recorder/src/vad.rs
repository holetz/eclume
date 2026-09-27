//! Detector de silêncio por energia, para a nota por voz: diz quando a pessoa parou de falar
//! (`Silence`) ou quando nunca falou (`NoSpeech`), e guarda o nível recente para o medidor.
//!
//! Puro, sem dispositivo: recebe as amostras mixadas a 16 kHz que a sessão já produz e as corta
//! em quadros de 20 ms. Cada quadro tem o RMS em dBFS. O piso de ruído desce na hora para um
//! quadro mais baixo e sobe devagar (0,5 dB/s), para acompanhar um ruído de fundo novo. Um quadro
//! é voz acima de `max(piso + 12 dB, −55 dBFS)`, e a voz se mantém por 300 ms depois do último
//! quadro de voz. Com um locutor só, perto do microfone, energia com piso adaptativo basta; um VAD
//! treinado traria dependência nativa.

use std::collections::VecDeque;
use std::time::Duration;

use crate::mix::TARGET_RATE;

/// Duração de um quadro, em ms.
pub const FRAME_MS: u64 = 20;
/// Amostras de um quadro a 16 kHz.
pub const FRAME_SAMPLES: usize = (TARGET_RATE as usize) * (FRAME_MS as usize) / 1000;
/// Barras do medidor.
pub const METER_BARS: usize = 16;

/// Quanto acima do piso um quadro precisa estar para ser voz.
const VOICE_MARGIN_DB: f32 = 12.0;
/// Abaixo disso nunca é voz, por mais silencioso que seja o piso.
const VOICE_MIN_DBFS: f32 = -55.0;
/// Quanto o piso sobe por segundo quando o nível fica acima dele.
const FLOOR_RISE_DB_PER_S: f32 = 0.5;
/// A voz se mantém por este tempo depois do último quadro de voz.
const HANGOVER_MS: u64 = 300;
/// Sem voz nenhuma neste tempo, a nota é descartada.
const NO_SPEECH_MS: u64 = 10_000;
/// Nível do quadro de silêncio digital (RMS zero).
const SILENT_DBFS: f32 = -100.0;
/// O medidor vai de −60 dBFS (vazio) a 0 dBFS (cheio).
const METER_MIN_DBFS: f32 = -60.0;

/// Por que o detector pede para parar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    /// Houve voz e depois o silêncio configurado.
    Silence,
    /// Nenhuma voz nos primeiros 10 s.
    NoSpeech,
}

/// O estado do detector ao longo de uma nota.
#[derive(Debug)]
pub struct SilenceDetector {
    /// Silêncio que encerra a nota; `None` ("Nunca") só alimenta o medidor.
    stop_after_ms: Option<u64>,
    /// Amostras que ainda não fecham um quadro.
    pending: Vec<f32>,
    floor_dbfs: Option<f32>,
    hangover_ms: u64,
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
            floor_dbfs: None,
            hangover_ms: 0,
            heard_voice: false,
            silence_ms: 0,
            elapsed_ms: 0,
            levels: VecDeque::with_capacity(METER_BARS),
            event: None,
        }
    }

    /// Consome amostras (16 kHz, mono). Devolve o evento de parada assim que ele acontece; depois
    /// dele, o mesmo evento continua valendo em [`Self::event`].
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

        let floor = match self.floor_dbfs {
            Some(floor) if level >= floor => {
                (floor + FLOOR_RISE_DB_PER_S * FRAME_MS as f32 / 1000.0).min(level)
            }
            _ => level,
        };
        self.floor_dbfs = Some(floor);

        if level > (floor + VOICE_MARGIN_DB).max(VOICE_MIN_DBFS) {
            self.heard_voice = true;
            self.hangover_ms = HANGOVER_MS;
            self.silence_ms = 0;
        } else if self.hangover_ms > 0 {
            self.hangover_ms = self.hangover_ms.saturating_sub(FRAME_MS);
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

    /// O evento de parada, se já aconteceu.
    pub fn event(&self) -> Option<VadEvent> {
        self.event
    }

    /// Se já houve voz.
    pub fn heard_voice(&self) -> bool {
        self.heard_voice
    }

    /// Silêncio contínuo desde a última voz, em ms.
    pub fn silence_ms(&self) -> u64 {
        self.silence_ms
    }

    /// Quanto falta de silêncio para parar, depois de ter havido voz e enquanto há silêncio;
    /// `None` fora disso ou com "Nunca".
    pub fn stops_in_ms(&self) -> Option<u64> {
        let stop_after = self.stop_after_ms?;
        (self.heard_voice && self.silence_ms > 0 && self.event.is_none())
            .then(|| stop_after.saturating_sub(self.silence_ms))
    }

    /// Os últimos [`METER_BARS`] níveis, do mais antigo ao mais novo, de 0 (−60 dBFS ou menos) a
    /// 1 (0 dBFS). Antes de haver quadros suficientes, o começo fica em 0.
    pub fn meter(&self) -> [f32; METER_BARS] {
        let mut bars = [0.0; METER_BARS];
        let offset = METER_BARS - self.levels.len();
        for (bar, level) in bars[offset..].iter_mut().zip(&self.levels) {
            *bar = ((level - METER_MIN_DBFS) / -METER_MIN_DBFS).clamp(0.0, 1.0);
        }
        bars
    }
}

/// RMS do quadro em dBFS (silêncio digital vira −100).
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

    /// Ruído branco determinístico com amplitude de pico `amplitude`.
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

    /// "Fala": tom de 220 Hz em rajadas de 200 ms com 100 ms de pausa, sobre o ruído.
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

    /// Alimenta em blocos de 10 ms, como o laço de gravação, e devolve o instante (ms desde o
    /// início do trecho) do evento.
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
    fn para_depois_do_silencio_configurado() {
        let mut noise = Noise(1);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        assert_eq!(feed(&mut detector, &speech(&mut noise, 3_000)), None);
        assert!(detector.heard_voice());

        let (event, at) = feed(&mut detector, &noise.samples(10_000, 0.002)).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // A última rajada acaba 100 ms antes do fim da fala: 200 ms de hangover restantes + 4 s.
        assert!((4_180..=4_220).contains(&at), "parou em {at} ms");
        assert_eq!(detector.event(), Some(VadEvent::Silence));
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn pausa_curta_nao_para_e_conta_o_que_falta() {
        let mut noise = Noise(2);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        assert_eq!(feed(&mut detector, &noise.samples(2_300, 0.002)), None);
        let left = detector.stops_in_ms().unwrap();
        assert!((1_900..=2_100).contains(&left), "faltam {left} ms");
        // Voltou a falar: o silêncio zera.
        feed(&mut detector, &speech(&mut noise, 500));
        assert_eq!(detector.silence_ms(), 0);
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn sem_voz_em_dez_segundos_e_nota_sem_fala() {
        let mut noise = Noise(3);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let (event, at) = feed(&mut detector, &noise.samples(12_000, 0.002)).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
        assert_eq!(at, 10_000);
        assert!(!detector.heard_voice());
    }

    #[test]
    fn silencio_digital_tambem_e_sem_voz() {
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(8)));
        let (event, _) = feed(&mut detector, &vec![0.0; RATE * 11]).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
    }

    #[test]
    fn nunca_so_alimenta_o_medidor() {
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
    fn ruido_de_fundo_novo_vira_piso_e_a_nota_para() {
        let mut noise = Noise(5);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        // Um ventilador liga depois da fala, uns 20 dB acima do ruído de antes: o piso sobe até
        // ele, e o silêncio passa a contar.
        let fan = noise.samples(60_000, 0.02);
        let (event, at) = feed(&mut detector, &fan).unwrap();
        assert_eq!(event, VadEvent::Silence);
        assert!(at < 40_000, "parou só em {at} ms");
    }

    #[test]
    fn medidor_de_dezesseis_niveis_do_mais_antigo_ao_mais_novo() {
        let mut detector = SilenceDetector::new(None);
        assert_eq!(detector.meter(), [0.0; METER_BARS]);
        // 0 dBFS de RMS (onda quadrada cheia) enche a barra; silêncio a esvazia.
        detector.push(&vec![1.0; FRAME_SAMPLES * 2]);
        let bars = detector.meter();
        assert_eq!(&bars[..METER_BARS - 2], &[0.0; METER_BARS - 2]);
        assert!(bars[METER_BARS - 2..]
            .iter()
            .all(|b| (*b - 1.0).abs() < 1e-3));
        // −30 dBFS fica no meio.
        detector.push(&vec![10f32.powf(-30.0 / 20.0); FRAME_SAMPLES]);
        assert!((detector.meter()[METER_BARS - 1] - 0.5).abs() < 0.01);
        detector.push(&vec![0.0; FRAME_SAMPLES * 20]);
        assert_eq!(detector.meter(), [0.0; METER_BARS]);
    }

    #[test]
    fn quadro_incompleto_espera_o_resto() {
        let mut detector = SilenceDetector::new(None);
        detector.push(&vec![1.0; FRAME_SAMPLES - 1]);
        assert_eq!(detector.meter()[METER_BARS - 1], 0.0);
        detector.push(&[1.0]);
        assert!(detector.meter()[METER_BARS - 1] > 0.99);
    }
}
