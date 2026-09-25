//! Codificação do fluxo mixado em Ogg/Opus mono 16 kHz (RFC 7845).
//!
//! Os cabeçalhos `OpusHead` e `OpusTags` ocupam uma página cada. Os pacotes de áudio (frames de
//! 20 ms) são agrupados em páginas de ~1 s, e cada página é descarregada no escritor: se o
//! processo morrer no meio, o que já foi escrito continua legível. O granule position está em
//! unidades de 48 kHz, como o formato exige, e o da última página marca a duração exata.

use std::io::Write;

use anyhow::{Context, Result};
use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Encoder};

use crate::mix::{FRAME, TARGET_RATE};

/// Taxa de bits padrão: 24 kbps, na faixa de voz do Opus.
pub const DEFAULT_BITRATE: i32 = 24_000;
/// Pacotes por página: 50 frames de 20 ms = 1 s.
const PACKETS_PER_PAGE: u32 = 50;
/// O granule do Ogg/Opus conta amostras a 48 kHz.
const GRANULE_PER_SAMPLE: u64 = (48_000 / TARGET_RATE) as u64;
const MAX_PACKET: usize = 4_000;
const VENDOR: &str = concat!("eclume-desktop ", env!("CARGO_PKG_VERSION"));

/// Escritor de Ogg/Opus mono 16 kHz sobre qualquer `Write`.
pub struct OggOpusWriter<W: Write> {
    encoder: Encoder,
    packets: PacketWriter<'static, W>,
    serial: u32,
    /// Lookahead do encoder, a 16 kHz.
    lookahead: usize,
    pending: Vec<f32>,
    /// Amostras reais recebidas (16 kHz), sem o preenchimento final.
    samples_in: u64,
    /// Amostras já codificadas (16 kHz), incluindo preenchimento.
    samples_encoded: u64,
    packets_in_page: u32,
    /// O último pacote fica retido para poder sair com a marca de fim de stream.
    held: Option<Vec<u8>>,
}

impl<W: Write> OggOpusWriter<W> {
    /// Escreve os cabeçalhos e prepara o encoder.
    pub fn new(writer: W, bitrate: i32, serial: u32) -> Result<Self> {
        let mut encoder = Encoder::new(TARGET_RATE, Channels::Mono, Application::Voip)
            .context("falha ao criar o encoder Opus")?;
        encoder
            .set_bitrate(Bitrate::Bits(bitrate))
            .context("falha ao ajustar a taxa de bits do Opus")?;
        let lookahead = usize::try_from(
            encoder
                .get_lookahead()
                .context("falha ao ler o lookahead do Opus")?,
        )
        .unwrap_or(0);

        let mut packets = PacketWriter::new(writer);
        let pre_skip = u16::try_from(lookahead as u64 * GRANULE_PER_SAMPLE)
            .context("pre-skip fora da faixa")?;
        packets
            .write_packet(opus_head(pre_skip), serial, PacketWriteEndInfo::EndPage, 0)
            .context("falha ao escrever o OpusHead")?;
        packets
            .write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)
            .context("falha ao escrever o OpusTags")?;
        packets.inner_mut().flush()?;

        Ok(Self {
            encoder,
            packets,
            serial,
            lookahead,
            pending: Vec::with_capacity(FRAME * 2),
            samples_in: 0,
            samples_encoded: 0,
            packets_in_page: 0,
            held: None,
        })
    }

    fn pre_skip(&self) -> u64 {
        self.lookahead as u64 * GRANULE_PER_SAMPLE
    }

    /// Amostras reais recebidas até agora (16 kHz).
    pub fn samples(&self) -> u64 {
        self.samples_in
    }

    /// Codifica as amostras mono 16 kHz; os frames incompletos esperam a próxima chamada.
    pub fn write(&mut self, samples: &[f32]) -> Result<()> {
        self.samples_in += samples.len() as u64;
        self.pending.extend_from_slice(samples);
        let full = self.pending.len() / FRAME * FRAME;
        let frames: Vec<f32> = self.pending.drain(..full).collect();
        for frame in frames.as_chunks::<FRAME>().0 {
            self.encode_frame(frame)?;
        }
        Ok(())
    }

    fn encode_frame(&mut self, frame: &[f32]) -> Result<()> {
        let packet = self
            .encoder
            .encode_vec_float(frame, MAX_PACKET)
            .context("falha ao codificar um frame Opus")?;
        self.samples_encoded += FRAME as u64;
        if let Some(previous) = self.held.replace(packet) {
            self.emit(previous, false)?;
        }
        Ok(())
    }

    /// Escreve um pacote. O granule é o total decodificável até o fim dele, em 48 kHz e contando
    /// o pre-skip; no último, é o pre-skip mais as amostras reais, o que corta o preenchimento.
    fn emit(&mut self, packet: Vec<u8>, last: bool) -> Result<()> {
        let granule = if last {
            self.pre_skip() + self.samples_in * GRANULE_PER_SAMPLE
        } else {
            // O pacote retido é o mais recente; este termina um frame antes dele.
            (self.samples_encoded - FRAME as u64) * GRANULE_PER_SAMPLE
        };
        self.packets_in_page += 1;
        let end = if last {
            PacketWriteEndInfo::EndStream
        } else if self.packets_in_page >= PACKETS_PER_PAGE {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        let page_closed = end != PacketWriteEndInfo::NormalPacket;
        self.packets
            .write_packet(packet, self.serial, end, granule)
            .context("falha ao escrever um pacote Ogg")?;
        if page_closed {
            self.packets_in_page = 0;
            self.packets.inner_mut().flush()?;
        }
        Ok(())
    }

    /// Codifica o que falta (incluindo o lookahead), fecha o stream e devolve o escritor.
    pub fn finish(mut self) -> Result<W> {
        // Silêncio para empurrar o lookahead para fora e completar o último frame.
        let tail = self.lookahead + (FRAME - (self.pending.len() + self.lookahead) % FRAME) % FRAME;
        self.pending.extend(std::iter::repeat_n(0.0, tail));
        let frames: Vec<f32> = std::mem::take(&mut self.pending);
        for frame in frames.as_chunks::<FRAME>().0 {
            self.encode_frame(frame)?;
        }
        // Um stream sem nenhum áudio ainda precisa de um pacote para carregar o fim.
        if self.held.is_none() {
            self.encode_frame(&[0.0; FRAME])?;
        }
        let last = self.held.take().expect("há sempre um pacote retido aqui");
        self.emit(last, true)?;
        let mut writer = self.packets.into_inner();
        writer.flush()?;
        Ok(writer)
    }
}

fn opus_head(pre_skip: u16) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // versão
    head.push(1); // canais
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&TARGET_RATE.to_le_bytes()); // taxa de entrada original
    head.extend_from_slice(&0i16.to_le_bytes()); // ganho de saída
    head.push(0); // mapeamento de canais: mono/estéreo
    head
}

fn opus_tags() -> Vec<u8> {
    let mut tags = Vec::with_capacity(16 + VENDOR.len());
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    tags.extend_from_slice(VENDOR.as_bytes());
    tags.extend_from_slice(&0u32.to_le_bytes()); // nenhum comentário
    tags
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use opus::Decoder;

    use super::*;

    fn sine(freq: f32, amp: f32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| (i as f32 * freq * std::f32::consts::TAU / TARGET_RATE as f32).sin() * amp)
            .collect()
    }

    /// Energia de uma frequência pelo algoritmo de Goertzel.
    fn goertzel(samples: &[f32], freq: f32) -> f32 {
        let k = 2.0 * (std::f32::consts::TAU * freq / TARGET_RATE as f32).cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for x in samples {
            let s0 = x + k * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        s1 * s1 + s2 * s2 - k * s1 * s2
    }

    struct Decoded {
        pre_skip: u16,
        channels: u8,
        input_rate: u32,
        final_granule: u64,
        audio: Vec<f32>,
        pages_flagged_eos: usize,
    }

    fn decode(bytes: Vec<u8>) -> Decoded {
        let mut reader = ogg::PacketReader::new(Cursor::new(bytes));
        let head = reader.read_packet_expected().unwrap();
        assert_eq!(&head.data[..8], b"OpusHead");
        let tags = reader.read_packet_expected().unwrap();
        assert_eq!(&tags.data[..8], b"OpusTags");

        let mut decoder = Decoder::new(TARGET_RATE, Channels::Mono).unwrap();
        let mut audio = Vec::new();
        let mut final_granule = 0;
        let mut eos = 0;
        let mut buf = vec![0.0f32; 5_760];
        while let Some(packet) = reader.read_packet().unwrap() {
            let n = decoder.decode_float(&packet.data, &mut buf, false).unwrap();
            audio.extend_from_slice(&buf[..n]);
            if packet.last_in_page() {
                final_granule = packet.absgp_page();
            }
            if packet.last_in_stream() {
                eos += 1;
            }
        }
        Decoded {
            pre_skip: u16::from_le_bytes([head.data[10], head.data[11]]),
            channels: head.data[9],
            input_rate: u32::from_le_bytes(head.data[12..16].try_into().unwrap()),
            final_granule,
            audio,
            pages_flagged_eos: eos,
        }
    }

    #[test]
    fn encode_round_trip_preserva_senoide_e_duracao() {
        let input = sine(440.0, 0.5, TARGET_RATE as usize); // 1 s
        let mut writer = OggOpusWriter::new(Vec::new(), DEFAULT_BITRATE, 7).unwrap();
        for chunk in input.chunks(123) {
            writer.write(chunk).unwrap();
        }
        let bytes = writer.finish().unwrap();
        let out = decode(bytes);

        assert_eq!(out.channels, 1);
        assert_eq!(out.input_rate, 16_000);
        assert!(out.pre_skip > 0);
        assert_eq!(out.pages_flagged_eos, 1);
        // A duração pelo granule é exata: (granule - pre_skip) / 48 kHz = 1 s.
        assert_eq!(out.final_granule - u64::from(out.pre_skip), 48_000);

        // Remove o pre-skip (em 16 kHz) e compara o conteúdo.
        let skip = usize::from(out.pre_skip) / 3;
        let audio = &out.audio[skip..skip + input.len()];
        let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32).sqrt();
        assert!((0.25..0.45).contains(&rms), "RMS {rms}");
        let tone = goertzel(&audio[1_600..14_400], 440.0);
        let off = goertzel(&audio[1_600..14_400], 1_000.0);
        assert!(tone > off * 100.0, "440 Hz {tone} vs 1 kHz {off}");
    }

    #[test]
    fn encode_fica_na_faixa_de_opus_de_voz() {
        // 10 s de voz sintética: duas senoides moduladas e ruído leve.
        let mut seed = 1u32;
        let samples: Vec<f32> = (0..TARGET_RATE as usize * 10)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
                let t = i as f32 / TARGET_RATE as f32;
                let env = (t * 3.0 * std::f32::consts::TAU).sin().abs();
                env * (0.3 * (t * 220.0 * std::f32::consts::TAU).sin()
                    + 0.15 * (t * 1_300.0 * std::f32::consts::TAU).sin())
                    + 0.02 * noise
            })
            .collect();
        let mut writer = OggOpusWriter::new(Vec::new(), DEFAULT_BITRATE, 1).unwrap();
        writer.write(&samples).unwrap();
        let bytes = writer.finish().unwrap();
        let per_second = bytes.len() / 10;
        // 24 kbps = 3.000 B/s; aceita a variação do VBR e o overhead do Ogg.
        assert!((1_500..4_500).contains(&per_second), "{per_second} B/s");
    }

    #[test]
    fn stream_vazio_ainda_fecha_valido() {
        let writer = OggOpusWriter::new(Vec::new(), DEFAULT_BITRATE, 3).unwrap();
        let out = decode(writer.finish().unwrap());
        assert_eq!(out.pages_flagged_eos, 1);
        assert_eq!(out.final_granule, u64::from(out.pre_skip));
    }

    #[test]
    fn paginas_sao_descarregadas_durante_a_gravacao() {
        let mut writer = OggOpusWriter::new(Vec::new(), DEFAULT_BITRATE, 9).unwrap();
        let headers = writer.packets.inner().len();
        writer
            .write(&sine(300.0, 0.4, TARGET_RATE as usize * 2))
            .unwrap();
        // Dois segundos fecham ao menos uma página de 1 s antes do `finish`.
        assert!(writer.packets.inner().len() > headers);
    }
}
