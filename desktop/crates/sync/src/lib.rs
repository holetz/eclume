//! Sync do app desktop do eclume: sobe as gravações da fila pelo upload resumível do contrato v1,
//! autenticado por PAT.

pub mod api;
pub mod protocol;
pub mod transport;

pub use protocol::{Client, RetryPolicy, Uploaded, PAT_PREFIX};
pub use transport::{HttpRequest, HttpResponse, Transport, UreqTransport};
