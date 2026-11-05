// Adapted from fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:
// crates/audio-actual/src/speaker/macos.rs
// (MIT, Copyright (c) 2023-present Fastrepl, Inc.; see VENDOR.md and LICENSE in this crate).
// Changes: own ring buffer (`RingWriter`) instead of the async reader, local sample
// conversions, `tracing` → `log`, pt-BR messages.

//! macOS: global Core Audio process tap (mono) exposed through a private aggregate device.
//! Requires macOS 14.2+ and system audio recording permission.

use anyhow::{Context, Result};
use cidre::core_audio::aggregate_device_keys as agg_keys;
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};

use super::OutputDevices;
use crate::ring::{self, RingSource, RingWriter};

const TAP_DEVICE_NAME: &str = "eclume-tap-sistema";

struct Ctx {
    common_format: av::audio::CommonFormat,
    writer: RingWriter,
}

/// What must stay alive while capture runs.
struct Running {
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
}

// Core Audio handles are only touched on drop, and the IO callback only uses `Ctx`.
unsafe impl Send for Running {}

// The global tap captures the active output; selecting an output would require a per-device tap,
// which eclume does not yet have.
pub(super) fn list_output_devices() -> Result<OutputDevices> {
    Ok(OutputDevices::default())
}

pub(super) fn open(target: Option<&str>) -> Result<(RingSource, bool)> {
    if let Some(target) = target {
        log::warn!("output {target:?} ignored: capture on macOS follows the active output");
    }
    Ok((open_tap()?, false))
}

fn open_tap() -> Result<RingSource> {
    let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc
        .create_process_tap()
        .context("falha ao criar o process tap do Core Audio")?;
    let tap_uid = tap.uid().context("falha ao obter o uid do tap")?;
    let asbd = tap.asbd().context("falha ao obter o formato do tap")?;

    let sub_tap =
        cf::DictionaryOf::with_keys_values(&[ca::sub_device_keys::uid()], &[tap_uid.as_type_ref()]);
    let agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>> =
        cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::uid(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::String::from_str(TAP_DEVICE_NAME).as_ref(),
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

    let format =
        av::AudioFormat::with_asbd(&asbd).context("formato do áudio do sistema não suportado")?;
    let sample_rate = asbd.sample_rate as u32;
    let (writer, source) = ring::channel(ring::DEFAULT_CAPACITY, sample_rate);
    let mut ctx = Box::new(Ctx {
        common_format: format.common_format(),
        writer,
    });

    let agg_device = ca::AggregateDevice::with_desc(&agg_desc)
        .context("falha ao criar o aggregate device do tap")?;
    let proc_id = agg_device
        .create_io_proc_id(proc, Some(&mut ctx))
        .context("falha ao registrar o IO proc do tap")?;
    let device = ca::device_start(agg_device, Some(proc_id))
        .context("falha ao iniciar o aggregate device do tap")?;
    log::info!("Core Audio tap system capture started at {sample_rate} Hz");

    let running = Running {
        _device: device,
        _ctx: ctx,
        _tap: tap,
    };
    Ok(source.on_stop(move || drop(running)))
}

extern "C" fn proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let Some(ctx) = ctx else {
        return os::Status::NO_ERR;
    };
    let buffer = &input_data.buffers[0];
    match ctx.common_format {
        av::audio::CommonFormat::PcmF32 => push::<f32>(ctx, buffer, |s| s),
        av::audio::CommonFormat::PcmF64 => push::<f64>(ctx, buffer, |s| s as f32),
        av::audio::CommonFormat::PcmI32 => push::<i32>(ctx, buffer, |s| s as f32 / 2_147_483_648.0),
        av::audio::CommonFormat::PcmI16 => push::<i16>(ctx, buffer, |s| f32::from(s) / 32_768.0),
        _ => {}
    }
    os::Status::NO_ERR
}

fn push<T: Copy>(ctx: &mut Ctx, buffer: &cat::AudioBuf, convert: impl Fn(T) -> f32) {
    let Some(samples) = read_samples::<T>(buffer) else {
        return;
    };
    // The tap is mono: one channel per frame.
    ctx.writer
        .push_interleaved(samples.len(), 1, |i| convert(samples[i]));
}

fn read_samples<T: Copy>(buffer: &cat::AudioBuf) -> Option<&[T]> {
    let byte_count = buffer.data_bytes_size as usize;
    if byte_count == 0 || buffer.data.is_null() {
        return None;
    }
    let data = buffer.data as *const T;
    if !(data as usize).is_multiple_of(std::mem::align_of::<T>()) {
        return None;
    }
    let sample_count = byte_count / std::mem::size_of::<T>();
    if sample_count == 0 {
        return None;
    }
    // SAFETY: Core Audio guarantees `data_bytes_size` valid bytes at `data` during the callback,
    // and alignment was checked above.
    Some(unsafe { std::slice::from_raw_parts(data, sample_count) })
}
