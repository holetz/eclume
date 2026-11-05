//! The recording's estimates and limits: how much time fits in the free space, how long the battery
//! lasts and when to warn or stop on its own.
//!
//! The serialized field names are read by the UI and keep their original (pt-BR) names.

use serde::Serialize;

/// Below this, the home screen warns "Armazenamento quase cheio".
pub const STORAGE_WARNING_S: u64 = 60 * 60;
/// Below this, while recording, the app stops and saves on its own.
pub const STORAGE_STOP_S: u64 = 5 * 60;
/// Battery at or below this level, discharging, shows the banner during the recording.
pub const BATTERY_WARNING_PCT: u8 = 15;
/// The minimum battery-drop sample to estimate from.
pub const BATTERY_SAMPLE_MS: i64 = 10 * 60 * 1_000;

/// Seconds of recording that fit in `free` bytes at `bitrate` bits/s.
pub fn seconds_that_fit(free: u64, bitrate: i32) -> u64 {
    let bytes_per_second = u64::try_from(bitrate.max(1)).unwrap_or(1) / 8;
    free / bytes_per_second.max(1)
}

/// "cerca de 9 h", "cerca de 40 min", "menos de 1 min" (copy the UI shows).
pub fn about(seconds: u64) -> String {
    let minutes = seconds / 60;
    if minutes < 1 {
        "menos de 1 min".into()
    } else if minutes < 60 {
        format!("cerca de {minutes} min")
    } else {
        format!("cerca de {} h", (minutes + 30) / 60)
    }
}

/// One battery reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatteryReading {
    pub at_ms: i64,
    pub pct: u8,
    pub charging: bool,
}

/// The drop measured since the recording started.
#[derive(Clone, Debug, Default)]
pub struct Battery {
    start: Option<BatteryReading>,
    last: Option<BatteryReading>,
}

impl Battery {
    /// Restarts the measurement (when recording starts).
    pub fn restart(&mut self) {
        self.start = None;
    }

    pub fn record(&mut self, reading: BatteryReading) {
        // Charging invalidates the drop measured until then.
        if reading.charging || self.start.is_none_or(|s| reading.pct > s.pct) {
            self.start = (!reading.charging).then_some(reading);
        }
        self.last = Some(reading);
    }

    /// Minutes the battery still lasts, by the measured drop; `None` before a 10-minute sample or
    /// with no drop.
    pub fn minutes_left(&self) -> Option<u64> {
        let (start, last) = (self.start?, self.last?);
        let elapsed = last.at_ms - start.at_ms;
        let drop = start.pct.checked_sub(last.pct)?;
        if elapsed < BATTERY_SAMPLE_MS || drop == 0 || last.charging {
            return None;
        }
        let ms_per_point = elapsed / i64::from(drop);
        u64::try_from(i64::from(last.pct) * ms_per_point / 60_000).ok()
    }

    pub fn last(&self) -> Option<BatteryReading> {
        self.last
    }
}

/// The warnings the UI shows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Warnings {
    /// The storage-almost-full warning, with the recording time left.
    #[serde(rename = "armazenamento")]
    pub storage: Option<StorageWarning>,
    /// The low-battery warning, with the time left.
    #[serde(rename = "bateria")]
    pub battery: Option<BatteryWarning>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageWarning {
    #[serde(rename = "restante")]
    pub remaining: String,
    /// Bytes that "Excluir sincronizadas" frees.
    #[serde(rename = "sincronizadas_bytes")]
    pub synced_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BatteryWarning {
    pub pct: u8,
    /// `None` before there is a sample to estimate from.
    #[serde(rename = "restante")]
    pub remaining: Option<String>,
}

/// The storage warning, when what fits is below one hour.
pub fn storage_warning(free: u64, bitrate: i32, synced_bytes: u64) -> Option<StorageWarning> {
    let seconds = seconds_that_fit(free, bitrate);
    (seconds < STORAGE_WARNING_S).then(|| StorageWarning {
        remaining: about(seconds),
        synced_bytes,
    })
}

/// The battery warning, while recording: low level and discharging.
pub fn battery_warning(battery: &Battery) -> Option<BatteryWarning> {
    let last = battery.last()?;
    (last.pct <= BATTERY_WARNING_PCT && !last.charging).then(|| BatteryWarning {
        pct: last.pct,
        remaining: battery.minutes_left().map(|m| about(m * 60)),
    })
}

/// While recording, the space ran out: stop and save on its own.
pub fn should_stop_for_storage(free: u64, bitrate: i32) -> bool {
    seconds_that_fit(free, bitrate) < STORAGE_STOP_S
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    #[test]
    fn hours_that_fit_in_the_free_space() {
        // 24 kbps = 3,000 B/s = 10.8 MB per hour.
        assert_eq!(seconds_that_fit(108_000_000, 24_000), 36_000);
        assert_eq!(about(seconds_that_fit(97_200_000, 24_000)), "cerca de 9 h");
        assert_eq!(about(40 * 60), "cerca de 40 min");
        assert_eq!(about(30), "menos de 1 min");
    }

    #[test]
    fn storage_warnings_and_stop() {
        assert_eq!(storage_warning(GB, 24_000, 0), None);
        let warning = storage_warning(7_200_000, 24_000, 1_100_000_000).unwrap();
        assert_eq!(warning.remaining, "cerca de 40 min");
        assert_eq!(warning.synced_bytes, 1_100_000_000);
        assert!(!should_stop_for_storage(7_200_000, 24_000));
        assert!(should_stop_for_storage(800_000, 24_000));
    }

    #[test]
    fn battery_only_estimates_after_ten_minutes_of_drop() {
        let mut battery = Battery::default();
        let reading = |min: i64, pct: u8| BatteryReading {
            at_ms: min * 60_000,
            pct,
            charging: false,
        };
        battery.record(reading(0, 20));
        battery.record(reading(5, 18));
        assert_eq!(battery.minutes_left(), None);
        assert_eq!(battery_warning(&battery), None);
        // 20 → 12 % in 32 min: 4 min per point, 12 points = 48 min.
        battery.record(reading(32, 12));
        assert_eq!(battery.minutes_left(), Some(48));
        let warning = battery_warning(&battery).unwrap();
        assert_eq!(
            (warning.pct, warning.remaining.as_deref()),
            (12, Some("cerca de 48 min"))
        );

        // Plugged in, there is neither warning nor estimate.
        battery.record(BatteryReading {
            charging: true,
            ..reading(33, 12)
        });
        assert_eq!(battery_warning(&battery), None);
        battery.record(reading(34, 12));
        assert_eq!(battery_warning(&battery).unwrap().remaining, None);
    }
}
