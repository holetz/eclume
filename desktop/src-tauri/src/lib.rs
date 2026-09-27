//! App desktop do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus, percebe sozinho
//! quando uma reunião começa, mantém a fila local de gravações, sobe-as ao servidor por PAT e
//! fica na bandeja do sistema.

mod auto;
pub mod capture;
mod commands;
pub mod config;
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
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
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
        if let Err(err) = app
            .state::<AppState>()
            .toggle_recording(capture::open_sources)
        {
            log::error!("falha ao alternar a gravação: {err:#}");
        }
        sync::nudge(&app);
        refresh_ui(&app);
    });
}

/// "Nova nota", da janela, da bandeja ou do atalho: começa uma nota ou para a nota em curso. O
/// resultado sai por notificação, porque o atalho não abre a janela.
pub(crate) fn toggle_note(app: &AppHandle) -> anyhow::Result<()> {
    let result = app.state::<AppState>().toggle_note(capture::open_mic);
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            init_logging(&app.path().app_log_dir()?);
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let state = AppState::open(&data_dir, &config_dir)?;
            log::info!("dados em {}", data_dir.display());
            app.manage(state);
            tray::build(app.handle())?;
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
            // Fechar a janela só a esconde: o app segue na bandeja.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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
            commands::open_web,
            commands::settings,
            commands::save_settings,
            commands::answer_meeting,
            commands::sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o app desktop do eclume");
}

#[cfg(test)]
mod tests {
    use super::{open_log, APP_NAME, LOG_FILE};

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
