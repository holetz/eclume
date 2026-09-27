//! Núcleo de gravação do app desktop do eclume, sem dispositivo de áudio: mixagem das fontes,
//! codificação em Ogg/Opus mono 16 kHz, fila local de gravações e as interfaces que a spec
//! `desktop-deteccao-e-sync` implementa.

pub mod encode;
pub mod ext;
pub mod mix;
pub mod queue;
pub mod session;
pub mod source;
pub mod vad;

pub use eclume_audio_capture::AudioSource;
pub use encode::OggOpusWriter;
pub use ext::{sync_pending, MeetingDetector, MeetingEvent, SyncReport, Uploader};
pub use mix::{Mixer, FRAME, TARGET_RATE};
pub use queue::{
    now_ms, retry_backoff_ms, Kind, Marker, NewImport, Queue, QueueCounts, QueuedRecording,
    RecordedAtSource, Source, Status, MAX_MARKER_NOTE,
};
pub use session::{ActiveRecording, RecorderConfig};
pub use vad::{SilenceDetector, VadEvent, METER_BARS};
