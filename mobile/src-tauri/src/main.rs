// Sem console extra no Windows em release; o app móvel roda no desktop só para desenvolvimento.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclume_mobile_lib::run();
}
