/// Nome exibido na janela e, depois, na bandeja do sistema.
pub const APP_NAME: &str = "eclume";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app desktop do eclume");
}

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn nome_do_app() {
        assert_eq!(APP_NAME, "eclume");
    }
}
