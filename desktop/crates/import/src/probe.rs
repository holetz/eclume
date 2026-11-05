//! Reading the file to import: duration, whether there is audio, whether the app can decode it,
//! and the recording date, in this order of trust:
//! 1. the `mvhd` `creation_time` (MP4, MOV, M4A);
//! 2. the date tags (ID3 `TDRC`/`TYER`, Vorbis `DATE`, MP4 `©day`), only with a full day;
//! 3. the file's modification date minus the duration (the likely start).

use std::fs::File;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;
use symphonia::core::codecs::{CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
use symphonia::core::formats::{FormatOptions, FormatReader, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey};
use symphonia::core::probe::Hint;

use crate::mp4date;

/// Where the recording date came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DateOrigin {
    /// The `mvhd` `creation_time`.
    Mvhd,
    /// A date tag of the file.
    Tag,
    /// Modification date minus the duration: the person should check it.
    FileMtime,
}

/// What the import screen shows before the person confirms.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Probe {
    /// `None` when the container does not say and it cannot be counted.
    pub duration_ms: Option<u64>,
    pub has_audio: bool,
    /// The app converts to Opus; `false` falls back to copying the original.
    pub decodable: bool,
    /// Start of the recording, in ms since 1970.
    pub recorded_at: i64,
    pub date_origin: DateOrigin,
}

/// What `symphonia` read from the file.
struct Audio {
    duration_ms: Option<u64>,
    decodable: bool,
    tag_date: Option<i64>,
}

/// Reads the file without decoding the audio. The error is pt-BR UI copy (the import screen
/// shows it).
pub fn probe(path: &Path) -> Result<Probe> {
    let mp4 = mp4date::read(
        File::open(path).with_context(|| format!("falha ao abrir {}", path.display()))?,
    )
    .unwrap_or_else(|err| {
        log::warn!("unreadable MP4 in {}: {err}", path.display());
        None
    });
    let audio = match read_audio(path) {
        Ok(audio) => audio,
        Err(err) => {
            log::info!("symphonia cannot read {}: {err:#}", path.display());
            None
        }
    };
    // With no track symphonia recognizes, only MP4 says for sure that there is no sound; an
    // unknown container (AVI) goes on as audio and takes the fallback.
    let has_audio = audio.is_some() || mp4.is_none_or(|info| info.has_sound);
    let duration_ms = audio.as_ref().and_then(|a| a.duration_ms);

    let (recorded_at, date_origin) = if let Some(at) = mp4.and_then(|info| info.created_at_ms) {
        (at, DateOrigin::Mvhd)
    } else if let Some(at) = audio.as_ref().and_then(|a| a.tag_date) {
        (at, DateOrigin::Tag)
    } else {
        let modified = std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .unwrap_or_else(|_| SystemTime::now());
        let modified_ms = modified
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        let duration = i64::try_from(duration_ms.unwrap_or(0)).unwrap_or(0);
        (modified_ms - duration, DateOrigin::FileMtime)
    };

    Ok(Probe {
        duration_ms,
        has_audio,
        decodable: audio.is_some_and(|a| a.decodable),
        recorded_at,
        date_origin,
    })
}

/// The audio track `symphonia` recognizes; `Ok(None)` when there is none.
fn read_audio(path: &Path) -> Result<Option<Audio>> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    let Some(track) = audio_track(probed.format.tracks()).cloned() else {
        return Ok(None);
    };
    let codec = track.codec_params.codec;
    // symphonia only demuxes Opus: the recorder's libopus decodes it.
    let decodable =
        codec == CODEC_TYPE_OPUS || symphonia::default::get_codecs().get_codec(codec).is_some();

    let mut tag_date = probed
        .metadata
        .get()
        .and_then(|m| m.current().and_then(date_tag));
    if tag_date.is_none() {
        tag_date = probed.format.metadata().current().and_then(date_tag);
    }
    let duration_ms = duration_ms(&track).or_else(|| count_duration(&mut *probed.format, &track));
    Ok(Some(Audio {
        duration_ms,
        decodable,
        tag_date,
    }))
}

fn audio_track(tracks: &[Track]) -> Option<&Track> {
    tracks
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
}

/// The duration the container declares.
fn duration_ms(track: &Track) -> Option<u64> {
    let params = &track.codec_params;
    let frames = params.n_frames?;
    if let Some(time_base) = params.time_base {
        let time = time_base.calc_time(frames);
        return Some(time.seconds * 1000 + (time.frac * 1000.0).round() as u64);
    }
    let rate = u64::from(params.sample_rate?);
    Some(frames * 1000 / rate)
}

/// With no declared duration (WebM, for example), adds up the track's packets, without decoding.
fn count_duration(format: &mut dyn FormatReader, track: &Track) -> Option<u64> {
    let time_base = track.codec_params.time_base.or_else(|| {
        track
            .codec_params
            .sample_rate
            .map(|r| symphonia::core::units::TimeBase::new(1, r))
    })?;
    let mut end = 0;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() == track.id {
            end = end.max(packet.ts() + packet.dur());
        }
    }
    let time = time_base.calc_time(end);
    (end > 0).then(|| time.seconds * 1000 + (time.frac * 1000.0).round() as u64)
}

/// The first date tag with a full day.
fn date_tag(revision: &MetadataRevision) -> Option<i64> {
    // symphonia puts the ID3 `TDRC`/`TYER`, the Vorbis `DATE` and the MP4 `©day` in `Date`.
    [StandardTagKey::Date, StandardTagKey::OriginalDate]
        .into_iter()
        .find_map(|key| {
            revision
                .tags()
                .iter()
                .filter(|tag| tag.std_key == Some(key))
                .find_map(|tag| parse_date(&tag.value.to_string()))
        })
}

/// `YYYY-MM-DD`, with an optional time (`THH:MM[:SS]` or with a space), in UTC. With only the
/// day, noon UTC applies, which falls on the same day in every Brazilian time zone and most others.
pub(crate) fn parse_date(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    if !(1990..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let seconds_of_day = if matches!(bytes.get(10), Some(b'T' | b' ')) && bytes.len() >= 16 {
        let (hour, minute) = (number(11..13)?, number(14..16)?);
        let second = if bytes.get(16) == Some(&b':') {
            number(17..19)?
        } else {
            0
        };
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        hour * 3600 + minute * 60 + second
    } else {
        12 * 3600
    };
    Some((days_from_civil(year, month, day) * 86_400 + seconds_of_day) * 1000)
}

/// Days since 1970-01-01 in the Gregorian calendar (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    /// 2026-09-19T14:02:00Z.
    const MVHD_MS: i64 = 1_789_826_520_000;

    fn assert_two_seconds(probe: &Probe) {
        let ms = probe.duration_ms.expect("duration");
        assert!((1_950..=2_100).contains(&ms), "{ms} ms");
    }

    #[test]
    fn tag_dates() {
        assert_eq!(parse_date("2026-09-19T14:02:00Z"), Some(MVHD_MS));
        assert_eq!(parse_date("2026-09-19 14:02"), Some(MVHD_MS));
        assert_eq!(
            parse_date("2026-09-19"),
            Some(MVHD_MS - (2 * 3600 + 120) * 1000)
        );
        assert_eq!(parse_date("1970-01-01T00:00:00"), None);
        assert_eq!(parse_date("2026"), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("19/09/2026"), None);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn m4a_uses_the_mvhd() {
        let probe = probe(&fixture("tone.m4a")).unwrap();
        assert_two_seconds(&probe);
        assert!(probe.has_audio && probe.decodable);
        assert_eq!(probe.recorded_at, MVHD_MS);
        assert_eq!(probe.date_origin, DateOrigin::Mvhd);
    }

    #[test]
    fn mp3_and_ogg_use_the_tag() {
        let mp3 = probe(&fixture("tone.mp3")).unwrap();
        assert!(mp3.has_audio && mp3.decodable);
        assert_two_seconds(&mp3);
        assert_eq!(mp3.date_origin, DateOrigin::Tag);
        assert_eq!(Some(mp3.recorded_at), parse_date("2026-09-18"));

        let ogg = probe(&fixture("tone.ogg")).unwrap();
        assert!(ogg.decodable);
        assert_two_seconds(&ogg);
        assert_eq!(ogg.date_origin, DateOrigin::Tag);
        assert_eq!(Some(ogg.recorded_at), parse_date("2026-09-17"));
    }

    #[test]
    fn wav_falls_back_to_modification_date_minus_duration() {
        let path = fixture("tone.wav");
        let probe = probe(&path).unwrap();
        assert!(probe.has_audio && probe.decodable);
        assert_two_seconds(&probe);
        assert_eq!(probe.date_origin, DateOrigin::FileMtime);
        let modified = std::fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(
            probe.recorded_at,
            modified - probe.duration_ms.unwrap() as i64
        );
    }

    #[test]
    fn webm_with_opus_counts_the_duration_and_is_decodable() {
        let probe = probe(&fixture("tone.webm")).unwrap();
        assert!(probe.has_audio && probe.decodable);
        assert_two_seconds(&probe);
    }

    #[test]
    fn avi_does_not_decode_but_goes_on_as_audio() {
        let probe = probe(&fixture("tone.avi")).unwrap();
        assert!(probe.has_audio);
        assert!(!probe.decodable);
        assert_eq!(probe.date_origin, DateOrigin::FileMtime);
    }

    #[test]
    fn mp4_without_audio() {
        let probe = probe(&fixture("no-audio.mp4")).unwrap();
        assert!(!probe.has_audio);
        assert!(!probe.decodable);
    }

    #[test]
    fn missing_file_is_an_error() {
        assert!(probe(&fixture("does-not-exist.mp3")).is_err());
    }
}
