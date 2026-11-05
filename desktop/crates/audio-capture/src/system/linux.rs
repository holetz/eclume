// Adapted from fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:
// crates/audio-actual/src/speaker/linux.rs
// (MIT, Copyright (c) 2023-present Fastrepl, Inc.; see VENDOR.md and LICENSE in this crate).
// Changes: own ring buffer (`RingWriter`) instead of the async reader, downmix by averaging,
// `tracing` → `log`, pt-BR messages, sink listing and capture of a selected sink.

//! Linux: PipeWire capturing the active (or selected) sink's monitor, with fallback to the
//! Pulse monitor.

use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use libpulse_binding as pulse;
use pipewire as pw;
use pulse::context::{Context as PaContext, FlagSet as ContextFlagSet};
use pulse::mainloop::threaded::Mainloop;
use pulse::sample::{Format, Spec};
use pulse::stream::{FlagSet as StreamFlagSet, Stream as PaStream};
use pw::properties::properties;
use pw::spa::utils::Direction;

use super::{OutputDevice, OutputDevices};
use crate::ring::{self, RingSource, RingWriter};

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const INIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn list_output_devices() -> Result<OutputDevices> {
    with_pulse_context("eclume-lista-saidas", |mainloop, context| {
        let sinks = query_sink_targets(mainloop, context);
        output_devices(sinks, get_default_sink_name(mainloop, context))
    })
    .context("falha ao consultar as saídas de áudio no PipeWire/PulseAudio")
}

fn output_devices(sinks: Vec<SinkTarget>, default: Option<String>) -> OutputDevices {
    let devices = sinks
        .into_iter()
        .map(|sink| OutputDevice {
            id: sink.name,
            name: sink.description,
        })
        .collect();
    OutputDevices { default, devices }
}

pub(super) fn open(target: Option<&str>) -> Result<(RingSource, bool)> {
    // One introspection serves both backends: PipeWire targets the sink, Pulse its monitor.
    // Without it, the requested sink cannot be checked, and capture follows the active output.
    let (sink, fell_back) = with_pulse_context("eclume-lista-sinks", |mainloop, context| {
        choose_sink(mainloop, context, target)
    })
    .unwrap_or((None, target.is_some()));
    if fell_back {
        log::warn!(
            "output {:?} not found; following the active output",
            target.unwrap_or_default()
        );
    }

    let source = match try_pipewire(sink.as_ref().map(|sink| sink.name.clone())) {
        Ok(source) => source,
        Err(pipewire_err) => {
            log::warn!("PipeWire system capture unavailable: {pipewire_err:#}");
            try_pulseaudio(sink.map(|sink| sink.monitor)).map_err(|pulse_err| {
                anyhow::anyhow!(
                    "falha na captura do sistema por PipeWire: {pipewire_err:#}; e por PulseAudio: {pulse_err:#}"
                )
            })?
        }
    };
    Ok((source, fell_back))
}

struct PipeWireUserData {
    format: pw::spa::param::audio::AudioInfoRaw,
    init_tx: Option<std::sync::mpsc::Sender<Result<()>>>,
    writer: RingWriter,
}

fn update_pipewire_initialization(
    init_tx: &mut Option<std::sync::mpsc::Sender<Result<()>>>,
    state: &pw::stream::StreamState,
    sample_rate: u32,
) {
    match state {
        pw::stream::StreamState::Streaming if sample_rate > 0 => {
            if let Some(init_tx) = init_tx.take() {
                log::info!("PipeWire system capture started at {sample_rate} Hz");
                let _ = init_tx.send(Ok(()));
            }
        }
        pw::stream::StreamState::Error(error) => {
            if let Some(init_tx) = init_tx.take() {
                // Initialization failures may still recover through the Pulse fallback.
                let _ = init_tx.send(Err(anyhow::anyhow!(
                    "o stream do PipeWire entrou em erro: {error}"
                )));
            } else {
                log::error!("PipeWire stream error: {error}");
            }
        }
        _ => {}
    }
}

// `None` leaves PipeWire on the default sink.
fn try_pipewire(target: Option<String>) -> Result<RingSource> {
    let (writer, source) = ring::channel(ring::DEFAULT_CAPACITY, DEFAULT_SAMPLE_RATE);
    let closer = writer.closer();
    let (init_tx, init_rx) = std::sync::mpsc::channel();
    let (shutdown_tx, shutdown_rx) = pw::channel::channel::<()>();

    let capture_thread = thread::Builder::new()
        .name("eclume-system-pw".into())
        .spawn(move || {
            let setup_err_tx = init_tx.clone();
            if let Err(error) = pipewire_capture(writer, target, shutdown_rx, init_tx) {
                let _ = setup_err_tx.send(Err(anyhow::anyhow!(error.to_string())));
            }
            closer.close();
        })
        .context("falha ao criar a thread do PipeWire")?;

    match init_rx.recv_timeout(INIT_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = shutdown_tx.send(());
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            return Err(err);
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            let _ = shutdown_tx.send(());
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            anyhow::bail!("tempo esgotado ao iniciar a captura do sistema por PipeWire");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            anyhow::bail!("a captura do sistema por PipeWire parou durante a inicialização");
        }
    }

    Ok(source.on_stop(move || {
        let _ = shutdown_tx.send(());
        let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
    }))
}

fn pipewire_capture(
    writer: RingWriter,
    target: Option<String>,
    shutdown_rx: pw::channel::Receiver<()>,
    init_tx: std::sync::mpsc::Sender<Result<()>>,
) -> Result<()> {
    ensure_pipewire_initialized();

    let mainloop =
        pw::main_loop::MainLoopRc::new(None).context("falha ao criar o main loop do PipeWire")?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .context("falha ao criar o contexto do PipeWire")?;
    let core = context
        .connect(None)
        .context("falha ao conectar ao core do PipeWire")?;

    let mut stream_props = properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Music",
        *pw::keys::STREAM_CAPTURE_SINK => "true",
    };
    if let Some(target) = target {
        log::info!("system capture on sink {target}");
        stream_props.insert("target.object", target);
    }

    let stream = pw::stream::StreamBox::new(&core, "eclume-captura-sistema", stream_props)
        .context("falha ao criar o stream do PipeWire")?;

    let _shutdown = shutdown_rx.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |_| mainloop.quit()
    });

    let _listener = stream
        .add_local_listener_with_user_data(PipeWireUserData {
            format: Default::default(),
            init_tx: Some(init_tx),
            writer,
        })
        .state_changed({
            let mainloop = mainloop.clone();
            move |_, user_data, _old, new| {
                update_pipewire_initialization(
                    &mut user_data.init_tx,
                    &new,
                    user_data.format.rate(),
                );
                if matches!(new, pw::stream::StreamState::Error(_)) {
                    mainloop.quit();
                }
            }
        })
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else {
                return;
            };
            if id != pw::spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = pw::spa::param::format_utils::parse_format(param)
            else {
                return;
            };
            if media_type != pw::spa::param::format::MediaType::Audio
                || media_subtype != pw::spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if user_data.format.parse(param).is_ok() {
                user_data.writer.set_sample_rate(user_data.format.rate());
            }
        })
        .process(|stream, user_data| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];
            let chunk_size = data.chunk().size() as usize;
            let Some(bytes) = data.data() else {
                return;
            };
            let chunk_len = chunk_size.min(bytes.len());
            if chunk_len == 0 {
                return;
            }
            let channels = user_data.format.channels().max(1) as usize;
            user_data
                .writer
                .push_f32le_bytes(&bytes[..chunk_len], channels);
        })
        .register()
        .context("falha ao registrar o listener do stream do PipeWire")?;

    let mut audio_info = pw::spa::param::audio::AudioInfoRaw::new();
    audio_info.set_format(pw::spa::param::audio::AudioFormat::F32LE);
    let format_object = pw::spa::pod::Object {
        type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pw::spa::param::ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };
    let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(format_object),
    )
    .context("falha ao serializar o formato do PipeWire")?
    .0
    .into_inner();
    let mut params =
        [pw::spa::pod::Pod::from_bytes(&values)
            .context("falha ao montar o formato do PipeWire")?];

    stream
        .connect(
            Direction::Input,
            None,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::RT_PROCESS,
            &mut params,
        )
        .context("falha ao conectar o stream de captura do PipeWire")?;

    mainloop.run();
    Ok(())
}

fn ensure_pipewire_initialized() {
    // Capture restarts create a second main loop in the same process; pw_deinit() cannot be safely
    // reversed, so initialize once and leave the library loaded.
    static INIT: Once = Once::new();
    INIT.call_once(pw::init);
}

// `None` captures the default sink's monitor.
fn try_pulseaudio(monitor: Option<String>) -> Result<RingSource> {
    let (writer, source) = ring::channel(ring::DEFAULT_CAPACITY, DEFAULT_SAMPLE_RATE);
    let closer = writer.closer();
    let running = Arc::new(AtomicBool::new(true));
    let (init_tx, init_rx) = std::sync::mpsc::channel();

    let capture_thread = {
        let running = Arc::clone(&running);
        thread::Builder::new()
            .name("eclume-system-pulse".into())
            .spawn(move || {
                pulseaudio_capture_loop(writer, monitor, &running, &init_tx);
                closer.close();
            })
            .context("falha ao criar a thread do PulseAudio")?
    };

    match init_rx.recv_timeout(INIT_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            running.store(false, Ordering::Release);
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            return Err(err);
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            running.store(false, Ordering::Release);
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            anyhow::bail!("tempo esgotado ao iniciar a captura do sistema por PulseAudio");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
            anyhow::bail!("a captura do sistema por PulseAudio parou durante a inicialização");
        }
    }

    Ok(source.on_stop(move || {
        running.store(false, Ordering::Release);
        let _ = crate::join_with_deadline(capture_thread, crate::STOP_DEADLINE);
    }))
}

fn pulseaudio_capture_loop(
    mut writer: RingWriter,
    monitor: Option<String>,
    running: &AtomicBool,
    init_tx: &std::sync::mpsc::Sender<Result<()>>,
) {
    let Some(mut mainloop) = Mainloop::new() else {
        let _ = init_tx.send(Err(anyhow::anyhow!(
            "falha ao criar o mainloop do PulseAudio"
        )));
        return;
    };
    let Some(mut context) = PaContext::new(&mainloop, "eclume-captura-sistema") else {
        let _ = init_tx.send(Err(anyhow::anyhow!(
            "falha ao criar o contexto do PulseAudio"
        )));
        return;
    };
    if context
        .connect(None, ContextFlagSet::NOFLAGS, None)
        .is_err()
    {
        let _ = init_tx.send(Err(anyhow::anyhow!("falha ao conectar ao PulseAudio")));
        return;
    }
    if mainloop.start().is_err() {
        let _ = init_tx.send(Err(anyhow::anyhow!(
            "falha ao iniciar o mainloop do PulseAudio"
        )));
        return;
    }

    let setup_result = (|| -> Result<_> {
        wait_for_context_ready(&mut mainloop, &context)?;

        let spec = Spec {
            format: Format::F32le,
            channels: 1,
            rate: DEFAULT_SAMPLE_RATE,
        };
        if !spec.is_valid() {
            anyhow::bail!("especificação de amostra inválida no PulseAudio");
        }

        let monitor_device = monitor
            .or_else(|| {
                get_default_sink_name(&mut mainloop, &context).map(|name| format!("{name}.monitor"))
            })
            .context("falha ao resolver a fonte monitor do PulseAudio")?;
        log::info!("system capture on monitor {monitor_device}");

        mainloop.lock();
        let stream_result = (|| -> Result<_> {
            let mut stream = PaStream::new(&mut context, "eclume-captura", &spec, None)
                .context("falha ao criar o stream do PulseAudio")?;
            stream
                .connect_record(
                    Some(&monitor_device),
                    None,
                    StreamFlagSet::ADJUST_LATENCY | StreamFlagSet::AUTO_TIMING_UPDATE,
                )
                .map_err(|_| {
                    anyhow::anyhow!("falha ao conectar o stream de gravação do PulseAudio")
                })?;
            Ok(stream)
        })();
        mainloop.unlock();
        let mut stream = stream_result?;

        wait_for_stream_ready(&mut mainloop, &stream)?;

        mainloop.lock();
        let actual_rate = stream
            .get_sample_spec()
            .map_or(DEFAULT_SAMPLE_RATE, |sample_spec| sample_spec.rate);
        mainloop.unlock();

        Ok((stream, actual_rate))
    })();

    let (mut stream, actual_rate) = match setup_result {
        Ok(values) => values,
        Err(err) => {
            let _ = init_tx.send(Err(err));
            mainloop.stop();
            return;
        }
    };

    writer.set_sample_rate(actual_rate);
    log::info!("PulseAudio system capture started at {actual_rate} Hz");
    let _ = init_tx.send(Ok(()));

    while running.load(Ordering::Acquire) {
        mainloop.lock();

        let readable = stream.readable_size().unwrap_or(0);
        if readable == 0 {
            mainloop.unlock();
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        match stream.peek() {
            Ok(pulse::stream::PeekResult::Data(data)) => {
                let bytes = data.to_vec();
                let _ = stream.discard();
                mainloop.unlock();
                writer.push_f32le_bytes(&bytes, 1);
            }
            Ok(pulse::stream::PeekResult::Hole(_)) => {
                let _ = stream.discard();
                mainloop.unlock();
            }
            Ok(pulse::stream::PeekResult::Empty) => {
                mainloop.unlock();
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                mainloop.unlock();
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    mainloop.lock();
    let _ = stream.disconnect();
    mainloop.unlock();
    mainloop.stop();
}

fn wait_for_context_ready(mainloop: &mut Mainloop, context: &PaContext) -> Result<()> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > INIT_TIMEOUT {
            anyhow::bail!("tempo esgotado esperando o contexto do PulseAudio");
        }
        mainloop.lock();
        let state = context.get_state();
        mainloop.unlock();
        match state {
            pulse::context::State::Ready => return Ok(()),
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                anyhow::bail!("o contexto do PulseAudio entrou no estado {state:?}");
            }
            _ => thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn wait_for_stream_ready(mainloop: &mut Mainloop, stream: &PaStream) -> Result<()> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > INIT_TIMEOUT {
            anyhow::bail!("tempo esgotado esperando o stream do PulseAudio");
        }
        mainloop.lock();
        let state = stream.get_state();
        mainloop.unlock();
        match state {
            pulse::stream::State::Ready => return Ok(()),
            pulse::stream::State::Failed | pulse::stream::State::Terminated => {
                anyhow::bail!("o stream do PulseAudio entrou no estado {state:?}");
            }
            _ => thread::sleep(Duration::from_millis(10)),
        }
    }
}

#[derive(Clone, Debug)]
struct SinkTarget {
    index: u32,
    /// The node name: the stable output id and PipeWire's `target.object`.
    name: String,
    /// The name the system shows to the user.
    description: String,
    monitor: String,
}

// On PipeWire systems, this API is served by pipewire-pulse, so one introspection path
// covers both backends.
fn with_pulse_context<T>(
    name: &str,
    query: impl FnOnce(&mut Mainloop, &PaContext) -> T,
) -> Option<T> {
    let mut mainloop = Mainloop::new()?;
    let mut context = PaContext::new(&mainloop, name)?;
    if context
        .connect(None, ContextFlagSet::NOFLAGS, None)
        .is_err()
    {
        return None;
    }
    if mainloop.start().is_err() {
        return None;
    }
    if wait_for_context_ready(&mut mainloop, &context).is_err() {
        mainloop.stop();
        return None;
    }

    let result = query(&mut mainloop, &context);
    mainloop.lock();
    context.disconnect();
    mainloop.unlock();
    mainloop.stop();
    Some(result)
}

fn collect_list<T>(rx: &std::sync::mpsc::Receiver<Option<T>>) -> Vec<T> {
    let mut items = Vec::new();
    let timeout = Duration::from_secs(2);
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Some(item)) => items.push(item),
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    items
}

fn query_sink_targets(mainloop: &mut Mainloop, context: &PaContext) -> Vec<SinkTarget> {
    let (tx, rx) = std::sync::mpsc::channel();

    mainloop.lock();
    let introspector = context.introspect();
    introspector.get_sink_info_list(move |list_result| match list_result {
        pulse::callbacks::ListResult::Item(sink_info) => {
            let Some(name) = sink_info.name.as_ref() else {
                return;
            };
            let monitor = sink_info
                .monitor_source_name
                .as_ref()
                .map_or_else(|| format!("{name}.monitor"), ToString::to_string);
            let description = sink_info
                .description
                .as_ref()
                .filter(|description| !description.is_empty())
                .map_or_else(|| name.to_string(), ToString::to_string);
            let _ = tx.send(Some(SinkTarget {
                index: sink_info.index,
                name: name.to_string(),
                description,
                monitor,
            }));
        }
        pulse::callbacks::ListResult::End | pulse::callbacks::ListResult::Error => {
            let _ = tx.send(None);
        }
    });
    mainloop.unlock();

    collect_list(&rx)
}

// Indices of sinks where another process is currently playing audio.
fn query_sinks_in_use(mainloop: &mut Mainloop, context: &PaContext) -> Vec<u32> {
    let (tx, rx) = std::sync::mpsc::channel();
    let self_pid = std::process::id().to_string();

    mainloop.lock();
    let introspector = context.introspect();
    introspector.get_sink_input_info_list(move |list_result| match list_result {
        pulse::callbacks::ListResult::Item(input) => {
            let foreign = input
                .proplist
                .get_str(pulse::proplist::properties::APPLICATION_PROCESS_ID)
                .is_none_or(|pid| pid != self_pid);
            if !input.corked && foreign {
                let _ = tx.send(Some(input.sink));
            }
        }
        pulse::callbacks::ListResult::End | pulse::callbacks::ListResult::Error => {
            let _ = tx.send(None);
        }
    });
    mainloop.unlock();

    collect_list(&rx)
}

fn choose_sink(
    mainloop: &mut Mainloop,
    context: &PaContext,
    wanted: Option<&str>,
) -> (Option<SinkTarget>, bool) {
    let sinks = query_sink_targets(mainloop, context);
    let in_use = query_sinks_in_use(mainloop, context);
    let default_sink = get_default_sink_name(mainloop, context);
    pick_sink(sinks, wanted, &in_use, default_sink.as_deref())
}

// The selected sink if it still exists; otherwise the active one. The `bool` means it was missing.
fn pick_sink(
    mut sinks: Vec<SinkTarget>,
    wanted: Option<&str>,
    in_use: &[u32],
    default_sink: Option<&str>,
) -> (Option<SinkTarget>, bool) {
    if let Some(position) =
        wanted.and_then(|wanted| sinks.iter().position(|sink| sink.name == wanted))
    {
        return (Some(sinks.swap_remove(position)), false);
    }
    (
        pick_sink_in_use(sinks, in_use, default_sink),
        wanted.is_some(),
    )
}

// Meeting apps often play on a sink other than the default. Follows the sink where another process
// is playing; the default wins ties, so unrelated audio on another sink does not pull capture away
// from a meeting on the default sink. `None` stays on the default.
fn pick_sink_in_use(
    sinks: Vec<SinkTarget>,
    in_use: &[u32],
    default_sink: Option<&str>,
) -> Option<SinkTarget> {
    let mut candidates: Vec<SinkTarget> = sinks
        .into_iter()
        .filter(|sink| in_use.contains(&sink.index))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let default_position = candidates
        .iter()
        .position(|sink| Some(sink.name.as_str()) == default_sink);
    Some(candidates.swap_remove(default_position.unwrap_or(0)))
}

fn get_default_sink_name(mainloop: &mut Mainloop, context: &PaContext) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();

    mainloop.lock();
    let introspector = context.introspect();
    introspector.get_server_info(move |info| {
        let _ = tx.send(info.default_sink_name.as_ref().map(ToString::to_string));
    });
    mainloop.unlock();

    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::{
        OutputDevice, SinkTarget, output_devices, pick_sink, pick_sink_in_use,
        update_pipewire_initialization,
    };
    use pipewire::stream::StreamState;
    use std::sync::mpsc::{self, TryRecvError};

    #[test]
    fn negotiated_format_does_not_hide_pipewire_startup_failure() {
        let (tx, rx) = mpsc::channel();
        let mut init_tx = Some(tx);
        update_pipewire_initialization(&mut init_tx, &StreamState::Paused, 48_000);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

        update_pipewire_initialization(
            &mut init_tx,
            &StreamState::Error("negotiation failed".into()),
            48_000,
        );
        let error = rx.try_recv().unwrap().unwrap_err();
        assert!(error.to_string().contains("negotiation failed"));
    }

    #[test]
    fn pipewire_is_only_ready_when_streaming_with_valid_format() {
        let (tx, rx) = mpsc::channel();
        let mut init_tx = Some(tx);
        update_pipewire_initialization(&mut init_tx, &StreamState::Connecting, 0);
        update_pipewire_initialization(&mut init_tx, &StreamState::Streaming, 0);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

        update_pipewire_initialization(&mut init_tx, &StreamState::Streaming, 48_000);
        assert!(rx.try_recv().unwrap().is_ok());
        update_pipewire_initialization(&mut init_tx, &StreamState::Streaming, 48_000);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Disconnected)));
    }

    fn sink(index: u32, name: &str) -> SinkTarget {
        SinkTarget {
            index,
            name: name.to_string(),
            description: format!("Saída {name}"),
            monitor: format!("{name}.monitor"),
        }
    }

    #[test]
    fn no_sink_in_use_falls_back_to_default() {
        let sinks = vec![sink(1, "builtin"), sink(2, "usb")];
        assert!(pick_sink_in_use(sinks, &[], Some("builtin")).is_none());
    }

    #[test]
    fn follows_only_sink_in_use() {
        let sinks = vec![sink(1, "builtin"), sink(2, "usb")];
        let picked = pick_sink_in_use(sinks, &[2], Some("builtin")).unwrap();
        assert_eq!(picked.name, "usb");
        assert_eq!(picked.monitor, "usb.monitor");
    }

    #[test]
    fn default_wins_when_multiple_sinks_are_in_use() {
        let sinks = vec![sink(1, "hdmi"), sink(2, "builtin"), sink(3, "usb")];
        let picked = pick_sink_in_use(sinks, &[1, 2, 3], Some("builtin")).unwrap();
        assert_eq!(picked.name, "builtin");
    }

    #[test]
    fn selected_output_wins_over_sink_in_use() {
        let sinks = vec![sink(1, "builtin"), sink(2, "usb")];
        let (picked, fell_back) = pick_sink(sinks, Some("builtin"), &[2], Some("builtin"));
        assert_eq!(picked.unwrap().monitor, "builtin.monitor");
        assert!(!fell_back);
    }

    #[test]
    fn missing_selected_output_follows_active_one_and_warns() {
        let sinks = vec![sink(1, "builtin"), sink(2, "usb")];
        let (picked, fell_back) = pick_sink(sinks, Some("fone-bt"), &[2], Some("builtin"));
        assert_eq!(picked.unwrap().name, "usb");
        assert!(fell_back);
    }

    #[test]
    fn following_active_output_is_not_a_fallback() {
        let sinks = vec![sink(1, "builtin"), sink(2, "usb")];
        let (picked, fell_back) = pick_sink(sinks, None, &[], Some("builtin"));
        assert!(picked.is_none());
        assert!(!fell_back);
    }

    #[test]
    fn output_list_uses_sink_name_as_id() {
        let devices = output_devices(
            vec![sink(1, "builtin"), sink(2, "usb")],
            Some("usb".to_string()),
        );
        assert_eq!(devices.default.as_deref(), Some("usb"));
        assert_eq!(
            devices.devices,
            vec![
                OutputDevice {
                    id: "builtin".into(),
                    name: "Saída builtin".into()
                },
                OutputDevice {
                    id: "usb".into(),
                    name: "Saída usb".into()
                },
            ]
        );
    }
}
