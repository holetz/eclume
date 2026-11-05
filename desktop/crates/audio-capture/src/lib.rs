//! Audio capture for the eclume desktop app.
//!
//! Two sources, each delivering mono `f32` samples at the device's native rate:
//!
//! - [`MicSource`]: the selected or default input device, through `cpal`
//!   ([`list_input_devices`] lists the names);
//! - [`SystemSource`]: audio the system is playing (loopback), per platform —
//!   PipeWire/Pulse on Linux, WASAPI on Windows, Core Audio tap on macOS; follows the active output
//!   or a selected output ([`list_output_devices`] lists the ids).
//!
//! Consumers only know the [`AudioSource`] trait; without the `backends` feature, this crate
//! exposes only the trait and ring buffer ([`ring`]), with no system dependencies. The `mic`
//! feature
//! enables only [`MicSource`] (the mobile app).

use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub mod ring;

#[cfg(feature = "mic")]
mod mic;
pub mod reconnect;
#[cfg(feature = "backends")]
mod system;

#[cfg(feature = "mic")]
pub use mic::{InputDevices, MicSource, list_input_devices};
#[cfg(feature = "backends")]
pub use system::{OutputDevice, OutputDevices, SystemSource, list_output_devices};

/// A source's current state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceState {
    /// Delivering audio from the device.
    Live,
    /// The device disconnected at `since`; the source tries to reopen it, delivering silence
    /// meanwhile.
    Reconnecting { since: Instant },
}

/// A mono audio source the recorder reads by pulling.
pub trait AudioSource: Send {
    /// Current rate in Hz. May change during capture (device switch); the consumer must
    /// query it on every read.
    fn sample_rate(&self) -> u32;

    /// Waits up to `timeout` for samples and returns those available.
    ///
    /// `Some(vec![])` means the timeout expired without samples (the source is still alive, for
    /// example
    /// a suspended sink monitor). `None` means the source has ended and will deliver no more
    /// samples.
    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>>;

    /// Whether the source is delivering device audio or reconnecting. A source that never
    /// reconnects is
    /// always [`SourceState::Live`].
    fn state(&self) -> SourceState {
        SourceState::Live
    }

    /// Samples dropped (ring buffer full) since startup.
    fn dropped_samples(&self) -> u64 {
        0
    }
}

impl<T: AudioSource + ?Sized> AudioSource for Box<T> {
    fn sample_rate(&self) -> u32 {
        (**self).sample_rate()
    }

    fn read(&mut self, timeout: Duration) -> Option<Vec<f32>> {
        (**self).read(timeout)
    }

    fn state(&self) -> SourceState {
        (**self).state()
    }

    fn dropped_samples(&self) -> u64 {
        (**self).dropped_samples()
    }
}

/// Maximum time stopping waits for the capture thread (the driver to release the device).
pub const STOP_DEADLINE: Duration = Duration::from_secs(3);

/// Waits up to `deadline` for the thread to finish. On timeout (a driver stuck releasing the
/// device), logs a warning, detaches the thread and returns `None`; stopping never waits
/// indefinitely.
pub fn join_with_deadline<T>(
    handle: JoinHandle<T>,
    deadline: Duration,
) -> Option<std::thread::Result<T>> {
    let until = Instant::now() + deadline;
    while !handle.is_finished() {
        if Instant::now() >= until {
            log::warn!(
                "thread {} did not finish within {deadline:?}; continuing without it",
                handle.thread().name().unwrap_or("capture")
            );
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Some(handle.join())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_with_deadline_detaches_stuck_thread() {
        let stuck = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(10)));
        let started = Instant::now();
        assert!(join_with_deadline(stuck, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn join_with_deadline_returns_thread_result() {
        let done = std::thread::spawn(|| 42);
        assert_eq!(
            join_with_deadline(done, STOP_DEADLINE).map(Result::unwrap),
            Some(42)
        );
    }
}
