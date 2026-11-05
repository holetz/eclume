// The commands the UI calls straight on the native plugin; the app's Rust calls the others through
// `run_mobile_plugin`, without going through a capability permission. The names are the IPC
// contract and are kept.
const COMMANDS: &[&str] = &[
    "check_permissions",
    "request_permissions",
    "estado_do_dispositivo",
    "abrir_configuracoes_do_app",
    "pedir_isencao_de_bateria",
    "consumir_atalho",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
