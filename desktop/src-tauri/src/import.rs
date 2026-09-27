//! Importar arquivo: o diálogo nativo (janela, bandeja e `Ctrl+O`), o arrastar para a janela e a
//! conversão em segundo plano, com o progresso por evento. A janela não tem API de arquivo: ela
//! só recebe caminhos do Rust.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use eclume_import::{Cancelled, Probe};
use eclume_recorder::RecordedAtSource;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Um arquivo para a vista de importação abrir (arrastado ou escolhido pela bandeja).
pub const OPEN_EVENT: &str = "import-dropped";
const PROGRESS_EVENT: &str = "import-progress";
const FINISHED_EVENT: &str = "import-finished";
const FAILED_EVENT: &str = "import-failed";

/// O filtro do diálogo: os formatos que o app converte e os que ele copia para o servidor.
pub const EXTENSIONS: [&str; 20] = [
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "weba", "wma", "amr", "ac3", "mp4",
    "m4v", "mov", "webm", "mkv", "avi", "wmv", "3gp",
];

/// O que a vista mostra antes da confirmação.
#[derive(Clone, Debug, Serialize)]
pub struct ImportPreview {
    pub path: PathBuf,
    /// O nome do arquivo, com extensão.
    pub name: String,
    #[serde(flatten)]
    pub probe: Probe,
}

/// Lê o arquivo escolhido.
pub fn preview(path: &Path) -> Result<ImportPreview> {
    Ok(ImportPreview {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        probe: eclume_import::probe(path)?,
        path: path.to_path_buf(),
    })
}

/// A data vem do arquivo confirmada ou digitada; a do relógio da captura não vale aqui.
pub fn parse_source(text: &str) -> Result<RecordedAtSource> {
    match RecordedAtSource::parse(text) {
        Some(source @ (RecordedAtSource::FileMetadata | RecordedAtSource::User)) => Ok(source),
        _ => bail!("origem da data inválida: {text}"),
    }
}

/// Abre o diálogo nativo (bloqueia: chame fora da thread da UI).
pub fn pick(app: &AppHandle) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("Importar um arquivo")
        .add_filter("Áudio e vídeo", &EXTENSIONS)
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
}

/// Mostra a janela na vista de importação com `path`.
pub fn open_in_window(app: &AppHandle, path: &Path) {
    crate::show_window(app);
    let _ = app.emit(OPEN_EVENT, path.to_string_lossy());
}

/// "Importar arquivo…" da bandeja: o diálogo e, escolhido o arquivo, a janela.
pub fn pick_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(path) = pick(&app) {
            open_in_window(&app, &path);
        }
    });
}

/// Converte e põe na fila numa thread; o fim sai por `import-finished` ou `import-failed`.
pub fn spawn(
    app: &AppHandle,
    path: PathBuf,
    recorded_at: i64,
    source: RecordedAtSource,
) -> Result<()> {
    let cancel = app.state::<AppState>().begin_import()?;
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = state.import_file(&path, recorded_at, source, &cancel, |done| {
            let _ = app.emit(PROGRESS_EVENT, done);
        });
        state.end_import();
        match result {
            Ok(recording) => {
                log::info!("{} importado como {}", path.display(), recording.id);
                let _ = app.emit(FINISHED_EVENT, recording.id);
                crate::sync::nudge(&app);
            }
            Err(err) if err.is::<Cancelled>() => log::info!("importação cancelada"),
            Err(err) => {
                log::error!("falha ao importar {}: {err:#}", path.display());
                let _ = app.emit(FAILED_EVENT, format!("{err:#}"));
            }
        }
        crate::refresh_ui(&app);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origem_da_data_da_importacao() {
        assert_eq!(
            parse_source("file_metadata").unwrap(),
            RecordedAtSource::FileMetadata
        );
        assert_eq!(parse_source("user").unwrap(), RecordedAtSource::User);
        assert!(parse_source("capture").is_err());
        assert!(parse_source("").is_err());
    }

    #[test]
    fn previa_do_arquivo() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/import/tests/fixtures/tom.m4a");
        let preview = preview(&path).unwrap();
        assert_eq!(preview.name, "tom.m4a");
        let json = serde_json::to_value(&preview).unwrap();
        assert_eq!(json["date_origin"], "mvhd");
        assert_eq!(json["has_audio"], true);
        assert!(json["duration_ms"].as_u64().unwrap() > 1_900);
    }
}
