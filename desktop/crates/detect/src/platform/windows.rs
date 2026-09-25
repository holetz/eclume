//! Quem usa o mic no Windows: o `ConsentStore` do Capability Access Manager (o mesmo registro
//! que acende o ícone de microfone na bandeja) marca `LastUsedTimeStop = 0` enquanto um app está
//! com o mic aberto. Apps empacotados ficam em subchaves com o nome do pacote
//! (`MSTeams_8wekyb3d8bbwe`); os demais, em `NonPackaged`, com o caminho do executável e `#` no
//! lugar de `\`.

use anyhow::{Context as _, Result};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::classify::{wants_window_titles, AudioClient, Snapshot};

const CONSENT_STORE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
const NON_PACKAGED: &str = "NonPackaged";

pub(super) fn snapshot() -> Result<Snapshot> {
    let store = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(CONSENT_STORE)
        .context("falha ao abrir o ConsentStore do microfone")?;
    let mut users = Vec::new();
    for name in store.enum_keys().flatten() {
        let Ok(key) = store.open_subkey(&name) else {
            continue;
        };
        if name == NON_PACKAGED {
            for exe in key.enum_keys().flatten() {
                if key.open_subkey(&exe).is_ok_and(|app| in_use(&app)) {
                    users.push(non_packaged(&exe));
                }
            }
        } else if in_use(&key) {
            let family = name.split('_').next().unwrap_or(&name).to_string();
            users.push(AudioClient::new(name, family));
        }
    }
    let window_titles = if wants_window_titles(&users) {
        window_titles()
    } else {
        Vec::new()
    };
    Ok(Snapshot {
        mic_users: users,
        window_titles,
        ..Snapshot::default()
    })
}

/// Em uso: começou e ainda não parou.
fn in_use(key: &RegKey) -> bool {
    let started = key.get_value::<u64, _>("LastUsedTimeStart").unwrap_or(0);
    let stopped = key.get_value::<u64, _>("LastUsedTimeStop").ok();
    started > 0 && stopped == Some(0)
}

/// `C:#Program Files#Zoom#bin#Zoom.exe` → id com o caminho, nome `Zoom`.
fn non_packaged(key_name: &str) -> AudioClient {
    let path = key_name.replace('#', "\\");
    let file = path.rsplit('\\').next().unwrap_or(&path);
    let name = file
        .strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".EXE"))
        .unwrap_or(file)
        .to_string();
    AudioClient::new(path, name)
}

fn window_titles() -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    // SAFETY: o callback só roda durante o `EnumWindows`, enquanto `titles` está vivo, e é o
    // único a acessá-lo pelo ponteiro.
    unsafe {
        EnumWindows(
            Some(collect_title),
            &mut titles as *mut Vec<String> as LPARAM,
        );
    }
    titles
}

unsafe extern "system" fn collect_title(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` é o `&mut Vec<String>` passado por `window_titles`.
    let titles = unsafe { &mut *(lparam as *mut Vec<String>) };
    // SAFETY: `hwnd` vem do `EnumWindows` e o buffer tem o tamanho informado.
    unsafe {
        if IsWindowVisible(hwnd) != 0 {
            let mut buffer = [0_u16; 512];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            if let Ok(len) = usize::try_from(len) {
                if len > 0 {
                    titles.push(String::from_utf16_lossy(&buffer[..len]));
                }
            }
        }
    }
    1
}
