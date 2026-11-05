//! Meeting detection for the eclume desktop app.
//!
//! OS signals (mic users, processes, window titles) become a [`Snapshot`];
//! [`classify`] decides whether there is a meeting and in which app; [`Debouncer`] turns it into
//! start and end `MeetingEvent`s; and [`AutoRecorder`] applies per-app policies and tells the app
//! whether to start, stop or ask.

pub mod auto;
pub mod classify;
pub mod debounce;
pub mod platform;

pub use auto::{default_policy, Action, AutoRecorder, DetectionConfig, Policy, Recording};
pub use classify::{
    classify, is_self, wants_window_titles, AppKey, AudioClient, SignalSource, Snapshot,
};
pub use debounce::{DebounceConfig, DebouncedDetector, Debouncer};
pub use platform::SystemSignals;
