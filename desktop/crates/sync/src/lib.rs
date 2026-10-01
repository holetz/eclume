//! Sync do app desktop do eclume: sobe as gravações da fila pelo upload resumível do contrato v1,
//! autenticado por PAT ou credencial de dispositivo guardados no chaveiro do SO, e a ligação do
//! aparelho (login, pareamento e descritor do servidor).

pub mod api;
pub mod devices;
pub mod discovery;
pub mod pat;
pub mod pin;
pub mod protocol;
pub mod transport;
pub mod uploader;

pub use devices::{device_name, parse_pair_url, platform, Devices, PairUrl};
pub use pat::{PatSource, PatStore};
pub use protocol::{
    Client, LibrarySummary, MissingScope, ProcessorStatus, QueueWait, RecordingCheck, RetryPolicy,
    SummaryPoll, Uploaded, PAT_PREFIX,
};
pub use transport::{HttpRequest, HttpResponse, Transport, TrustMode, UreqTransport};
pub use uploader::{HttpUploader, UploaderConfig};
