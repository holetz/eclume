//! Real signals from each OS. Only this part of the crate touches the system; the rest is pure.
//!
//! | OS | Mic users | Window titles |
//! |---|---|---|
//! | Linux | Pulse/PipeWire-Pulse source-outputs not reading a monitor | — (blocked by Wayland) |
//! | Windows | `ConsentStore\microphone` with `LastUsedTimeStop == 0` | `EnumWindows` |
//! | macOS | Core Audio input (14+); else `DeviceIsRunningSomewhere` | — (permission needed) |
//!
//! macOS window titles require Screen Recording permission.

use anyhow::Result;

use crate::classify::{is_self, AudioClient, SignalSource, Snapshot};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// The signal source for the OS running the app.
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

/// Removes eclume itself and duplicates (an app with multiple open streams) from the list.
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
    fn removes_own_app_and_duplicates() {
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
