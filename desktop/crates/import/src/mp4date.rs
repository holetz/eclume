//! O `creation_time` do `moov/mvhd` de MP4, MOV e M4A, que gravadores e celulares preenchem, e se
//! o arquivo tem trilha de som (`hdlr` = `soun`). Percorre as caixas sem dependência.

use std::io::{self, Read, Seek, SeekFrom};

/// Segundos de 1904-01-01 (a época do MP4) a 1970-01-01.
const MP4_EPOCH_OFFSET_S: i64 = 2_082_844_800;
/// 1990-01-01 UTC: antes disso, a data é zero ou relógio desacertado.
const MIN_VALID_S: i64 = 631_152_000;
/// Teto do `moov` lido em memória (ele traz só índices, não mídia).
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;
/// Caixas que abrem um MP4 ou um MOV antigo sem `ftyp`.
const FIRST_BOXES: [&[u8; 4]; 6] = [b"ftyp", b"moov", b"wide", b"free", b"skip", b"mdat"];

/// O que o `moov` diz.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mp4Info {
    /// `creation_time` do `mvhd`, em ms desde 1970; `None` se zero ou anterior a 1990.
    pub created_at_ms: Option<i64>,
    /// Alguma trilha é de som.
    pub has_sound: bool,
}

/// Lê o `moov` de um MP4; `Ok(None)` quando o arquivo não é MP4 ou não tem `moov`.
pub fn read(mut reader: impl Read + Seek) -> io::Result<Option<Mp4Info>> {
    let end = reader.seek(SeekFrom::End(0))?;
    let mut offset = 0;
    let mut first = true;
    while offset + 8 <= end {
        reader.seek(SeekFrom::Start(offset))?;
        let mut header = [0u8; 16];
        reader.read_exact(&mut header[..8])?;
        let kind: [u8; 4] = header[4..8].try_into().expect("4 bytes");
        if first && !FIRST_BOXES.contains(&&kind) {
            return Ok(None);
        }
        first = false;
        let (size, header_len) = match u32::from_be_bytes(header[..4].try_into().expect("4")) {
            0 => (end - offset, 8),
            1 => {
                reader.read_exact(&mut header[8..16])?;
                (u64::from_be_bytes(header[8..16].try_into().expect("8")), 16)
            }
            size => (u64::from(size), 8),
        };
        if size < header_len {
            return Ok(None);
        }
        if &kind == b"moov" {
            let body_len = (size - header_len).min(MAX_MOOV_BYTES);
            let mut body = vec![0u8; usize::try_from(body_len).unwrap_or(0)];
            reader.read_exact(&mut body)?;
            return Ok(Some(parse_moov(&body)));
        }
        offset += size;
    }
    Ok(None)
}

/// As caixas filhas de `data`: (tipo, corpo). Para na primeira caixa malformada.
fn children(mut data: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        if data.len() < 8 {
            return None;
        }
        let size = u32::from_be_bytes(data[..4].try_into().ok()?) as usize;
        let kind: [u8; 4] = data[4..8].try_into().ok()?;
        let (size, header) = match size {
            0 => (data.len(), 8),
            1 if data.len() >= 16 => {
                let large = u64::from_be_bytes(data[8..16].try_into().ok()?);
                (usize::try_from(large).ok()?, 16)
            }
            _ => (size, 8),
        };
        if size < header || size > data.len() {
            return None;
        }
        let body = &data[header..size];
        data = &data[size..];
        Some((kind, body))
    })
}

fn parse_moov(moov: &[u8]) -> Mp4Info {
    let mut info = Mp4Info {
        created_at_ms: None,
        has_sound: false,
    };
    for (kind, body) in children(moov) {
        match &kind {
            b"mvhd" => info.created_at_ms = mvhd_creation(body),
            b"trak" => info.has_sound |= trak_is_sound(body),
            _ => {}
        }
    }
    info
}

/// `mvhd`: versão (1 byte), flags (3) e o `creation_time` em 32 (v0) ou 64 bits (v1).
fn mvhd_creation(body: &[u8]) -> Option<i64> {
    let seconds = match body.first()? {
        0 => i64::from(u32::from_be_bytes(body.get(4..8)?.try_into().ok()?)),
        1 => i64::try_from(u64::from_be_bytes(body.get(4..12)?.try_into().ok()?)).ok()?,
        _ => return None,
    };
    let unix = seconds - MP4_EPOCH_OFFSET_S;
    (unix >= MIN_VALID_S).then(|| unix * 1000)
}

/// `trak/mdia/hdlr`: versão e flags (4), `pre_defined` (4) e o tipo do manipulador.
fn trak_is_sound(trak: &[u8]) -> bool {
    children(trak)
        .filter(|(kind, _)| kind == b"mdia")
        .flat_map(|(_, mdia)| children(mdia))
        .any(|(kind, hdlr)| &kind == b"hdlr" && hdlr.get(8..12) == Some(b"soun"))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn caixa(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(body.len() + 8).unwrap().to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn mvhd(version: u8, seconds: u64) -> Vec<u8> {
        let mut body = vec![version, 0, 0, 0];
        if version == 0 {
            body.extend_from_slice(&u32::try_from(seconds).unwrap().to_be_bytes());
        } else {
            body.extend_from_slice(&seconds.to_be_bytes());
        }
        body.extend_from_slice(&[0; 16]);
        caixa(b"mvhd", &body)
    }

    fn trak(handler: &[u8; 4]) -> Vec<u8> {
        let mut hdlr = vec![0; 8];
        hdlr.extend_from_slice(handler);
        caixa(b"trak", &caixa(b"mdia", &caixa(b"hdlr", &hdlr)))
    }

    fn mp4(moov: &[Vec<u8>]) -> Vec<u8> {
        let mut out = caixa(b"ftyp", b"M4A \0\0\0\0");
        out.extend(caixa(b"mdat", &[0; 32]));
        out.extend(caixa(b"moov", &moov.concat()));
        out
    }

    /// 2026-09-19T14:02:00Z em segundos desde 1904.
    const DATA_1904: u64 = 1_789_826_520 + 2_082_844_800;

    #[test]
    fn mvhd_v0_e_v1_viram_ms_desde_1970() {
        for version in [0, 1] {
            let info = read(Cursor::new(mp4(&[mvhd(version, DATA_1904), trak(b"soun")])))
                .unwrap()
                .unwrap();
            assert_eq!(info.created_at_ms, Some(1_789_826_520_000));
            assert!(info.has_sound);
        }
    }

    #[test]
    fn data_zero_ou_antiga_e_ignorada() {
        let zero = read(Cursor::new(mp4(&[mvhd(0, 0), trak(b"vide")])))
            .unwrap()
            .unwrap();
        assert_eq!(zero.created_at_ms, None);
        assert!(!zero.has_sound);
        let antiga = 400_000_000 + MP4_EPOCH_OFFSET_S as u64;
        let info = read(Cursor::new(mp4(&[mvhd(0, antiga)])))
            .unwrap()
            .unwrap();
        assert_eq!(info.created_at_ms, None);
    }

    #[test]
    fn nao_mp4_ou_truncado_nao_quebra() {
        assert_eq!(read(Cursor::new(b"RIFF\0\0\0\0WAVEfmt ".to_vec())).unwrap(), None);
        assert_eq!(read(Cursor::new(Vec::new())).unwrap(), None);
        let mut cortado = mp4(&[mvhd(0, DATA_1904)]);
        cortado.truncate(cortado.len() - 10);
        assert!(read(Cursor::new(cortado)).is_err());
    }
}
