//! Mic through the selected input device (or the default), via `cpal`.
//!
//! `cpal::Stream` is not `Send` on every platform, so it lives on its own thread,
//! which keeps it running until the source is dropped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};

use crate::reconnect::{Opener, Reconnecting};
use crate::ring::{self, RingCloser, RingSource, RingWriter};
use crate::{AudioSource, SourceState};

const INIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The microphones currently available: the default name and all device names.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputDevices {
    pub default: Option<String>,
    pub names: Vec<String>,
}

/// Lists input devices by the name shown in the Audio tab and stored in config.
pub fn list_input_devices() -> Result<InputDevices> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| device_name(&d));
    let mut names: Vec<String> = host
        .input_devices()
        .context("falha ao listar os microfones")?
        .filter_map(|d| device_name(&d))
        .collect();
    names.dedup();
    Ok(InputDevices { default, names })
}

fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// How often the follower checks which microphone should be in use.
const FOLLOW_INTERVAL: Duration = Duration::from_secs(2);
/// Consecutive identical readings differing from the active microphone before switching.
const FOLLOW_CONFIRMATIONS: u8 = 2;

/// The mic as an [`AudioSource`]. Reconnects automatically ([`Reconnecting`]): a disconnected
/// device
/// (Bluetooth headset changing profiles, USB unplugged) is reopened, with silence in between. Each
/// attempt resolves the choice again: microphone by name, otherwise the default. A follower
/// checks every 2 s which should be in use (the OS default, or the selected device reappearing)
/// and requests a switch after two consecutive readings.
pub struct MicSource {
    source: Reconnecting,
    /// The requested microphone was missing and capture fell back to the default on opening.
    fell_back: bool,
    /// Stops the follower when the source is dropped.
    following: Arc<AtomicBool>,
}

impl MicSource {
    /// Opens the default input device and starts capturing.
    pub fn open() -> Result<Self> {
        Self::open_named(None)
    }

    /// Opens the microphone named `name` and starts capturing. If missing (a disconnected
    /// headset), falls back to the default with a log warning and [`MicSource::fell_back`].
    pub fn open_named(name: Option<&str>) -> Result<Self> {
        let wanted = name.map(str::to_string);
        let in_use: Arc<Mutex<Option<String>>> = Arc::default();
        let fell_back = Arc::new(AtomicBool::new(false));
        let opener: Opener = {
            let wanted = wanted.clone();
            let in_use = Arc::clone(&in_use);
            let fell_back = Arc::clone(&fell_back);
            Box::new(move || {
                let (ring, used, fallback) = open_ring(wanted.as_deref())?;
                if let Ok(mut in_use) = in_use.lock() {
                    *in_use = used;
                }
                fell_back.store(fallback, Ordering::Release);
                Ok(ring)
            })
        };
        let switch = Arc::new(AtomicBool::new(false));
        let source = Reconnecting::open(opener)?.with_switch(Arc::clone(&switch));
        let following = Arc::new(AtomicBool::new(true));
        spawn_follower(wanted, in_use, switch, Arc::clone(&following));
        Ok(Self {
            source,
            fell_back: fell_back.load(Ordering::Acquire),
            following,
        })
    }

    /// The requested microphone was missing and capture uses the default.
    pub fn fell_back(&self) -> bool {
        self.fell_back
    }
}

impl Drop for MicSource {
    fn drop(&mut self) {
        self.following.store(false, Ordering::Release);
    }
}

impl AudioSource for MicSource {
    fn sample_rate(&self) -> u32 {
        self.source.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        self.source.read(timeout)
    }

    fn state(&self) -> SourceState {
        self.source.state()
    }

    fn dropped_samples(&self) -> u64 {
        self.source.dropped_samples()
    }
}

/// The microphone that should be in use: the selected one if available in the system; otherwise
/// the default.
fn desired(wanted: Option<&str>, devices: &InputDevices) -> Option<String> {
    match wanted {
        Some(name) if devices.names.iter().any(|n| n == name) => Some(name.to_string()),
        _ => devices.default.clone(),
    }
}

/// Requests a switch when the desired microphone differs from the active one for
/// [`FOLLOW_CONFIRMATIONS`] consecutive readings, matching the `EndpointFollower` criterion for
/// system audio on Windows.
#[derive(Default)]
struct Follower {
    pending: Option<(String, u8)>,
}

impl Follower {
    fn observe(&mut self, desired: Option<String>, in_use: Option<&str>) -> bool {
        let Some(desired) = desired.filter(|d| Some(d.as_str()) != in_use) else {
            self.pending = None;
            return false;
        };
        let count = match &self.pending {
            Some((name, count)) if *name == desired => count.saturating_add(1),
            _ => 1,
        };
        if count >= FOLLOW_CONFIRMATIONS {
            self.pending = None;
            true
        } else {
            self.pending = Some((desired, count));
            false
        }
    }
}

fn spawn_follower(
    wanted: Option<String>,
    in_use: Arc<Mutex<Option<String>>>,
    switch: Arc<AtomicBool>,
    following: Arc<AtomicBool>,
) {
    let spawned = std::thread::Builder::new()
        .name("eclume-mic-segue".into())
        .spawn(move || {
            let mut follower = Follower::default();
            while following.load(Ordering::Acquire) {
                std::thread::sleep(FOLLOW_INTERVAL);
                let Ok(devices) = list_input_devices() else {
                    continue;
                };
                let current = in_use.lock().ok().and_then(|n| n.clone());
                if follower.observe(desired(wanted.as_deref(), &devices), current.as_deref()) {
                    log::info!("the active microphone ({current:?}) will switch");
                    switch.store(true, Ordering::Release);
                }
            }
        });
    if let Err(err) = spawned {
        log::warn!("failed to create microphone follower: {err}");
    }
}

/// Opens the microphone on its own thread (`cpal::Stream` is not `Send` on every platform)
/// and returns the ring buffer, the opened device's name and whether it fell back to the default.
fn open_ring(name: Option<&str>) -> Result<(RingSource, Option<String>, bool)> {
    let name = name.map(str::to_string);
    let (init_tx, init_rx) = mpsc::channel::<Result<(u32, Option<String>, bool)>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ring_tx, ring_rx) = mpsc::channel::<RingSource>();

    let thread = std::thread::Builder::new()
        .name("eclume-mic".into())
        .spawn(move || {
            let started = start_input(name.as_deref());
            let (stream, source, used, fell_back) = match started {
                Ok(opened) => opened,
                Err(err) => {
                    let _ = init_tx.send(Err(err));
                    return;
                }
            };
            let rate = source.sample_rate();
            let _ = ring_tx.send(source);
            let _ = init_tx.send(Ok((rate, used, fell_back)));
            // Keeps the stream alive until the source is dropped.
            let _ = stop_rx.recv();
            drop(stream);
        })
        .context("falha ao criar a thread do mic")?;

    match init_rx.recv_timeout(INIT_TIMEOUT) {
        Ok(Ok((rate, used, fell_back))) => {
            let ring = ring_rx
                .recv()
                .map_err(|_| anyhow!("a thread do mic terminou antes de entregar a fonte"))?
                .on_stop(move || {
                    let _ = stop_tx.send(());
                    let _ = crate::join_with_deadline(thread, crate::STOP_DEADLINE);
                });
            log::info!("mic {used:?} opened at {rate} Hz");
            Ok((ring, used, fell_back))
        }
        Ok(Err(err)) => {
            let _ = crate::join_with_deadline(thread, crate::STOP_DEADLINE);
            Err(err)
        }
        Err(_) => {
            // No join: the thread is still stuck in the driver; the stop signal stays queued.
            let _ = stop_tx.send(());
            Err(anyhow!("tempo esgotado ao abrir o mic"))
        }
    }
}

fn start_input(name: Option<&str>) -> Result<(cpal::Stream, RingSource, Option<String>, bool)> {
    let host = cpal::default_host();
    let named = name.and_then(|wanted| {
        host.input_devices()
            .ok()?
            .find(|d| device_name(d).as_deref() == Some(wanted))
    });
    let fell_back = name.is_some() && named.is_none();
    if fell_back {
        log::warn!(
            "microphone {:?} not found; using the default",
            name.unwrap_or_default()
        );
    }
    let device = match named {
        Some(device) => device,
        None => host
            .default_input_device()
            .ok_or_else(|| anyhow!("nenhum dispositivo de entrada (mic) disponível"))?,
    };
    let config = device
        .default_input_config()
        .context("o mic não informou uma configuração padrão")?;

    let (writer, source) = ring::channel(ring::DEFAULT_CAPACITY, config.sample_rate());
    let closer = writer.closer();
    let stream_config = config.config();
    let channels = usize::from(config.channels());

    let stream = match config.sample_format() {
        cpal::SampleFormat::I8 => build::<i8>(&device, &stream_config, channels, writer, closer),
        cpal::SampleFormat::I16 => build::<i16>(&device, &stream_config, channels, writer, closer),
        cpal::SampleFormat::I32 => build::<i32>(&device, &stream_config, channels, writer, closer),
        cpal::SampleFormat::U16 => build::<u16>(&device, &stream_config, channels, writer, closer),
        cpal::SampleFormat::F32 => build::<f32>(&device, &stream_config, channels, writer, closer),
        cpal::SampleFormat::F64 => build::<f64>(&device, &stream_config, channels, writer, closer),
        other => {
            return Err(anyhow!(
                "formato de amostra do mic não suportado: {other:?}"
            ));
        }
    }
    .context("falha ao montar o stream do mic")?;

    stream.play().context("falha ao iniciar o stream do mic")?;
    Ok((stream, source, device_name(&device), fell_back))
}

fn build<S>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    mut writer: RingWriter,
    closer: RingCloser,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    S: SizedSample,
    f32: FromSample<S>,
{
    device.build_input_stream::<S, _, _>(
        config,
        move |data: &[S], _info: &cpal::InputCallbackInfo| {
            let frames = data.len() / channels.max(1);
            writer.push_interleaved(frames, channels, |i| f32::from_sample_(data[i]));
        },
        move |err| {
            log::error!("mic stream error: {err}");
            closer.close();
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devices(default: &str, names: &[&str]) -> InputDevices {
        InputDevices {
            default: Some(default.into()),
            names: names.iter().map(|n| (*n).to_string()).collect(),
        }
    }

    #[test]
    fn follower_switches_after_two_consecutive_readings() {
        let mut follower = Follower::default();
        let now = devices("Headset", &["Headset", "Interno"]);
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
        assert!(follower.observe(desired(None, &now), Some("Interno")));
        // A single differing reading does not trigger a switch.
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
        assert!(!follower.observe(Some("Interno".into()), Some("Interno")));
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
    }

    #[test]
    fn follower_returns_to_selected_device_when_it_reappears() {
        let mut follower = Follower::default();
        let without = devices("Interno", &["Interno"]);
        assert_eq!(desired(Some("USB"), &without).as_deref(), Some("Interno"));
        assert!(!follower.observe(desired(Some("USB"), &without), Some("Interno")));
        let with = devices("Interno", &["Interno", "USB"]);
        assert!(!follower.observe(desired(Some("USB"), &with), Some("Interno")));
        assert!(follower.observe(desired(Some("USB"), &with), Some("Interno")));
    }
}
