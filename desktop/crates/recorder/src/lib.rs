//! Recording core of the eclume desktop app, without audio devices: source mixing, mono 16 kHz
//! Ogg/Opus encoding, a local recording queue, and upload and meeting detection interfaces
//! (`ext`).

pub mod encode;
pub mod ext;
pub mod mix;
pub mod queue;
pub mod session;
pub mod source;
pub mod vad;

pub use eclume_audio_capture::{AudioSource, SourceState};
pub use encode::OggOpusWriter;
pub use ext::{
    is_interrupted, sync_pending, MeetingDetector, MeetingEvent, SyncInterrupted, SyncReport,
    Uploader,
};
pub use mix::{Mixer, TARGET_RATE};
pub use queue::{
    now_ms, Kind, Marker, NewImport, Queue, QueueCounts, QueuedRecording, RecordedAtSource, Source,
    Status,
};
pub use session::{ActiveRecording, RecorderConfig};
pub use vad::{SilenceDetector, METER_BARS};
