//! Áudio que o sistema está tocando (loopback), por plataforma.

use std::time::Duration;

use anyhow::Result;

use crate::AudioSource;
use crate::ring::RingSource;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

/// O áudio do sistema, como [`AudioSource`].
pub struct SystemSource {
    ring: RingSource,
}

impl SystemSource {
    /// Abre a captura do áudio do sistema e começa a entregar amostras.
    pub fn open() -> Result<Self> {
        Ok(Self {
            ring: open_platform()?,
        })
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn open_platform() -> Result<RingSource> {
    platform::open()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn open_platform() -> Result<RingSource> {
    anyhow::bail!("captura do áudio do sistema não suportada nesta plataforma")
}

impl AudioSource for SystemSource {
    fn sample_rate(&self) -> u32 {
        self.ring.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        self.ring.read(timeout)
    }
}
