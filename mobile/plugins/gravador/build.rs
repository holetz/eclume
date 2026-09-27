// Os comandos que a UI chama direto no plugin nativo; os demais o Rust do app chama por
// `run_mobile_plugin`, sem passar por permissão de capability.
const COMMANDS: &[&str] = &["check_permissions", "request_permissions"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
