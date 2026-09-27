//! Importação de arquivos de áudio e vídeo no app desktop: a leitura da duração e da data de
//! gravação ([`probe`]) antes de a pessoa confirmar.

mod mp4date;
pub mod probe;

pub use probe::{probe, DateOrigin, Probe};
