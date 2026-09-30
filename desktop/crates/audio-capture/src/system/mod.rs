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

/// Uma saída de áudio: o id estável que a config guarda e o nome que a aba Áudio mostra.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

/// As saídas que o sistema oferece agora e o id da padrão.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OutputDevices {
    pub default: Option<String>,
    pub devices: Vec<OutputDevice>,
}

/// Lista as saídas cujo áudio dá para capturar: no Linux, os sinks do PipeWire/Pulse pelo nome
/// do nó; no Windows, os endpoints de reprodução ativos pelo id. No macOS a lista vem vazia: o
/// process tap só segue a saída em uso.
pub fn list_output_devices() -> Result<OutputDevices> {
    platform_list()
}

/// O áudio do sistema, como [`AudioSource`].
pub struct SystemSource {
    ring: RingSource,
    /// A saída pedida sumiu e a captura voltou a seguir a saída em uso.
    fell_back: bool,
}

impl SystemSource {
    /// Abre a captura do áudio que toca na saída de id `target` (ver [`list_output_devices`]);
    /// `None` segue a saída em uso. Se a saída pedida sumiu, segue a em uso com um aviso no log
    /// e em [`SystemSource::fell_back`].
    pub fn open_target(target: Option<&str>) -> Result<Self> {
        let (ring, fell_back) = platform_open(target)?;
        Ok(Self { ring, fell_back })
    }

    /// A saída pedida não estava lá e a captura segue a saída em uso.
    pub fn fell_back(&self) -> bool {
        self.fell_back
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn platform_open(target: Option<&str>) -> Result<(RingSource, bool)> {
    platform::open(target)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn platform_list() -> Result<OutputDevices> {
    platform::list_output_devices()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_open(_target: Option<&str>) -> Result<(RingSource, bool)> {
    anyhow::bail!("captura do áudio do sistema não suportada nesta plataforma")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_list() -> Result<OutputDevices> {
    Ok(OutputDevices::default())
}

impl AudioSource for SystemSource {
    fn sample_rate(&self) -> u32 {
        self.ring.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        self.ring.read(timeout)
    }
}
