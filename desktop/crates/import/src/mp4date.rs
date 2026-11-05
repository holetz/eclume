//! The `creation_time` of the `moov/mvhd` of MP4, MOV and M4A, which recorders and phones fill
//! in, and whether the file has a sound track (`hdlr` = `soun`). Walks the boxes with no dependency.

use std::io::{self, Read, Seek, SeekFrom};

/// Seconds from 1904-01-01 (the MP4 epoch) to 1970-01-01.
const MP4_EPOCH_OFFSET_S: i64 = 2_082_844_800;
/// 1990-01-01 UTC: before that, the date is zero or a clock that was never set.
const MIN_VALID_S: i64 = 631_152_000;
/// Cap on the `moov` read into memory (it carries only indexes, not media).
const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;
/// Boxes that open an MP4, or an old MOV without `ftyp`.
const FIRST_BOXES: [&[u8; 4]; 6] = [b"ftyp", b"moov", b"wide", b"free", b"skip", b"mdat"];

/// What the `moov` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mp4Info {
    /// The `mvhd` `creation_time`, in ms since 1970; `None` if zero or before 1990.
    pub created_at_ms: Option<i64>,
    /// Some track is a sound track.
    pub has_sound: bool,
}

/// Reads the `moov` of an MP4; `Ok(None)` when the file is not MP4 or has no `moov`.
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

/// The child boxes of `data`: (type, body). Stops at the first malformed box.
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

/// `mvhd`: version (1 byte), flags (3) and the `creation_time` in 32 (v0) or 64 bits (v1).
fn mvhd_creation(body: &[u8]) -> Option<i64> {
    let seconds = match body.first()? {
        0 => i64::from(u32::from_be_bytes(body.get(4..8)?.try_into().ok()?)),
        1 => i64::try_from(u64::from_be_bytes(body.get(4..12)?.try_into().ok()?)).ok()?,
        _ => return None,
    };
    let unix = seconds - MP4_EPOCH_OFFSET_S;
    (unix >= MIN_VALID_S).then(|| unix * 1000)
}

/// `trak/mdia/hdlr`: version and flags (4), `pre_defined` (4) and the handler type.
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

    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(body.len() + 8)
            .unwrap()
            .to_be_bytes()
            .to_vec();
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
        mp4_box(b"mvhd", &body)
    }

    fn trak(handler: &[u8; 4]) -> Vec<u8> {
        let mut hdlr = vec![0; 8];
        hdlr.extend_from_slice(handler);
        mp4_box(b"trak", &mp4_box(b"mdia", &mp4_box(b"hdlr", &hdlr)))
    }

    fn mp4(moov: &[Vec<u8>]) -> Vec<u8> {
        let mut out = mp4_box(b"ftyp", b"M4A \0\0\0\0");
        out.extend(mp4_box(b"mdat", &[0; 32]));
        out.extend(mp4_box(b"moov", &moov.concat()));
        out
    }

    /// 2026-09-19T14:02:00Z in seconds since 1904.
    const DATE_1904: u64 = 1_789_826_520 + 2_082_844_800;

    #[test]
    fn mvhd_v0_and_v1_become_ms_since_1970() {
        for version in [0, 1] {
            let info = read(Cursor::new(mp4(&[mvhd(version, DATE_1904), trak(b"soun")])))
                .unwrap()
                .unwrap();
            assert_eq!(info.created_at_ms, Some(1_789_826_520_000));
            assert!(info.has_sound);
        }
    }

    #[test]
    fn zero_or_old_date_is_ignored() {
        let zero = read(Cursor::new(mp4(&[mvhd(0, 0), trak(b"vide")])))
            .unwrap()
            .unwrap();
        assert_eq!(zero.created_at_ms, None);
        assert!(!zero.has_sound);
        let old = 400_000_000 + MP4_EPOCH_OFFSET_S as u64;
        let info = read(Cursor::new(mp4(&[mvhd(0, old)]))).unwrap().unwrap();
        assert_eq!(info.created_at_ms, None);
    }

    #[test]
    fn non_mp4_or_truncated_does_not_break() {
        assert_eq!(
            read(Cursor::new(b"RIFF\0\0\0\0WAVEfmt ".to_vec())).unwrap(),
            None
        );
        assert_eq!(read(Cursor::new(Vec::new())).unwrap(), None);
        let mut truncated = mp4(&[mvhd(0, DATE_1904)]);
        truncated.truncate(truncated.len() - 10);
        assert!(read(Cursor::new(truncated)).is_err());
    }
}
