//! Conversion of the imported file to Ogg/Opus mono 16 kHz at 32 kbps, the browser's format.
//!
//! `symphonia` demuxes and decodes (MP3, AAC, ALAC, FLAC, Vorbis, PCM in MP4/MOV/M4A,
//! MKV/WebM, Ogg and WAV); Opus, which it only demuxes, goes to libopus. The mono downmix and
//! the recorder's `Mixer` (the workspace resampler) bring it to 16 kHz, and the recorder's
//! `OggOpusWriter` encodes. What cannot be converted is copied as is: the server worker decodes
//! it with ffmpeg.

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

/// The browser's bitrate for voice.
pub const BITRATE: i32 = 32_000;
/// The `content_type` of the converted output.
pub const OGG_OPUS: &str = "audio/ogg; codecs=opus";
/// Opus decodes at 48 kHz; the largest packet is 120 ms.
const OPUS_RATE: u32 = 48_000;
const OPUS_MAX_FRAME: usize = 5_760;

/// The finished file in `gravacoes/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Converted {
    pub path: PathBuf,
    pub content_type: String,
    pub bytes: u64,
    /// The duration of the converted audio; `None` for a copy.
    pub duration_ms: Option<u64>,
    /// `false` when the original was copied as is.
    pub converted: bool,
}

/// The import was cancelled: the partial file is already gone from disk.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // pt-BR UI copy: the window shows it when an import fails.
        f.write_str("importação cancelada")
    }
}

impl std::error::Error for Cancelled {}

/// Converts `src` to `<dir>/<id>.ogg`, or copies it to `<dir>/<id>.<ext>` when it cannot.
/// `progress` receives the fraction done (0 to 1); `cancel` stops between packets. A decoder
/// panic counts as a file that does not decode: the `.part` is removed and "goes as is" applies.
/// Errors that leave this function stay pt-BR UI copy (the window shows them); the conversion
/// errors below only reach the log, because a failed conversion falls back to the copy.
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
    .unwrap_or_else(|_| Err(anyhow!("the decoder panicked")));
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
            log::info!("{} goes as is: {err:#}", src.display());
            copy_original(src, dir, id, cancel).inspect(|_| progress(1.0))
        }
    }
}

/// Copies the original, with its extension and the `content_type` that extension implies.
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

/// The `content_type` by extension; the server accepts `audio/*` and `video/*`.
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

/// The track's decoder: `symphonia`'s or libopus.
enum Decoder {
    Symphonia(Box<dyn symphonia::core::codecs::Decoder>),
    Opus {
        decoder: opus::Decoder,
        channels: usize,
        /// Samples at 48 kHz that the `OpusHead` says to drop at the start.
        skip: usize,
        buffer: Vec<f32>,
    },
}

impl Decoder {
    fn new(params: &CodecParameters) -> Result<Self> {
        if params.codec != CODEC_TYPE_OPUS {
            let decoder = symphonia::default::get_codecs()
                .make(params, &DecoderOptions::default())
                .context("codec without a decoder")?;
            return Ok(Self::Symphonia(decoder));
        }
        // OpusHead: "OpusHead", version, channels (byte 9), pre-skip (bytes 10-11, LE).
        let head = params.extra_data.as_deref().unwrap_or_default();
        let channels = head
            .get(9)
            .map(|&c| usize::from(c))
            .or_else(|| params.channels.map(|c| c.count()))
            .unwrap_or(1);
        let layout = match channels {
            1 => opus::Channels::Mono,
            2 => opus::Channels::Stereo,
            n => bail!("Opus with {n} channels"),
        };
        let skip = head
            .get(10..12)
            .map_or(0, |b| usize::from(u16::from_le_bytes([b[0], b[1]])));
        Ok(Self::Opus {
            decoder: opus::Decoder::new(OPUS_RATE, layout)
                .context("failed to create the Opus decoder")?,
            channels,
            skip,
            buffer: vec![0.0; OPUS_MAX_FRAME * channels],
        })
    }

    /// Decodes a packet into mono samples and their rate; `None` for a corrupt packet.
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
                    log::debug!("corrupt packet skipped: {err}");
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
                    .context("failed to decode an Opus packet")?;
                let mut out = mono(&buffer[..frames * *channels], *channels);
                let dropped = (*skip).min(out.len());
                out.drain(..dropped);
                *skip -= dropped;
                Ok(Some((out, OPUS_RATE)))
            }
        }
    }
}

/// The channel average of an interleaved block.
fn mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Decodes, resamples and encodes into `dest`; returns the samples written (16 kHz).
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
        .ok_or_else(|| anyhow!("no audio track"))?;
    let mut decoder = Decoder::new(&track.codec_params)?;
    let total = track.codec_params.n_frames.filter(|&n| n > 0);

    let mut writer = OggOpusWriter::new(
        BufWriter::new(
            File::create(dest).with_context(|| format!("failed to create {}", dest.display()))?,
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
        bail!("no samples decoded");
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
    let file = File::open(src).with_context(|| format!("failed to open {}", src.display()))?;
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

/// The Ogg stream serial number: it only needs to differ between files.
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

    /// Reads the `OpusHead` and the duration (last page granule minus pre-skip) of an Ogg/Opus file.
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
    fn converts_the_formats_symphonia_reads_to_mono_opus() {
        let dir = scratch("convert");
        for (i, name) in ["tone.m4a", "tone.mp3", "tone.wav", "tone.webm", "tone.ogg"]
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
    fn what_does_not_decode_is_copied_with_the_extension_type() {
        let dir = scratch("copy");
        let out = convert(
            &fixture("tone.avi"),
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
            std::fs::read(fixture("tone.avi")).unwrap()
        );
        assert!(!dir.join("v.ogg").exists() && !dir.join("v.ogg.part").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn decoder_panic_goes_as_is() {
        let dir = scratch("panic");
        let mut panicked = false;
        let out = convert(
            &fixture("tone.wav"),
            &dir,
            "p",
            &AtomicBool::new(false),
            |_| {
                // Inside the conversion, the first step panics, like a broken decoder; the
                // "goes as is" path follows.
                if !std::mem::replace(&mut panicked, true) {
                    panic!("broken decoder");
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
    fn cancel_deletes_the_partial_file() {
        let dir = scratch("cancel");
        let err = convert(
            &fixture("tone.wav"),
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
    fn types_by_extension() {
        assert_eq!(content_type("MOV"), "video/quicktime");
        assert_eq!(content_type("wma"), "audio/x-ms-wma");
        assert_eq!(content_type("xyz"), "application/octet-stream");
    }
}
