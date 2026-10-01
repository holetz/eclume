//! Conversão do arquivo importado para Ogg/Opus mono 16 kHz a 32 kbps, o formato do navegador.
//!
//! O `symphonia` demultiplexa e decodifica (MP3, AAC, ALAC, FLAC, Vorbis, PCM em MP4/MOV/M4A,
//! MKV/WebM, Ogg e WAV); o Opus, que ele só demultiplexa, vai para a libopus. A mixagem para mono
//! e o `Mixer` do recorder (o reamostrador do workspace) levam a 16 kHz, e o `OggOpusWriter` do
//! recorder codifica. O que não dá para converter é copiado como está: o worker do servidor
//! decodifica com ffmpeg.

use std::fs::File;
use std::io::{BufWriter, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use eclume_recorder::{Mixer, OggOpusWriter, TARGET_RATE};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CodecParameters, DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// A taxa do navegador para voz.
pub const BITRATE: i32 = 32_000;
/// O `content_type` do que sai convertido.
pub const OGG_OPUS: &str = "audio/ogg; codecs=opus";
/// O Opus decodifica a 48 kHz; o maior pacote tem 120 ms.
const OPUS_RATE: u32 = 48_000;
const OPUS_MAX_FRAME: usize = 5_760;

/// O arquivo pronto em `gravacoes/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Converted {
    pub path: PathBuf,
    pub content_type: String,
    pub bytes: u64,
    /// A duração do áudio convertido; `None` na cópia.
    pub duration_ms: Option<u64>,
    /// `false` quando o original foi copiado como está.
    pub converted: bool,
}

/// A importação foi cancelada: o arquivo parcial já saiu do disco.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("importação cancelada")
    }
}

impl std::error::Error for Cancelled {}

/// Converte `src` para `<dir>/<id>.ogg`, ou o copia para `<dir>/<id>.<ext>` quando não dá.
/// `progress` recebe a fração feita (0 a 1); `cancel` interrompe entre pacotes. Um pânico do
/// decodificador conta como arquivo que não decodifica: o `.part` sai e vale "vai como está".
pub fn convert(
    src: &Path,
    dir: &Path,
    id: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<Converted> {
    std::fs::create_dir_all(dir).with_context(|| format!("falha ao criar {}", dir.display()))?;
    let dest = dir.join(format!("{id}.ogg"));
    let part = dir.join(format!("{id}.ogg.part"));
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        to_opus(src, &part, cancel, &mut progress)
    }))
    .unwrap_or_else(|_| Err(anyhow!("o decodificador entrou em pânico")));
    match attempt {
        Ok(samples) => {
            std::fs::rename(&part, &dest)?;
            progress(1.0);
            Ok(Converted {
                bytes: std::fs::metadata(&dest)?.len(),
                path: dest,
                content_type: OGG_OPUS.into(),
                duration_ms: Some(samples * 1000 / u64::from(TARGET_RATE)),
                converted: true,
            })
        }
        Err(err) => {
            let _ = std::fs::remove_file(&part);
            if err.is::<Cancelled>() {
                return Err(err);
            }
            log::info!("{} vai como está: {err:#}", src.display());
            copy_original(src, dir, id, cancel).inspect(|_| progress(1.0))
        }
    }
}

/// Copia o original, com a extensão dele e o `content_type` que ela indica.
fn copy_original(src: &Path, dir: &Path, id: &str, cancel: &AtomicBool) -> Result<Converted> {
    if cancel.load(Ordering::Relaxed) {
        bail!(Cancelled);
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "bin".into());
    let dest = dir.join(format!("{id}.{ext}"));
    let bytes = std::fs::copy(src, &dest)
        .with_context(|| format!("falha ao copiar {} para {}", src.display(), dest.display()))?;
    Ok(Converted {
        path: dest,
        content_type: content_type(&ext).into(),
        bytes,
        duration_ms: None,
        converted: false,
    })
}

/// O `content_type` pela extensão; o servidor aceita `audio/*` e `video/*`.
pub fn content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "weba" => "audio/webm",
        "wma" => "audio/x-ms-wma",
        "ac3" => "audio/ac3",
        "amr" => "audio/amr",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "3gp" => "video/3gpp",
        _ => "application/octet-stream",
    }
}

/// Decodificador da trilha: o do `symphonia` ou a libopus.
enum Decoder {
    Symphonia(Box<dyn symphonia::core::codecs::Decoder>),
    Opus {
        decoder: opus::Decoder,
        channels: usize,
        /// Amostras a 48 kHz que o `OpusHead` manda descartar no começo.
        skip: usize,
        buffer: Vec<f32>,
    },
}

impl Decoder {
    fn new(params: &CodecParameters) -> Result<Self> {
        if params.codec != CODEC_TYPE_OPUS {
            let decoder = symphonia::default::get_codecs()
                .make(params, &DecoderOptions::default())
                .context("codec sem decodificador")?;
            return Ok(Self::Symphonia(decoder));
        }
        // OpusHead: "OpusHead", versão, canais (byte 9), pre-skip (bytes 10-11, LE).
        let head = params.extra_data.as_deref().unwrap_or_default();
        let channels = head
            .get(9)
            .map(|&c| usize::from(c))
            .or_else(|| params.channels.map(|c| c.count()))
            .unwrap_or(1);
        let layout = match channels {
            1 => opus::Channels::Mono,
            2 => opus::Channels::Stereo,
            n => bail!("Opus com {n} canais"),
        };
        let skip = head
            .get(10..12)
            .map_or(0, |b| usize::from(u16::from_le_bytes([b[0], b[1]])));
        Ok(Self::Opus {
            decoder: opus::Decoder::new(OPUS_RATE, layout)
                .context("falha ao criar o decoder Opus")?,
            channels,
            skip,
            buffer: vec![0.0; OPUS_MAX_FRAME * channels],
        })
    }

    /// Decodifica um pacote em amostras mono e a taxa delas; `None` num pacote corrompido.
    fn decode(
        &mut self,
        data: &symphonia::core::formats::Packet,
    ) -> Result<Option<(Vec<f32>, u32)>> {
        match self {
            Self::Symphonia(decoder) => match decoder.decode(data) {
                Ok(buffer) => {
                    let spec = *buffer.spec();
                    let mut samples = SampleBuffer::<f32>::new(buffer.capacity() as u64, spec);
                    samples.copy_interleaved_ref(buffer);
                    Ok(Some((
                        mono(samples.samples(), spec.channels.count()),
                        spec.rate,
                    )))
                }
                Err(SymphoniaError::DecodeError(err)) => {
                    log::debug!("pacote corrompido ignorado: {err}");
                    Ok(None)
                }
                Err(err) => Err(err.into()),
            },
            Self::Opus {
                decoder,
                channels,
                skip,
                buffer,
            } => {
                let frames = decoder
                    .decode_float(&data.data, buffer, false)
                    .context("falha ao decodificar um pacote Opus")?;
                let mut out = mono(&buffer[..frames * *channels], *channels);
                let dropped = (*skip).min(out.len());
                out.drain(..dropped);
                *skip -= dropped;
                Ok(Some((out, OPUS_RATE)))
            }
        }
    }
}

/// A média dos canais de um bloco intercalado.
fn mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Decodifica, reamostra e codifica em `dest`; devolve as amostras gravadas (16 kHz).
fn to_opus(
    src: &Path,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(f32),
) -> Result<u64> {
    let mut format = open(src)?;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .cloned()
        .ok_or_else(|| anyhow!("nenhuma trilha de áudio"))?;
    let mut decoder = Decoder::new(&track.codec_params)?;
    let total = track.codec_params.n_frames.filter(|&n| n > 0);

    let mut writer = OggOpusWriter::new(
        BufWriter::new(
            File::create(dest).with_context(|| format!("falha ao criar {}", dest.display()))?,
        ),
        BITRATE,
        rand_serial(),
    )?;
    let mut mixer: Option<(Mixer, u32)> = None;
    let mut reported = 0.0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!(Cancelled);
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(err) => return Err(err.into()),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let Some((samples, rate)) = decoder.decode(&packet)? else {
            continue;
        };
        let lane = match &mut mixer {
            Some((mixer, lane_rate)) if *lane_rate == rate => mixer,
            slot => {
                if let Some((mut old, _)) = slot.take() {
                    writer.write(&old.drain()?)?;
                }
                &mut slot.insert((Mixer::new(&[rate])?, rate)).0
            }
        };
        lane.push(0, &samples, rate)?;
        writer.write(&lane.pop_ready())?;
        if let Some(total) = total {
            let done = ((packet.ts() + packet.dur()) as f32 / total as f32).min(0.99);
            if done - reported >= 0.01 {
                reported = done;
                progress(done);
            }
        }
    }
    if let Some((mut mixer, _)) = mixer {
        mixer.end(0)?;
        writer.write(&mixer.drain()?)?;
    }
    if writer.samples() == 0 {
        bail!("nenhuma amostra decodificada");
    }
    let samples = writer.samples();
    writer
        .finish()?
        .into_inner()
        .map_err(|err| err.into_error())?
        .sync_all()?;
    Ok(samples)
}

fn open(src: &Path) -> Result<Box<dyn FormatReader>> {
    let file = File::open(src).with_context(|| format!("falha ao abrir {}", src.display()))?;
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(
        &hint,
        MediaSourceStream::new(Box::new(file), Default::default()),
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    Ok(probed.format)
}

/// Número de série do stream Ogg: basta diferir entre arquivos.
fn rand_serial() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(1, |d| d.subsec_nanos() ^ d.as_secs() as u32)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eclume-import-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Lê o `OpusHead` e a duração (granule da última página menos o pre-skip) de um Ogg/Opus.
    fn ogg_opus(path: &Path) -> (u8, u32, u64) {
        let mut reader = ogg::reading::PacketReader::new(File::open(path).unwrap());
        let head = reader.read_packet().unwrap().unwrap();
        assert_eq!(&head.data[..8], b"OpusHead");
        let channels = head.data[9];
        let pre_skip = u64::from(u16::from_le_bytes([head.data[10], head.data[11]]));
        let rate = u32::from_le_bytes(head.data[12..16].try_into().unwrap());
        let mut granule = 0;
        while let Some(packet) = reader.read_packet().unwrap() {
            granule = packet.absgp_page();
        }
        (channels, rate, (granule - pre_skip) / 48)
    }

    #[test]
    fn converte_os_formatos_que_o_symphonia_le_para_opus_mono() {
        let dir = scratch("converte");
        for (i, name) in ["tom.m4a", "tom.mp3", "tom.wav", "tom.webm", "tom.ogg"]
            .into_iter()
            .enumerate()
        {
            let mut steps = Vec::new();
            let out = convert(
                &fixture(name),
                &dir,
                &format!("g{i}"),
                &AtomicBool::new(false),
                |f| steps.push(f),
            )
            .unwrap();
            assert!(out.converted, "{name}");
            assert_eq!(out.path, dir.join(format!("g{i}.ogg")));
            assert_eq!(out.content_type, OGG_OPUS);
            assert_eq!(out.bytes, std::fs::metadata(&out.path).unwrap().len());
            let ms = out.duration_ms.unwrap();
            assert!((1_950..=2_100).contains(&ms), "{name}: {ms} ms");
            let (channels, rate, ogg_ms) = ogg_opus(&out.path);
            assert_eq!((channels, rate), (1, 16_000), "{name}");
            assert!(ogg_ms.abs_diff(ms) <= 1, "{name}: {ogg_ms} ≠ {ms}");
            assert_eq!(steps.last(), Some(&1.0), "{name}");
            assert!(steps.windows(2).all(|w| w[0] <= w[1]), "{name}: {steps:?}");
            assert!(!dir.join(format!("g{i}.ogg.part")).exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn o_que_nao_decodifica_e_copiado_com_o_tipo_da_extensao() {
        let dir = scratch("copia");
        let out = convert(
            &fixture("tom.avi"),
            &dir,
            "v",
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(!out.converted);
        assert_eq!(out.path, dir.join("v.avi"));
        assert_eq!(out.content_type, "video/x-msvideo");
        assert_eq!(out.duration_ms, None);
        assert_eq!(
            std::fs::read(&out.path).unwrap(),
            std::fs::read(fixture("tom.avi")).unwrap()
        );
        assert!(!dir.join("v.ogg").exists() && !dir.join("v.ogg.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn panico_do_decodificador_vai_como_esta() {
        let dir = scratch("panico");
        let mut panicked = false;
        let out = convert(
            &fixture("tom.wav"),
            &dir,
            "p",
            &AtomicBool::new(false),
            |_| {
                // Dentro da conversão, o primeiro passo entra em pânico, como um decodificador
                // quebrado; o "vai como está" segue.
                if !std::mem::replace(&mut panicked, true) {
                    panic!("decodificador quebrado");
                }
            },
        )
        .unwrap();
        assert!(!out.converted);
        assert_eq!(out.path, dir.join("p.wav"));
        assert!(!dir.join("p.ogg.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cancelar_apaga_o_parcial() {
        let dir = scratch("cancela");
        let err = convert(
            &fixture("tom.wav"),
            &dir,
            "c",
            &AtomicBool::new(true),
            |_| {},
        )
        .unwrap_err();
        assert!(err.is::<Cancelled>());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tipos_pela_extensao() {
        assert_eq!(content_type("MOV"), "video/quicktime");
        assert_eq!(content_type("wma"), "audio/x-ms-wma");
        assert_eq!(content_type("xyz"), "application/octet-stream");
    }
}
