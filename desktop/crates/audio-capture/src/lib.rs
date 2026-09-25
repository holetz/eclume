//! Captura de áudio do app desktop do eclume.
//!
//! Duas fontes, cada uma entregando amostras mono `f32` na taxa nativa do dispositivo:
//!
//! - [`MicSource`]: o dispositivo de entrada padrão, por `cpal`;
//! - [`SystemSource`]: o áudio que o sistema está tocando (loopback), por plataforma —
//!   PipeWire/Pulse no Linux, WASAPI no Windows, Core Audio tap no macOS.
//!
//! Quem consome as fontes só conhece o trait [`AudioSource`]; sem a feature `backends`, o crate
//! expõe apenas o trait e o anel ([`ring`]), sem nenhuma dependência de sistema.

use std::time::Duration;

pub mod ring;

#[cfg(feature = "backends")]
mod mic;
#[cfg(feature = "backends")]
mod system;

#[cfg(feature = "backends")]
pub use mic::MicSource;
#[cfg(feature = "backends")]
pub use system::SystemSource;

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
