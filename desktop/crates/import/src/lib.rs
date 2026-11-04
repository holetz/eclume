//! Import of audio and video files in the desktop app: reading the duration and the recording
//! date ([`probe`]) before the person confirms, and the conversion to Opus ([`convert`]).

pub mod convert;
mod mp4date;
pub mod probe;

pub use convert::{convert, Cancelled, Converted};
pub use probe::{probe, DateOrigin, Probe};
