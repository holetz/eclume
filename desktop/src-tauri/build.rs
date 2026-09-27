fn main() {
    // O servidor embutido no instalador (`config::embedded_server`): o release por servidor
    // passa as variáveis do repositório ao `tauri build`.
    println!("cargo:rerun-if-env-changed=ECLUME_SERVER_URL");
    println!("cargo:rerun-if-env-changed=ECLUME_SERVER_CA_SHA256");
    tauri_build::build();
}
