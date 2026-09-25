// fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:crates/detect/src/list/macos.rs
// fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:crates/detect/src/mic/macos/device.rs
//! Quem usa o mic no macOS: os objetos de processo do Core Audio (macOS 14+) com entrada ativa.
//! Onde a lista de processos não existe, sobra o estado do dispositivo de entrada padrão
//! (`DeviceIsRunningSomewhere`), sem dono — e aí a lista de processos em execução ajuda a dizer
//! qual app de reunião é.

use anyhow::Result;
use cidre::core_audio as ca;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::classify::{AudioClient, Snapshot};

const IS_RUNNING_SOMEWHERE: ca::PropAddr = ca::PropAddr {
    selector: ca::PropSelector::DEVICE_IS_RUNNING_SOMEWHERE,
    scope: ca::PropScope::GLOBAL,
    element: ca::PropElement::MAIN,
};

pub(super) fn snapshot() -> Result<Snapshot> {
    let Ok(processes) = ca::System::processes() else {
        return Ok(device_only());
    };
    let inputs: Vec<(i32, Option<String>)> = processes
        .iter()
        .filter(|process| process.is_running_input().unwrap_or(false))
        .filter_map(|process| {
            let pid = process.pid().ok()?;
            let bundle = process.bundle_id().ok().map(|id| id.to_string());
            Some((pid, bundle))
        })
        .collect();
    if inputs.is_empty() {
        return Ok(Snapshot::default());
    }

    let pids: Vec<Pid> = inputs
        .iter()
        .filter_map(|(pid, _)| u32::try_from(*pid).ok().map(Pid::from_u32))
        .collect();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );
    let mic_users = inputs
        .into_iter()
        .map(|(pid, bundle)| {
            let pid = u32::try_from(pid).ok();
            let name = pid
                .and_then(|pid| system.process(Pid::from_u32(pid)))
                .map(|process| process.name().to_string_lossy().into_owned())
                .unwrap_or_default();
            let id = bundle
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| name.clone());
            let mut client = AudioClient::new(id, name);
            client.pid = pid;
            client
        })
        .collect();
    Ok(Snapshot {
        mic_users,
        ..Snapshot::default()
    })
}

/// macOS antes do 14: só dá para saber se o mic padrão está em uso por alguém.
fn device_only() -> Snapshot {
    let busy = ca::System::default_input_device()
        .and_then(|device| device.prop::<u32>(&IS_RUNNING_SOMEWHERE))
        .is_ok_and(|running| running != 0);
    if !busy {
        return Snapshot::default();
    }
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    Snapshot {
        mic_busy: true,
        processes: system
            .processes()
            .values()
            .map(|process| process.name().to_string_lossy().into_owned())
            .collect(),
        ..Snapshot::default()
    }
}
