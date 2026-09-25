//! Detecção de reuniões do app desktop do eclume.
//!
//! Os sinais do SO (quem usa o mic, processos, títulos de janela) viram um [`Snapshot`];
//! [`classify`] decide se há reunião e em qual app; o [`Debouncer`] transforma isso em
//! `MeetingEvent`s de início e fim; e o [`AutoRecorder`] aplica as políticas por app e diz ao app
//! se inicia, para ou pergunta.

pub mod auto;
pub mod classify;
pub mod debounce;

pub use auto::{default_policy, Action, AutoRecorder, DetectionConfig, Policy, Recording};
pub use classify::{classify, is_self, AppKey, AudioClient, SignalSource, Snapshot};
pub use debounce::{DebounceConfig, DebouncedDetector, Debouncer};
