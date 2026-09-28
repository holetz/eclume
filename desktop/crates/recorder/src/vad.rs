//! Detector de silêncio por energia, para a nota por voz: diz quando a pessoa parou de falar
//! (`Silence`) ou quando nunca falou (`NoSpeech`), e guarda o nível recente para o medidor.
//!
//! Puro, sem dispositivo: recebe as amostras mixadas a 16 kHz que a sessão já produz e as corta
//! em quadros de 20 ms. Cada quadro tem o RMS em dBFS. O piso de ruído é o percentil 20 dos
//! níveis dos últimos 3 s: um ruído de fundo novo vira piso em uns 2,4 s, e a fala, que tem
//! pausas, não o puxa para cima. Silêncio digital nunca é piso: quando o percentil cai nele (mic
//! mudo, ou um supressor de ruído que zera as pausas), valem só os limites absolutos. Um quadro
//! vira voz acima de
//! `max(piso + 12 dB, −55 dBFS)` e se mantém voz acima de `max(piso + 8 dB, −58 dBFS)`. Só a voz
//! sustentada (5 dos últimos 10 quadros) conta: um clique, uma tecla ou uma porta batendo não
//! zeram o silêncio. A voz sustentada se mantém por 300 ms depois do último quadro de voz. Com um
//! locutor só, perto do microfone, energia com piso adaptativo basta; um VAD treinado traria
//! dependência nativa.

use std::collections::VecDeque;
use std::time::Duration;

use crate::mix::TARGET_RATE;

/// Duração de um quadro, em ms.
pub const FRAME_MS: u64 = 20;
/// Amostras de um quadro a 16 kHz.
pub const FRAME_SAMPLES: usize = (TARGET_RATE as usize) * (FRAME_MS as usize) / 1000;
/// Barras do medidor.
pub const METER_BARS: usize = 16;

/// Quanto acima do piso um quadro precisa estar para virar voz.
const VOICE_MARGIN_DB: f32 = 12.0;
/// Abaixo disso nunca vira voz, por mais silencioso que seja o piso.
const VOICE_MIN_DBFS: f32 = -55.0;
/// Quanto acima do piso a voz em curso precisa ficar para continuar voz.
const KEEP_MARGIN_DB: f32 = 8.0;
/// Abaixo disso a voz em curso acaba.
const KEEP_MIN_DBFS: f32 = -58.0;
/// Quadros que o piso considera: os últimos 3 s.
const FLOOR_FRAMES: usize = 150;
/// O piso é este percentil dos níveis recentes.
const FLOOR_PERCENTILE: usize = 20;
/// Quadros abaixo disso são silêncio digital (mudo, fonte parada, pausa zerada): não são piso.
const DIGITAL_SILENCE_DBFS: f32 = -90.0;
/// Voz sustentada: ao menos `SUSTAINED_FRAMES` quadros de voz nos últimos `SUSTAIN_WINDOW`.
const SUSTAINED_FRAMES: u32 = 5;
const SUSTAIN_WINDOW: u32 = 10;
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
    /// Os níveis dos últimos [`FLOOR_FRAMES`] quadros, que definem o piso.
    floor_history: VecDeque<f32>,
    /// O quadro anterior foi voz (a histerese).
    voiced: bool,
    /// Um bit por quadro recente, o mais novo no bit 0: foi voz.
    recent_voiced: u32,
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
            floor_history: VecDeque::with_capacity(FLOOR_FRAMES),
            voiced: false,
            recent_voiced: 0,
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

        // Sem piso (começo ou silêncio digital), valem os limites absolutos.
        let floor = self.floor().unwrap_or(f32::NEG_INFINITY);
        if self.floor_history.len() == FLOOR_FRAMES {
            self.floor_history.pop_front();
        }
        self.floor_history.push_back(level);

        self.voiced = if self.voiced {
            level > (floor + KEEP_MARGIN_DB).max(KEEP_MIN_DBFS)
        } else {
            level > (floor + VOICE_MARGIN_DB).max(VOICE_MIN_DBFS)
        };
        let window = (1 << SUSTAIN_WINDOW) - 1;
        self.recent_voiced = ((self.recent_voiced << 1) | u32::from(self.voiced)) & window;
        let sustained = self.voiced && self.recent_voiced.count_ones() >= SUSTAINED_FRAMES;

        if sustained {
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

    /// O percentil 20 dos níveis recentes; `None` sem quadros ou quando ele é silêncio digital.
    fn floor(&self) -> Option<f32> {
        if self.floor_history.is_empty() {
            return None;
        }
        let mut levels: Vec<f32> = self.floor_history.iter().copied().collect();
        let index = levels.len() * FLOOR_PERCENTILE / 100;
        let (_, floor, _) = levels.select_nth_unstable_by(index, f32::total_cmp);
        Some(*floor).filter(|floor| *floor >= DIGITAL_SILENCE_DBFS)
    }

    /// O evento de parada, se já aconteceu.
    pub fn event(&self) -> Option<VadEvent> {
        self.event
    }

    /// Se já houve voz sustentada.
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

    /// Ruído de fundo com rajadas altas de `burst_ms` a cada `every_ms`, começando em
    /// `first_ms`: cliques, teclas ou uma porta batendo.
    fn noise_with_bursts(
        noise: &mut Noise,
        ms: usize,
        first_ms: usize,
        every_ms: usize,
        burst_ms: usize,
    ) -> Vec<f32> {
        let mut out = noise.samples(ms, 0.002);
        let loud = noise.samples(ms, 0.5);
        for (i, sample) in out.iter_mut().enumerate() {
            let t_ms = i * 1000 / RATE;
            if t_ms >= first_ms && (t_ms - first_ms) % every_ms < burst_ms {
                *sample = loud[i];
            }
        }
        out
    }

    #[test]
    fn cliques_e_teclas_nao_zeram_o_silencio() {
        let mut noise = Noise(6);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 3_000));
        // Cliques de 30 ms (um ou dois quadros) a cada 700 ms, fora do alinhamento dos quadros.
        let clicks = noise_with_bursts(&mut noise, 10_000, 510, 700, 30);
        let (event, at) = feed(&mut detector, &clicks).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // O mesmo instante de sem os cliques (ver `para_depois_do_silencio_configurado`).
        assert!((4_180..=4_220).contains(&at), "parou em {at} ms");
    }

    #[test]
    fn cliques_sozinhos_nao_sao_voz() {
        let mut noise = Noise(7);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let clicks = noise_with_bursts(&mut noise, 12_000, 300, 450, 40);
        let (event, at) = feed(&mut detector, &clicks).unwrap();
        assert_eq!(event, VadEvent::NoSpeech);
        assert_eq!(at, 10_000);
        assert!(!detector.heard_voice());
    }

    #[test]
    fn porta_batendo_nao_impede_a_parada() {
        let mut noise = Noise(8);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 3_000));
        // Uma batida de 60 ms no meio do silêncio.
        let door = noise_with_bursts(&mut noise, 10_000, 2_000, 20_000, 60);
        let (event, at) = feed(&mut detector, &door).unwrap();
        assert_eq!(event, VadEvent::Silence);
        assert!((4_180..=4_220).contains(&at), "parou em {at} ms");
    }

    #[test]
    fn fala_modulada_zera_o_silencio() {
        let mut noise = Noise(9);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        feed(&mut detector, &noise.samples(2_300, 0.002));
        assert!(detector.silence_ms() > 1_500);
        // 400 ms de tom com a amplitude variando a 4 Hz, como sílabas.
        let mut talk = noise.samples(400, 0.002);
        for (i, sample) in talk.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32;
            let envelope = 0.6 + 0.4 * (2.0 * std::f32::consts::PI * 4.0 * t).sin();
            *sample += 0.05 * envelope * (2.0 * std::f32::consts::PI * 180.0 * t).sin();
        }
        feed(&mut detector, &talk);
        assert_eq!(detector.silence_ms(), 0);
        assert_eq!(detector.stops_in_ms(), None);
    }

    #[test]
    fn ventilador_que_liga_no_meio_vira_piso() {
        let mut noise = Noise(10);
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(4)));
        feed(&mut detector, &speech(&mut noise, 2_000));
        // Ruído estável 10 dB acima do de antes, ligado logo depois da fala.
        let fan = noise.samples(20_000, 0.002 * 10f32.powf(10.0 / 20.0));
        feed(&mut detector, &fan[..RATE * 3]);
        // Logo depois da fala, a histerese segura a voz até o piso subir para o ventilador.
        assert!(
            detector.floor().unwrap() > -50.0,
            "piso em {:?}",
            detector.floor()
        );
        let before = detector.silence_ms();
        assert!(before > 1_000, "silêncio de só {before} ms");
        // Com o piso já no ventilador, o silêncio segue contando sem zerar até a parada.
        let (event, at) = feed(&mut detector, &fan[RATE * 3..]).unwrap();
        assert_eq!(event, VadEvent::Silence);
        let expected = 4_000 - before as usize;
        assert!(at <= expected + 20, "parou em {at} ms, esperado {expected}");
    }

    #[test]
    fn pausas_zeradas_nao_viram_piso() {
        // Um supressor de ruído que zera as pausas: a fala tem de contar mesmo sem ruído de fundo.
        let mut detector = SilenceDetector::new(Some(Duration::from_secs(2)));
        let mut gated = speech(&mut Noise(11), 2_000);
        for (i, sample) in gated.iter_mut().enumerate() {
            if (i * 1000 / RATE) % 300 >= 200 {
                *sample = 0.0;
            }
        }
        feed(&mut detector, &gated);
        assert!(detector.heard_voice());
        let (event, at) = feed(&mut detector, &vec![0.0; RATE * 5]).unwrap();
        assert_eq!(event, VadEvent::Silence);
        // A última rajada acaba em 2 s, junto com o trecho: 300 ms de hangover + 2 s.
        assert!((2_280..=2_320).contains(&at), "parou em {at} ms");
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
