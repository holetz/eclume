//! Audio the system is playing (loopback), per platform.

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

/// An audio output: the stable id stored in config and the name shown in the Audio tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

/// The outputs currently available and the default output's id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OutputDevices {
    pub default: Option<String>,
    pub devices: Vec<OutputDevice>,
}

/// Lists outputs whose audio can be captured: PipeWire/Pulse sinks by node name on Linux;
/// active playback endpoints by id on Windows. On macOS the list is empty: the
/// process tap only follows the active output.
pub fn list_output_devices() -> Result<OutputDevices> {
    platform_list()
}

/// System audio as an [`AudioSource`].
pub struct SystemSource {
    ring: RingSource,
    /// The requested output was missing and capture resumed following the active output.
    fell_back: bool,
}

impl SystemSource {
    /// Opens capture of audio playing on output id `target` (see [`list_output_devices`]);
    /// `None` follows the active output. If the requested output is missing, follows the active one
    /// with a log warning and [`SystemSource::fell_back`].
    pub fn open_target(target: Option<&str>) -> Result<Self> {
        let (ring, fell_back) = platform_open(target)?;
        Ok(Self { ring, fell_back })
    }

    /// The requested output was missing and capture follows the active output.
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
