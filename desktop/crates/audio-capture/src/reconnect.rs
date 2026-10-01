//! Uma fonte que se reconecta: quando o anel do dispositivo fecha (erro do stream, dispositivo
//! tirado, perfil Bluetooth trocando) ou um seguidor pede a troca, ela solta o anel velho e reabre
//! pelo abridor, numa thread à parte, com espera de 0,5 s dobrando até 5 s, sem desistir enquanto
//! a gravação existir. Enquanto reconecta, entrega silêncio no ritmo do relógio, na última taxa:
//! a faixa não fica para trás, e a duração segue a da reunião.
//! Contrato: docs/standards/code/desktop-gravacao.md §Fontes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::ring::RingSource;
use crate::{AudioSource, SourceState};

const FIRST_WAIT: Duration = Duration::from_millis(500);
const MAX_WAIT: Duration = Duration::from_secs(5);

/// O que abre (ou reabre) o dispositivo e devolve o anel dele.
pub type Opener = Box<dyn FnMut() -> Result<RingSource> + Send>;

/// Uma fonte sobre um abridor, que reabre o dispositivo quando ele cai.
pub struct Reconnecting {
    open: Arc<Mutex<Opener>>,
    current: Option<RingSource>,
    /// A taxa do último anel, usada no silêncio da reconexão.
    rate: u32,
    /// Quando o dispositivo caiu, e quantas amostras de silêncio já saíram desde então.
    lost: Option<(Instant, u64)>,
    /// A reabertura em curso, numa thread à parte.
    pending: Option<Receiver<Result<RingSource>>>,
    next_try: Instant,
    wait: Duration,
    /// Descartes dos anéis já soltos.
    dropped_before: u64,
    /// Ligado por um seguidor quando o dispositivo em uso deve trocar (o padrão do SO mudou).
    switch: Option<Arc<AtomicBool>>,
}

impl Reconnecting {
    /// Abre o dispositivo pela primeira vez; uma falha aqui é erro de quem pediu a gravação.
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

    /// Liga o pedido de troca de um seguidor: quando ele vira `true`, a fonte reabre.
    pub fn with_switch(mut self, switch: Arc<AtomicBool>) -> Self {
        self.switch = Some(switch);
        self
    }

    /// Solta o anel atual numa thread à parte: desmontar um driver que caiu pode demorar, e o
    /// laço de gravação não espera por isso.
    fn release(&mut self) {
        if let Some(ring) = self.current.take() {
            self.dropped_before += ring.dropped_samples();
            let _ = std::thread::Builder::new()
                .name("eclume-solta".into())
                .spawn(move || drop(ring));
        }
    }

    /// O dispositivo caiu: solta o anel e passa a reconectar já.
    fn lose(&mut self, now: Instant) {
        self.release();
        if self.lost.is_none() {
            log::warn!("dispositivo de áudio caiu; tentando reabrir");
            self.lost = Some((now, 0));
        }
        self.wait = FIRST_WAIT;
        self.next_try = now;
    }

    /// Dispara a reabertura numa thread à parte, para o laço de gravação não esperar o driver.
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
            Err(err) => log::warn!("falha ao criar a thread que reabre o dispositivo: {err}"),
        }
    }

    /// Recebe o resultado da reabertura em curso, se já houver.
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
                    log::info!("dispositivo de áudio de volta depois de {:?}", now - since);
                }
                self.wait = FIRST_WAIT;
            }
            Err(err) => {
                log::warn!(
                    "reabrir o dispositivo falhou ({err:#}); de novo em {:?}",
                    self.wait
                );
                self.next_try = now + self.wait;
                self.wait = (self.wait * 2).min(MAX_WAIT);
            }
        }
    }

    /// O silêncio devido desde a queda, na última taxa.
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
            // Troca de dispositivo: reabre já, sem soltar o anel atual até o novo chegar.
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
        // Espera como uma leitura de verdade esperaria, e entrega o silêncio do intervalo.
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

    /// Um abridor roteirizado: cada chamada tira o próximo resultado da fila e entrega o escritor
    /// do anel aberto ao teste.
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
    fn reconnect_entrega_silencio_e_volta_ao_dispositivo() {
        let (opener, writers) = scripted(vec![Ok(16_000), Err("sumiu"), Ok(8_000)]);
        let mut source = Reconnecting::open(opener).unwrap();
        writers.lock().unwrap()[0].push_interleaved(160, 1, |_| 0.5);
        assert_eq!(source.read(Duration::from_millis(10)).unwrap().len(), 160);
        assert_eq!(source.state(), SourceState::Live);

        // O stream do dispositivo cai.
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
        // A primeira reabertura falha; a segunda, 0,5 s depois, volta a 8 kHz.
        assert_eq!(source.state(), SourceState::Live);
        assert_eq!(source.sample_rate(), 8_000);
        let elapsed = started.elapsed().as_secs_f64();
        // Silêncio no ritmo do relógio, a 16 kHz (a última taxa antes da queda).
        let expected = elapsed * 16_000.0;
        assert!(
            (silence as f64) > expected * 0.8 && (silence as f64) <= expected * 1.05,
            "{silence} amostras de silêncio em {elapsed:.2} s"
        );
        writers.lock().unwrap()[1].push_interleaved(80, 1, |_| 0.25);
        let back = source.read(Duration::from_millis(10)).unwrap();
        assert_eq!(back, vec![0.25; 80]);
    }

    #[test]
    fn reconnect_informa_a_queda_e_soma_os_descartes() {
        let (opener, writers) = scripted(vec![Ok(16_000)]);
        let mut source = Reconnecting::open(opener).unwrap();
        // Anel de 4096: 5000 amostras descartam 904.
        writers.lock().unwrap()[0].push_interleaved(5_000, 1, |_| 0.1);
        assert_eq!(source.dropped_samples(), 904);
        writers.lock().unwrap()[0].close();
        while source.read(Duration::ZERO).is_some_and(|c| !c.is_empty()) {}
        let SourceState::Reconnecting { since } = source.state() else {
            panic!("esperava reconectando");
        };
        assert!(since.elapsed() < Duration::from_secs(1));
        assert_eq!(source.dropped_samples(), 904);
    }

    #[test]
    fn reconnect_troca_quando_o_seguidor_pede() {
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
