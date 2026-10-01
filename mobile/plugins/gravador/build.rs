// Os comandos que a UI chama direto no plugin nativo; os demais o Rust do app chama por
// `run_mobile_plugin`, sem passar por permissão de capability.
const COMMANDS: &[&str] = &[
    "check_permissions",
    "request_permissions",
    "estado_do_dispositivo",
    "abrir_configuracoes_do_app",
    "pedir_isencao_de_bateria",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
