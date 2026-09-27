//! App desktop do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus, percebe sozinho
//! quando uma reunião começa, mantém a fila local de gravações, sobe-as ao servidor com a
//! credencial de dispositivo (ou o PAT de uma versão anterior) e fica na bandeja do sistema.

mod account;
mod auto;
pub mod capture;
mod commands;
pub mod config;
mod import;
mod notify;
pub mod shortcuts;
pub mod state;
mod sync;
mod tray;
mod updater;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::state::{AppState, Busy, NoteToggle, Reaped};

/// Nome exibido na janela e na bandeja do sistema.
pub const APP_NAME: &str = "eclume";

/// Evento que a janela escuta para se atualizar.
const STATUS_EVENT: &str = "status-changed";

/// Atualiza tudo que mostra o estado: a bandeja e a janela.
pub(crate) fn refresh_ui(app: &AppHandle) {
    tray::refresh(app);
    let _ = app.emit(STATUS_EVENT, ());
}

/// Mostra e foca a janela principal (criada oculta).
pub(crate) fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Abre o eclume web no navegador padrão.
pub(crate) fn open_web(app: &AppHandle, state: &AppState) -> anyhow::Result<()> {
    let url = state.web_url()?;
    app.opener()
        .open_url(&url, None::<&str>)
        .with_context(|| format!("falha ao abrir {url}"))
}

/// Inicia ou para a gravação, da bandeja ou do atalho. Abrir dispositivos pode levar segundos:
/// fora da thread da UI.
pub(crate) fn spawn_toggle_recording(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = state
            .audio_choice()
            .and_then(|choice| state.toggle_recording(|| capture::open_sources(&choice)));
        if let Err(err) = result {
            log::error!("falha ao alternar a gravação: {err:#}");
        }
        sync::nudge(&app);
        refresh_ui(&app);
    });
}

/// "Nova nota", da janela, da bandeja ou do atalho: começa uma nota ou para a nota em curso. O
/// resultado sai por notificação, porque o atalho não abre a janela.
pub(crate) fn toggle_note(app: &AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let result = state
        .audio_choice()
        .and_then(|choice| state.toggle_note(|| capture::open_mic(&choice)));
    match &result {
        Ok(NoteToggle::Started) => {}
        Ok(NoteToggle::Stopped(recording)) => notify::note_saved(recording.duration_ms),
        Err(err) if err.is::<Busy>() => notify::busy(),
        Err(err) => notify::info("Não deu para gravar a nota", &format!("{err:#}")),
    }
    sync::nudge(app);
    refresh_ui(app);
    result.map(|_| ())
}

/// Marcador pela bandeja ou pelo atalho: não abre nada nem notifica, para não atrapalhar a reunião.
pub(crate) fn add_marker(app: &AppHandle) {
    match app.state::<AppState>().add_marker(None) {
        Ok(marker) => log::info!("marcador em {} ms", marker.at_ms),
        Err(err) => log::warn!("marcador ignorado: {err:#}"),
    }
    refresh_ui(app);
}

/// O endereço de um artigo da central de ajuda do servidor; sem artigo, a central.
pub(crate) fn help_url(web_url: &str, article: Option<&str>) -> anyhow::Result<String> {
    let base = format!("{}/ajuda", web_url.trim_end_matches('/'));
    match article {
        None => Ok(base),
        Some(slug)
            if !slug.is_empty()
                && slug
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') =>
        {
            Ok(format!("{base}/{slug}"))
        }
        Some(slug) => anyhow::bail!("artigo de ajuda inválido: {slug}"),
    }
}

/// Arquivo de log, no diretório de logs do app.
const LOG_FILE: &str = "eclume.log";
/// Acima disso, o log vira `eclume.log.1` ao abrir o app.
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Liga o log (`info`, ou o que `RUST_LOG` pedir) no stderr e em `<dir>/eclume.log`: no Windows o
/// release não tem console, e sem o arquivo nenhuma falha ficaria registrada.
fn init_logging(dir: &Path) {
    let builder =
        &mut env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    match open_log(dir, LOG_MAX_BYTES) {
        Ok(file) => {
            builder.target(env_logger::Target::Pipe(Box::new(Tee(file))));
        }
        Err(err) => eprintln!("log só no stderr: falha ao abrir {}: {err}", dir.display()),
    }
    let _ = builder.try_init();
}

/// Abre o log para acréscimo, girando para `.1` o que passou de `max_bytes`.
fn open_log(dir: &Path, max_bytes: u64) -> io::Result<File> {
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > max_bytes) {
        fs::rename(&path, dir.join(format!("{LOG_FILE}.1")))?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Escreve no arquivo e, quando houver, no stderr.
struct Tee(File);

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stderr().write_all(buf);
        self.0.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// Fecha, a cada segundo, a gravação que terminou sozinha: fontes que caíram ou a nota que parou
/// no silêncio (a nota sem voz é descartada).
fn spawn_reaper(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        match app.state::<AppState>().reap_finished() {
            Ok(Some(reaped)) => {
                match reaped {
                    Reaped::NoteSaved(recording) => notify::note_saved(recording.duration_ms),
                    Reaped::NoteDiscarded => notify::note_discarded(),
                    Reaped::SourcesEnded(_) => {}
                }
                sync::nudge(&app);
                refresh_ui(&app);
            }
            Ok(None) => {}
            Err(err) => log::error!("falha ao fechar gravação encerrada: {err:#}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            init_logging(&app.path().app_log_dir()?);
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::open(&data_dir, &config_dir)?;
            log::info!("dados em {}", data_dir.display());
            let updated = state.take_update_notification()?;
            app.manage(state);
            tray::build(app.handle())?;
            if let Some(update) = updated {
                notify::info(
                    &format!("eclume atualizado para {}", update.version),
                    update
                        .notes
                        .as_deref()
                        .unwrap_or("Veja as novidades na janela do eclume."),
                );
            }
            shortcuts::init(app.handle());
            // No macOS, o app vive na barra de menus, sem ícone no Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            spawn_reaper(app.handle().clone());
            sync::spawn(app.handle());
            auto::spawn(app.handle().clone());
            sync::nudge(app.handle());
            updater::spawn(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Fechar a janela só a esconde: o app segue na bandeja.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Um arquivo arrastado para a janela abre a importação (o primeiro, se vierem
                // vários).
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    if let Some(path) = paths.first() {
                        import::open_in_window(window.app_handle(), path);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::recordings,
            commands::toggle_recording,
            commands::new_note,
            commands::note_meter,
            commands::add_marker,
            commands::set_marker_note,
            commands::pick_import_file,
            commands::probe_import,
            commands::import_file,
            commands::cancel_import,
            commands::open_help,
            commands::open_log_dir,
            commands::open_web,
            commands::settings,
            commands::save_settings,
            commands::answer_meeting,
            commands::sync_now,
            commands::dismiss_update_notice,
            commands::storage_info,
            commands::list_input_devices,
            commands::mic_test,
            commands::mic_test_meter,
            commands::open_data_dir,
            commands::discover_servers,
            commands::prepare_server,
            commands::confirm_server,
            commands::sign_in,
            commands::pair,
            commands::sign_out,
            commands::test_connection,
            commands::open_signup,
            commands::pick_ca_file,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app desktop do eclume");
}

#[cfg(test)]
mod tests {
    use super::{help_url, open_log, APP_NAME, LOG_FILE};

    #[test]
    fn endereco_da_ajuda() {
        assert_eq!(
            help_url("https://192.168.15.199:8443/", None).unwrap(),
            "https://192.168.15.199:8443/ajuda"
        );
        assert_eq!(
            help_url("https://eclume.local", Some("primeiros-passos")).unwrap(),
            "https://eclume.local/ajuda/primeiros-passos"
        );
        assert!(help_url("https://eclume.local", Some("../admin")).is_err());
        assert!(help_url("https://eclume.local", Some("")).is_err());
    }

    #[test]
    fn nome_do_app() {
        assert_eq!(APP_NAME, "eclume");
    }

    #[test]
    fn log_acrescenta_e_gira_o_que_passou_do_limite() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("eclume-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        writeln!(open_log(&dir, 16).unwrap(), "primeira linha").unwrap();
        writeln!(open_log(&dir, 64).unwrap(), "segunda").unwrap();
        let atual = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(atual, "primeira linha\nsegunda\n");

        open_log(&dir, 16).unwrap();
        let girado = std::fs::read_to_string(dir.join(format!("{LOG_FILE}.1"))).unwrap();
        assert_eq!(girado, "primeira linha\nsegunda\n");
        assert_eq!(std::fs::read_to_string(dir.join(LOG_FILE)).unwrap(), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
