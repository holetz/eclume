//! Captura de áudio do app desktop do eclume.
//!
//! Duas fontes, cada uma entregando amostras mono `f32` na taxa nativa do dispositivo:
//!
//! - [`MicSource`]: o dispositivo de entrada escolhido ou o padrão, por `cpal`
//!   ([`list_input_devices`] lista os nomes);
//! - [`SystemSource`]: o áudio que o sistema está tocando (loopback), por plataforma —
//!   PipeWire/Pulse no Linux, WASAPI no Windows, Core Audio tap no macOS; segue a saída em uso
//!   ou uma saída escolhida ([`list_output_devices`] lista os ids).
//!
//! Quem consome as fontes só conhece o trait [`AudioSource`]; sem a feature `backends`, o crate
//! expõe apenas o trait e o anel ([`ring`]), sem nenhuma dependência de sistema. A feature `mic`
//! liga só o [`MicSource`] (o app móvel).

use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub mod ring;

#[cfg(feature = "mic")]
mod mic;
#[cfg(feature = "backends")]
mod system;

#[cfg(feature = "mic")]
pub use mic::{InputDevices, MicSource, list_input_devices};
#[cfg(feature = "backends")]
pub use system::{OutputDevice, OutputDevices, SystemSource, list_output_devices};

/// Uma fonte de áudio mono que o gravador lê por puxada.
pub trait AudioSource: Send {
    /// Taxa atual, em Hz. Pode mudar durante a captura (troca de dispositivo); o consumidor deve
    /// consultá-la a cada leitura.
    fn sample_rate(&self) -> u32;

    /// Espera até `timeout` por amostras e devolve as que houver.
    ///
    /// `Some(vec![])` significa que o prazo venceu sem amostras (a fonte segue viva, por exemplo
    /// um monitor de sink suspenso). `None` significa que a fonte terminou e não vai entregar mais
    /// nada.
    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>>;
}

impl<T: AudioSource + ?Sized> AudioSource for Box<T> {
    fn sample_rate(&self) -> u32 {
        (**self).sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        (**self).read(timeout)
    }
}

/// Quanto a parada espera, no máximo, pela thread de captura (o driver soltar o dispositivo).
pub const STOP_DEADLINE: Duration = Duration::from_secs(3);

/// Espera a thread terminar até `deadline`. Vencido o prazo (um driver preso ao soltar o
/// dispositivo), registra o aviso no log, solta a thread e devolve `None`; a parada não espera
/// sem prazo.
pub fn join_with_deadline<T>(
    handle: JoinHandle<T>,
    deadline: Duration,
) -> Option<std::thread::Result<T>> {
    let until = Instant::now() + deadline;
    while !handle.is_finished() {
        if Instant::now() >= until {
            log::warn!(
                "a thread {} não terminou em {deadline:?}; seguindo sem ela",
                handle.thread().name().unwrap_or("de captura")
            );
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Some(handle.join())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_com_prazo_solta_a_thread_presa() {
        let stuck = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(10)));
        let started = Instant::now();
        assert!(join_with_deadline(stuck, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn join_com_prazo_devolve_o_resultado_da_thread() {
        let done = std::thread::spawn(|| 42);
        assert_eq!(
            join_with_deadline(done, STOP_DEADLINE).map(Result::unwrap),
            Some(42)
        );
    }
}
