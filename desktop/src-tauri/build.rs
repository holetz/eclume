fn main() {
    // The server embedded in the installer (`config::embedded_server`): per-server releases
    // pass repository variables to `tauri build`.
    println!("cargo:rerun-if-env-changed=ECLUME_SERVER_URL");
    println!("cargo:rerun-if-env-changed=ECLUME_SERVER_CA_SHA256");
    tauri_build::build();
}
