//! eclume desktop sync: uploads queued recordings through the resumable upload of contract v1,
//! authenticated by a PAT or device credential stored in the OS keyring, and connects the device
//! (sign-in, pairing and server descriptor).

pub mod api;
pub mod devices;
pub mod discovery;
pub mod outcome;
pub mod pat;
pub mod pin;
pub mod protocol;
pub mod transport;
pub mod uploader;

pub use devices::{device_name, parse_pair_url, platform, Devices, PairUrl};
pub use outcome::{outcome_of, Ended, Outcome, Watermark};
pub use pat::{PatSource, PatStore};
pub use protocol::{
    Client, LibrarySummary, MissingScope, ProcessorStatus, QueueWait, RetryPolicy, Uploaded,
    PAT_PREFIX,
};
pub use transport::{HttpRequest, HttpResponse, Transport, TrustMode, UreqTransport};
pub use uploader::{HttpUploader, UploaderConfig};
