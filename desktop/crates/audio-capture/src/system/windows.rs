// Adapted from fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:
// crates/audio-actual/src/speaker/windows.rs
// (MIT, Copyright (c) 2023-present Fastrepl, Inc.; see VENDOR.md and LICENSE in this crate).
// Changes: own ring buffer (`RingWriter`) instead of the async reader, downmix by averaging,
// `tracing` → `log`, pt-BR messages, endpoint listing and loopback on a selected endpoint.

//! Windows: WASAPI loopback of the active output endpoint or one selected by id.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use wasapi::{
    AudioCaptureClient, AudioClient, Device, DeviceEnumerator, Direction, Handle, SampleType,
    SessionState, StreamMode, WaveFormat, initialize_mta,
};

use super::{OutputDevice, OutputDevices};
use crate::ring::{self, RingSource, RingWriter};

const DEFAULT_SAMPLE_RATE: u32 = 44_100;
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
const ENDPOINT_POLL_INTERVAL: Duration = Duration::from_secs(2);
// A meeting app may start playing on another endpoint after capture begins. Requiring two
// consecutive readings prevents an isolated system sound from making capture jump endpoints.
const ENDPOINT_SWITCH_CONFIRMATIONS: u8 = 2;

pub(super) fn list_output_devices() -> Result<OutputDevices> {
    // COM is per thread and the caller's thread may already be in an STA apartment.
    let handle = thread::Builder::new()
        .name("eclume-lista-saidas".into())
        .spawn(|| -> Result<OutputDevices> {
            initialize_mta()
                .ok()
                .context("falha ao inicializar o apartamento COM do WASAPI")?;
            let enumerator = DeviceEnumerator::new()
                .context("falha ao criar o enumerador de dispositivos WASAPI")?;
            let default = enumerator
                .get_default_device(&Direction::Render)
                .and_then(|device| device.get_id())
                .ok();
            let collection = enumerator
                .get_device_collection(&Direction::Render)
                .context("falha ao listar as saídas de áudio")?;
            let devices = collection
                .into_iter()
                .filter_map(Result::ok)
                .filter_map(|device| {
                    let id = device.get_id().ok()?;
                    let name = device.get_friendlyname().unwrap_or_else(|_| id.clone());
                    Some(OutputDevice { id, name })
                })
                .collect();
            Ok(OutputDevices { default, devices })
        })
        .context("falha ao criar a thread da lista de saídas")?;
    crate::join_with_deadline(handle, crate::STOP_DEADLINE)
        .ok_or_else(|| anyhow::anyhow!("tempo esgotado ao listar as saídas de áudio"))?
        .map_err(|_| anyhow::anyhow!("a thread da lista de saídas entrou em pânico"))?
}

pub(super) fn open(target: Option<&str>) -> Result<(RingSource, bool)> {
    let target = target.map(str::to_string);
    let (writer, source) = ring::channel(ring::DEFAULT_CAPACITY, DEFAULT_SAMPLE_RATE);
    let closer = writer.closer();
    let running = Arc::new(AtomicBool::new(true));
    let (init_tx, init_rx) = std::sync::mpsc::channel();

    let capture_thread = {
        let running = Arc::clone(&running);
        thread::Builder::new()
            .name("eclume-system-wasapi".into())
            .spawn(move || {
                if let Err(err) = capture_audio_loop(writer, target.as_deref(), &running, &init_tx)
                {
                    log::error!("WASAPI capture loop failed: {err:#}");
                }
                closer.close();
            })
            .context("falha ao criar a thread do WASAPI")?
    };

    let fell_back = match init_rx.recv_timeout(INIT_TIMEOUT) {
        Ok(Ok(fell_back)) => fell_back,
        Ok(Err(err)) => {
            running.store(false, Ordering::Release);
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            return Err(err);
        }
        Err(_) => {
            running.store(false, Ordering::Release);
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            anyhow::bail!("tempo esgotado ao iniciar o loopback WASAPI");
        }
    };

    let source = source.on_stop(move || {
        running.store(false, Ordering::Release);
        let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
    });
    Ok((source, fell_back))
}

#[derive(Clone, Copy)]
struct WasapiCaptureFormat {
    sample_rate: u32,
    channels: usize,
    sample_type: SampleType,
    bits_per_sample: u16,
}

struct LoopbackCapture {
    audio_client: AudioClient,
    event: Handle,
    capture_client: AudioCaptureClient,
    format: WasapiCaptureFormat,
    device_id: String,
    device_name: Option<String>,
}

// Tracks which endpoint `open_render_device` would choose and reports a switch when the choice
// differs from the captured endpoint for `ENDPOINT_SWITCH_CONFIRMATIONS` readings.
struct EndpointFollower {
    current: String,
    pending: Option<(String, u8)>,
}

impl EndpointFollower {
    fn new(current: String) -> Self {
        Self {
            current,
            pending: None,
        }
    }

    fn observe(&mut self, observed: String) -> Option<String> {
        if observed == self.current {
            self.pending = None;
            return None;
        }
        let count = match &self.pending {
            Some((id, count)) if *id == observed => count.saturating_add(1),
            _ => 1,
        };
        if count >= ENDPOINT_SWITCH_CONFIRMATIONS {
            self.pending = None;
            Some(observed)
        } else {
            self.pending = Some((observed, count));
            None
        }
    }

    fn reset(&mut self) {
        self.pending = None;
    }
}

fn capture_audio_loop(
    mut writer: RingWriter,
    target: Option<&str>,
    running: &AtomicBool,
    init_tx: &std::sync::mpsc::Sender<Result<bool>>,
) -> Result<()> {
    let setup_result = (|| -> Result<_> {
        initialize_mta()
            .ok()
            .context("falha ao inicializar o apartamento COM do WASAPI")?;
        let enumerator = DeviceEnumerator::new()
            .context("falha ao criar o enumerador de dispositivos WASAPI")?;
        let chosen = target.and_then(|id| find_render_device(&enumerator, id));
        let fell_back = target.is_some() && chosen.is_none();
        if fell_back {
            log::warn!(
                "output {:?} not found; following the active output",
                target.unwrap_or_default()
            );
        }
        // With a selected (and present) output, capture stays there instead of following the active
        // one.
        let follow = chosen.is_none();
        let device = match chosen {
            Some(device) => device,
            None => open_render_device(&enumerator)?,
        };
        let capture = open_loopback_capture(device)?;
        Ok((enumerator, capture, follow, fell_back))
    })();

    let (enumerator, mut capture, follow, fell_back) = match setup_result {
        Ok(values) => values,
        Err(err) => {
            let _ = init_tx.send(Err(anyhow::anyhow!(err.to_string())));
            return Err(err);
        }
    };

    // Every endpoint opens at DEFAULT_SAMPLE_RATE with WASAPI autoconvert, so the published rate
    // does not change between endpoint switches.
    writer.set_sample_rate(capture.format.sample_rate);
    log::info!(
        "WASAPI loopback started at {} Hz on {:?}",
        capture.format.sample_rate,
        capture.device_name
    );
    let _ = init_tx.send(Ok(fell_back));

    let mut follower = EndpointFollower::new(capture.device_id.clone());
    let mut next_endpoint_poll = Instant::now() + ENDPOINT_POLL_INTERVAL;
    let mut temp_queue = VecDeque::new();

    while running.load(Ordering::Acquire) {
        if follow && Instant::now() >= next_endpoint_poll {
            next_endpoint_poll = Instant::now() + ENDPOINT_POLL_INTERVAL;
            if let Some(device) = poll_render_endpoint_switch(&enumerator, &mut follower) {
                match open_loopback_capture(device) {
                    Ok(next) => {
                        let _ = capture.audio_client.stop_stream();
                        capture = next;
                        follower = EndpointFollower::new(capture.device_id.clone());
                        log::info!("WASAPI loopback switched to {:?}", capture.device_name);
                    }
                    Err(err) => {
                        log::warn!("WASAPI endpoint switch failed, keeping current: {err:#}");
                    }
                }
            }
        }

        if capture.event.wait_for_event(250).is_err() {
            continue;
        }

        temp_queue.clear();
        drain_packets(&capture.capture_client, &mut temp_queue);
        if temp_queue.is_empty() {
            continue;
        }
        push_wasapi_bytes(temp_queue.make_contiguous(), capture.format, &mut writer)?;
    }

    let _ = capture.audio_client.stop_stream();
    Ok(())
}

fn poll_render_endpoint_switch(
    enumerator: &DeviceEnumerator,
    follower: &mut EndpointFollower,
) -> Option<Device> {
    let Ok(device) = open_render_device(enumerator) else {
        follower.reset();
        return None;
    };
    let Ok(device_id) = device.get_id() else {
        follower.reset();
        return None;
    };
    follower.observe(device_id).map(|_| device)
}

fn open_loopback_capture(device: Device) -> Result<LoopbackCapture> {
    let device_id = device
        .get_id()
        .context("falha ao obter o id do dispositivo de saída WASAPI")?;
    let device_name = device.get_friendlyname().ok();
    let (mut audio_client, accepted_format, buffer_duration_hns) =
        open_endpoint_loopback_client(&device)?;

    let format = WasapiCaptureFormat {
        sample_rate: accepted_format.get_samplespersec(),
        channels: accepted_format.get_nchannels() as usize,
        sample_type: accepted_format
            .get_subformat()
            .context("tipo de amostra WASAPI não suportado")?,
        bits_per_sample: accepted_format.get_bitspersample(),
    };
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns,
    };

    audio_client
        .initialize_client(&accepted_format, &Direction::Capture, &mode)
        .context("falha ao inicializar o cliente de loopback WASAPI")?;
    if format.sample_rate != DEFAULT_SAMPLE_RATE {
        anyhow::bail!(
            "o loopback WASAPI não aceitou {DEFAULT_SAMPLE_RATE} Hz (veio {})",
            format.sample_rate
        );
    }

    let event = audio_client
        .set_get_eventhandle()
        .context("falha ao criar o event handle do WASAPI")?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .context("falha ao obter o capture client do WASAPI")?;
    audio_client
        .start_stream()
        .context("falha ao iniciar o stream de loopback WASAPI")?;

    Ok(LoopbackCapture {
        audio_client,
        event,
        capture_client,
        format,
        device_id,
        device_name,
    })
}

fn open_endpoint_loopback_client(device: &Device) -> Result<(AudioClient, WaveFormat, i64)> {
    let audio_client = device
        .get_iaudioclient()
        .context("falha ao obter o IAudioClient")?;
    let mix_format = audio_client
        .get_mixformat()
        .context("falha ao obter o mix format do WASAPI")?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        DEFAULT_SAMPLE_RATE as usize,
        mix_format.get_nchannels() as usize,
        Some(mix_format.get_dwchannelmask()),
    );
    let (_default_period, min_period) = audio_client
        .get_device_period()
        .context("falha ao obter o período do dispositivo WASAPI")?;
    Ok((audio_client, desired_format, min_period))
}

fn drain_packets(capture_client: &AudioCaptureClient, queue: &mut VecDeque<u8>) {
    loop {
        match capture_client.get_next_packet_size() {
            Ok(Some(frames)) if frames > 0 => {
                if let Err(err) = capture_client.read_from_device_to_deque(queue) {
                    log::error!("failed to read WASAPI audio: {err}");
                    return;
                }
            }
            Ok(_) => return,
            Err(err) => {
                log::error!("failed to query WASAPI packet size: {err}");
                return;
            }
        }
    }
}

// Only active endpoints: a disconnected or disabled one counts as missing.
fn find_render_device(enumerator: &DeviceEnumerator, id: &str) -> Option<Device> {
    let collection = enumerator.get_device_collection(&Direction::Render).ok()?;
    collection
        .into_iter()
        .filter_map(Result::ok)
        .find(|device| device.get_id().is_ok_and(|device_id| device_id == id))
}

fn open_render_device(enumerator: &DeviceEnumerator) -> Result<Device> {
    let default = enumerator
        .get_default_device(&Direction::Render)
        .context("falha ao obter o dispositivo de saída padrão")?;
    Ok(render_device_in_use(enumerator, &default).unwrap_or(default))
}

// Meeting apps often play on an endpoint other than the default. When another process plays
// somewhere, follow it; the default wins ties.
fn render_device_in_use(enumerator: &DeviceEnumerator, default: &Device) -> Option<Device> {
    if has_foreign_active_session(default) {
        return None;
    }
    let collection = enumerator.get_device_collection(&Direction::Render).ok()?;
    collection
        .into_iter()
        .filter_map(Result::ok)
        .find(has_foreign_active_session)
}

fn has_foreign_active_session(device: &Device) -> bool {
    let self_pid = std::process::id();
    let Ok(manager) = device.get_iaudiosessionmanager() else {
        return false;
    };
    let Ok(sessions) = manager.get_audiosessionenumerator() else {
        return false;
    };
    let Ok(count) = sessions.get_count() else {
        return false;
    };
    (0..count).any(|index| {
        sessions.get_session(index).ok().is_some_and(|session| {
            session.get_state().ok() == Some(SessionState::Active)
                && session
                    .get_process_id()
                    .ok()
                    .is_some_and(|pid| pid != 0 && pid != self_pid)
        })
    })
}

fn push_wasapi_bytes(
    data: &[u8],
    format: WasapiCaptureFormat,
    writer: &mut RingWriter,
) -> Result<()> {
    let channels = format.channels.max(1);
    match (format.sample_type, format.bits_per_sample) {
        (SampleType::Float, 32) => writer.push_f32le_bytes(data, channels),
        (SampleType::Int, 16) => {
            let frames = data.len() / (channels * 2);
            writer.push_interleaved(frames, channels, |i| {
                f32::from(i16::from_le_bytes([data[i * 2], data[i * 2 + 1]])) / 32_768.0
            });
        }
        (SampleType::Int, 32) => {
            let frames = data.len() / (channels * 4);
            writer.push_interleaved(frames, channels, |i| {
                let at = i * 4;
                i32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as f32
                    / 2_147_483_648.0
            });
        }
        (sample_type, bits) => {
            anyhow::bail!("formato de captura WASAPI não suportado: {sample_type:?} {bits} bits")
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follower_ignores_unchanged_endpoint() {
        let mut follower = EndpointFollower::new("speakers".into());
        assert_eq!(follower.observe("speakers".into()), None);
        assert_eq!(follower.observe("speakers".into()), None);
    }

    #[test]
    fn follower_switches_after_consecutive_confirmations() {
        let mut follower = EndpointFollower::new("speakers".into());
        assert_eq!(follower.observe("headset".into()), None);
        assert_eq!(
            follower.observe("headset".into()),
            Some("headset".to_string())
        );
    }

    #[test]
    fn follower_resets_on_isolated_change() {
        let mut follower = EndpointFollower::new("speakers".into());
        assert_eq!(follower.observe("headset".into()), None);
        assert_eq!(follower.observe("speakers".into()), None);
        assert_eq!(follower.observe("headset".into()), None);
        assert_eq!(
            follower.observe("headset".into()),
            Some("headset".to_string())
        );
    }
}
