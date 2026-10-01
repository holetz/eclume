//! Mic pelo dispositivo de entrada escolhido (ou o padrão), via `cpal`.
//!
//! O `cpal::Stream` não é `Send` em todas as plataformas, então ele vive numa thread própria,
//! que o mantém tocando até a fonte ser descartada.

use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};

use crate::AudioSource;
use crate::ring::{self, RingCloser, RingSource, RingWriter};

const INIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Os microfones que o sistema oferece agora: o nome do padrão e os nomes de todos.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputDevices {
    pub default: Option<String>,
    pub names: Vec<String>,
}

/// Lista os dispositivos de entrada pelo nome que a aba Áudio mostra e a config guarda.
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

/// O mic, como [`AudioSource`].
pub struct MicSource {
    ring: RingSource,
    /// O microfone pedido sumiu e a captura caiu no padrão.
    fell_back: bool,
}

impl MicSource {
    /// Abre o dispositivo de entrada padrão e começa a capturar.
    pub fn open() -> Result<Self> {
        Self::open_named(None)
    }

    /// Abre o microfone de nome `name` e começa a capturar. Se ele sumiu (um headset
    /// desconectado), cai no padrão com um aviso no log e em [`MicSource::fell_back`].
    pub fn open_named(name: Option<&str>) -> Result<Self> {
        let name = name.map(str::to_string);
        let (init_tx, init_rx) = mpsc::channel::<Result<(u32, bool)>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ring_tx, ring_rx) = mpsc::channel::<RingSource>();

        let thread = std::thread::Builder::new()
            .name("eclume-mic".into())
            .spawn(move || {
                let started = start_input(name.as_deref());
                let (stream, source, fell_back) = match started {
                    Ok(pair) => pair,
                    Err(err) => {
                        let _ = init_tx.send(Err(err));
                        return;
                    }
                };
                let rate = source.sample_rate();
                let _ = ring_tx.send(source);
                let _ = init_tx.send(Ok((rate, fell_back)));
                // Mantém o stream vivo até o descarte da fonte.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .context("falha ao criar a thread do mic")?;

        match init_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(Ok((rate, fell_back))) => {
                let ring = ring_rx
                    .recv()
                    .map_err(|_| anyhow!("a thread do mic terminou antes de entregar a fonte"))?
                    .on_stop(move || {
                        let _ = stop_tx.send(());
                        let _ = crate::join_with_deadline(thread, crate::STOP_DEADLINE);
                    });
                log::info!("mic aberto a {rate} Hz");
                Ok(Self { ring, fell_back })
            }
            Ok(Err(err)) => {
                let _ = crate::join_with_deadline(thread, crate::STOP_DEADLINE);
                Err(err)
            }
            Err(_) => {
                // Sem join: a thread ainda está presa no driver; o sinal de parada fica na fila.
                let _ = stop_tx.send(());
                Err(anyhow!("tempo esgotado ao abrir o mic"))
            }
        }
    }
}

impl MicSource {
    /// O microfone pedido não estava lá e a captura usa o padrão.
    pub fn fell_back(&self) -> bool {
        self.fell_back
    }
}

impl AudioSource for MicSource {
    fn sample_rate(&self) -> u32 {
        self.ring.sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        self.ring.read(timeout)
    }
}

fn start_input(name: Option<&str>) -> Result<(cpal::Stream, RingSource, bool)> {
    let host = cpal::default_host();
    let named = name.and_then(|wanted| {
        host.input_devices()
            .ok()?
            .find(|d| device_name(d).as_deref() == Some(wanted))
    });
    let fell_back = name.is_some() && named.is_none();
    if fell_back {
        log::warn!(
            "microfone {:?} não encontrado; usando o padrão",
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
    Ok((stream, source, fell_back))
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
            log::error!("erro no stream do mic: {err}");
            closer.close();
        },
        None,
    )
}
