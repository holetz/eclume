// Sem console extra no Windows em build de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclume_desktop_lib::run();
}
