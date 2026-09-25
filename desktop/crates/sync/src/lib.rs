//! Sync do app desktop do eclume: sobe as gravações da fila pelo upload resumível do contrato v1,
//! autenticado por PAT guardado no chaveiro do SO.

pub mod api;
pub mod pat;
pub mod protocol;
pub mod transport;
pub mod uploader;

pub use pat::{PatSource, PatStore};
pub use protocol::{Client, RetryPolicy, Uploaded, PAT_PREFIX};
pub use transport::{HttpRequest, HttpResponse, Transport, UreqTransport};
pub use uploader::{HttpUploader, UploaderConfig};
