//! File import: native dialog (window, tray and `Ctrl+O`), drag and drop onto the window and
//! background conversion, with progress events. The window has no file API: it only
//! receives paths from Rust.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use eclume_import::{Cancelled, Probe};
use eclume_recorder::RecordedAtSource;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// A file for the import view to open (dropped or chosen from the tray).
pub const OPEN_EVENT: &str = "import-dropped";
const PROGRESS_EVENT: &str = "import-progress";
const FINISHED_EVENT: &str = "import-finished";
const FAILED_EVENT: &str = "import-failed";

/// Dialog filter: formats the app converts and those it copies to the server.
pub const EXTENSIONS: [&str; 20] = [
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "weba", "wma", "amr", "ac3", "mp4",
    "m4v", "mov", "webm", "mkv", "avi", "wmv", "3gp",
];

/// What the view shows before confirmation.
#[derive(Clone, Debug, Serialize)]
pub struct ImportPreview {
    pub path: PathBuf,
    /// The file name, including extension.
    pub name: String,
    #[serde(flatten)]
    pub probe: Probe,
}

/// Reads the chosen file.
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

/// The date comes from the file and is confirmed, or typed; the capture clock does not apply here.
pub fn parse_source(text: &str) -> Result<RecordedAtSource> {
    match RecordedAtSource::parse(text) {
        Some(source @ (RecordedAtSource::FileMetadata | RecordedAtSource::User)) => Ok(source),
        _ => bail!("origem da data inválida: {text}"),
    }
}

/// Opens the native dialog (blocks: call off the UI thread).
pub fn pick(app: &AppHandle) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("Importar um arquivo")
        .add_filter("Áudio e vídeo", &EXTENSIONS)
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
}

/// Shows the window in the import view with `path`.
pub fn open_in_window(app: &AppHandle, path: &Path) {
    crate::show_window(app);
    let _ = app.emit(OPEN_EVENT, path.to_string_lossy());
}

/// "Import file…" from the tray: the dialog, then the window once a file is chosen.
pub fn pick_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(path) = pick(&app) {
            open_in_window(&app, &path);
        }
    });
}

/// Converts and queues on a thread; completion emits `import-finished` or `import-failed`.
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
        // Releases the import on completion, even if conversion panics.
        let importing = state.import_guard();
        let result = state.import_file(&path, recorded_at, source, &cancel, |done| {
            let _ = app.emit(PROGRESS_EVENT, done);
        });
        drop(importing);
        match result {
            Ok(recording) => {
                log::info!("{} imported as {}", path.display(), recording.id);
                let _ = app.emit(FINISHED_EVENT, recording.id);
                crate::sync::nudge(&app);
            }
            Err(err) if err.is::<Cancelled>() => log::info!("import cancelled"),
            Err(err) => {
                log::error!("failed to import {}: {err:#}", path.display());
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
    fn import_date_source() {
        assert_eq!(
            parse_source("file_metadata").unwrap(),
            RecordedAtSource::FileMetadata
        );
        assert_eq!(parse_source("user").unwrap(), RecordedAtSource::User);
        assert!(parse_source("capture").is_err());
        assert!(parse_source("").is_err());
    }

    #[test]
    fn file_preview() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/import/tests/fixtures/tone.m4a");
        let preview = preview(&path).unwrap();
        assert_eq!(preview.name, "tone.m4a");
        let json = serde_json::to_value(&preview).unwrap();
        assert_eq!(json["date_origin"], "mvhd");
        assert_eq!(json["has_audio"], true);
        assert!(json["duration_ms"].as_u64().unwrap() > 1_900);
    }
}
