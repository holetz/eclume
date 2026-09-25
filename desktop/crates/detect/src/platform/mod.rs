//! Os sinais reais de cada SO. Só esta parte do crate toca o sistema; o resto é puro.
//!
//! | SO | Quem usa o mic | Títulos de janela |
//! |---|---|---|
//! | Linux | source-outputs do Pulse/PipeWire-Pulse que não leem um monitor | — (Wayland não deixa) |
//! | Windows | `ConsentStore\microphone` com `LastUsedTimeStop == 0` | `EnumWindows` |
//! | macOS | processos Core Audio com entrada ativa (14+); antes, `DeviceIsRunningSomewhere` | — (exige Gravação de Tela) |

use anyhow::Result;

use crate::classify::{is_self, AudioClient, SignalSource, Snapshot};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// A fonte de sinais do SO em que o app roda.
pub struct SystemSignals {
    own_pid: u32,
}

impl SystemSignals {
    pub fn new() -> Self {
        Self {
            own_pid: std::process::id(),
        }
    }
}

impl Default for SystemSignals {
    fn default() -> Self {
        Self::new()
    }
}

impl SignalSource for SystemSignals {
    fn snapshot(&mut self) -> Result<Snapshot> {
        let mut snapshot = platform_snapshot()?;
        snapshot.mic_users = without_self(snapshot.mic_users, self.own_pid);
        Ok(snapshot)
    }
}

/// Tira o próprio eclume e repetições (um app com vários streams abertos) da lista.
fn without_self(clients: Vec<AudioClient>, own_pid: u32) -> Vec<AudioClient> {
    let mut kept: Vec<AudioClient> = Vec::with_capacity(clients.len());
    for client in clients {
        if !is_self(&client, own_pid) && !kept.iter().any(|k| k.id == client.id) {
            kept.push(client);
        }
    }
    kept
}

#[cfg(target_os = "linux")]
fn platform_snapshot() -> Result<Snapshot> {
    linux::snapshot()
}

#[cfg(target_os = "windows")]
fn platform_snapshot() -> Result<Snapshot> {
    windows::snapshot()
}

#[cfg(target_os = "macos")]
fn platform_snapshot() -> Result<Snapshot> {
    macos::snapshot()
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn platform_snapshot() -> Result<Snapshot> {
    Ok(Snapshot::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tira_o_proprio_app_e_repeticoes() {
        let mut own = AudioClient::new("gravador", "gravador");
        own.pid = Some(10);
        let clients = vec![
            AudioClient::new("chrome", "Google Chrome"),
            own,
            AudioClient::new("chrome", "Google Chrome"),
            AudioClient::new("eclume-desktop", "eclume"),
        ];
        let kept = without_self(clients, 10);
        assert_eq!(kept, vec![AudioClient::new("chrome", "Google Chrome")]);
    }
}
