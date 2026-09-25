//! Detecção de reuniões do app desktop do eclume.
//!
//! Os sinais do SO (quem usa o mic, processos, títulos de janela) viram um [`Snapshot`];
//! [`classify`] decide se há reunião e em qual app.

pub mod classify;

pub use classify::{classify, is_self, AppKey, AudioClient, SignalSource, Snapshot};
