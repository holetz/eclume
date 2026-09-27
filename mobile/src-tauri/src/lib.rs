//! O app móvel do eclume: a casca Tauri sobre o `eclume-mobile-core`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app móvel do eclume");
}
