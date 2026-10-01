//! Mic pelo dispositivo de entrada escolhido (ou o padrão), via `cpal`.
//!
//! O `cpal::Stream` não é `Send` em todas as plataformas, então ele vive numa thread própria,
//! que o mantém tocando até a fonte ser descartada.

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

/// Com que frequência o seguidor confere qual microfone deveria estar em uso.
const FOLLOW_INTERVAL: Duration = Duration::from_secs(2);
/// Leituras seguidas iguais e diferentes do microfone em uso antes de trocar.
const FOLLOW_CONFIRMATIONS: u8 = 2;

/// O mic, como [`AudioSource`]. Se reconecta sozinho ([`Reconnecting`]): o dispositivo que cai
/// (headset Bluetooth trocando de perfil, USB tirado) é reaberto, com silêncio no meio. Cada
/// tentativa resolve a escolha de novo: o microfone pelo nome, senão o padrão. Um seguidor
/// confere a cada 2 s qual deveria estar em uso (o padrão do SO, ou o escolhido que reapareceu)
/// e pede a troca depois de duas leituras seguidas.
pub struct MicSource {
    source: Reconnecting,
    /// O microfone pedido sumiu e a captura caiu no padrão, na abertura.
    fell_back: bool,
    /// Desliga o seguidor quando a fonte é descartada.
    following: Arc<AtomicBool>,
}

impl MicSource {
    /// Abre o dispositivo de entrada padrão e começa a capturar.
    pub fn open() -> Result<Self> {
        Self::open_named(None)
    }

    /// Abre o microfone de nome `name` e começa a capturar. Se ele sumiu (um headset
    /// desconectado), cai no padrão com um aviso no log e em [`MicSource::fell_back`].
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

    /// O microfone pedido não estava lá e a captura usa o padrão.
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

/// O microfone que deveria estar em uso: o escolhido, se está entre os do sistema; senão o
/// padrão.
fn desired(wanted: Option<&str>, devices: &InputDevices) -> Option<String> {
    match wanted {
        Some(name) if devices.names.iter().any(|n| n == name) => Some(name.to_string()),
        _ => devices.default.clone(),
    }
}

/// Pede a troca quando o microfone que deveria estar em uso difere do em uso por
/// [`FOLLOW_CONFIRMATIONS`] leituras seguidas, o critério do `EndpointFollower` do áudio do
/// sistema no Windows.
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
                    log::info!("o microfone em uso ({current:?}) vai trocar");
                    switch.store(true, Ordering::Release);
                }
            }
        });
    if let Err(err) = spawned {
        log::warn!("falha ao criar o seguidor do microfone: {err}");
    }
}

/// Abre o microfone numa thread própria (o `cpal::Stream` não é `Send` em todas as plataformas)
/// e devolve o anel, o nome do dispositivo aberto e se caiu no padrão.
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
            // Mantém o stream vivo até o descarte da fonte.
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
            log::info!("mic {used:?} aberto a {rate} Hz");
            Ok((ring, used, fell_back))
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
            log::error!("erro no stream do mic: {err}");
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
    fn seguidor_troca_depois_de_duas_leituras_seguidas() {
        let mut follower = Follower::default();
        let now = devices("Headset", &["Headset", "Interno"]);
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
        assert!(follower.observe(desired(None, &now), Some("Interno")));
        // Uma leitura avulsa diferente não troca.
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
        assert!(!follower.observe(Some("Interno".into()), Some("Interno")));
        assert!(!follower.observe(desired(None, &now), Some("Interno")));
    }

    #[test]
    fn seguidor_volta_ao_escolhido_quando_ele_reaparece() {
        let mut follower = Follower::default();
        let without = devices("Interno", &["Interno"]);
        assert_eq!(desired(Some("USB"), &without).as_deref(), Some("Interno"));
        assert!(!follower.observe(desired(Some("USB"), &without), Some("Interno")));
        let with = devices("Interno", &["Interno", "USB"]);
        assert!(!follower.observe(desired(Some("USB"), &with), Some("Interno")));
        assert!(follower.observe(desired(Some("USB"), &with), Some("Interno")));
    }
}
