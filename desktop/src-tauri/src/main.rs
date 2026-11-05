// No extra console on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclume_desktop_lib::run();
}
