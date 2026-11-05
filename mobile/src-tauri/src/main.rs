// No extra console on Windows in release; the mobile app runs on desktop only for development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclume_mobile_lib::run();
}
