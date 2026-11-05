//! The static desktop UI (`desktop/ui`) follows the Design System: an exact copy of `styles.css`
//! (matching the web copy, when present), local fonts, no external resources and no `style`
//! attributes, which the window CSP blocks.

use std::fs;
use std::path::{Path, PathBuf};

fn ui_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui")
}

/// UI text files (HTML, CSS and JS), recursively.
fn text_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(text_files(&path));
        } else if path
            .extension()
            .is_some_and(|ext| ext == "html" || ext == "css" || ext == "js")
        {
            files.push(path);
        }
    }
    files
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

#[test]
fn no_portuguese_literals_outside_the_pt_br_catalog() {
    let root = ui_dir();
    for path in text_files(&root) {
        let relative = path.strip_prefix(&root).unwrap();
        if relative == Path::new("js/locales/pt-BR.js")
            || relative == Path::new("js/vocabulario.js")
        {
            continue;
        }
        for (index, line) in read(&path).lines().enumerate() {
            assert!(
                !line.contains(|character: char| "ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ".contains(character)),
                "{}:{}: move the text to js/locales/pt-BR.js and its en twin",
                path.display(),
                index + 1
            );
        }
    }
}

#[test]
fn eclume_css_matches_web_copy() {
    let desktop = read(&ui_dir().join("eclume.css"));
    assert!(!desktop.contains("fonts.googleapis.com"));
    assert!(
        desktop.contains("--color-rec"),
        "does not look like the DS styles.css"
    );
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/styles/eclume.css");
    if web.exists() {
        assert!(
            desktop == read(&web),
            "desktop/ui/eclume.css differs from web/src/styles/eclume.css: run \
             uv run python design-system/sync.py"
        );
    }
}

#[test]
fn vocabulary_matches_web_copy() {
    let desktop = read(&ui_dir().join("js/vocabulario.js"));
    assert!(
        desktop.contains("export const MOTIVOS"),
        "does not look like the state vocabulary"
    );
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/lib/vocabulario.js");
    if web.exists() {
        assert!(
            desktop == read(&web),
            "desktop/ui/js/vocabulario.js differs from web/src/lib/vocabulario.js: copy the web version"
        );
    }
}

#[test]
fn no_external_resources() {
    for path in text_files(&ui_dir()) {
        let text = read(&path);
        for scheme in ["http://", "https://"] {
            assert!(
                !text.contains(scheme),
                "{} uses {scheme}: the UI only loads from the app itself",
                path.display()
            );
        }
        assert!(
            !text
                .lines()
                .any(|line| line.trim_start().starts_with("@import")),
            "{} uses @import",
            path.display()
        );
    }
}

#[test]
fn declared_fonts_exist_and_have_license() {
    let fonts = read(&ui_dir().join("fonts.css"));
    let mut declared = Vec::new();
    for part in fonts.split("url(").skip(1) {
        let target = part.split(')').next().unwrap().trim_matches(['\'', '"']);
        let path = ui_dir().join(target);
        assert!(
            path.is_file(),
            "fonts.css points to {target}, which does not exist"
        );
        declared.push(path.file_name().unwrap().to_owned());
    }
    assert_eq!(
        declared.len(),
        7,
        "Archivo 400–800 and IBM Plex Mono 400/500"
    );
    for entry in fs::read_dir(ui_dir().join("fonts")).unwrap() {
        let name = entry.unwrap().file_name();
        if Path::new(&name)
            .extension()
            .is_some_and(|ext| ext == "woff2")
        {
            assert!(declared.contains(&name), "{name:?} without @font-face");
        }
    }
    let license = read(&ui_dir().join("fonts/OFL.txt"));
    assert!(license.contains("SIL Open Font License"));
    assert!(license.contains("Archivo") && license.contains("IBM Plex"));
}

#[test]
fn no_style_attribute() {
    for path in text_files(&ui_dir()) {
        let text = read(&path);
        let offending = match path.extension().and_then(|ext| ext.to_str()) {
            Some("html") => text.contains(" style="),
            Some("js") => text.contains("setAttribute(\"style\"") || text.contains("style: "),
            _ => false,
        };
        assert!(
            !offending,
            "{} writes a style attribute; use classes or style.setProperty",
            path.display()
        );
    }
}

#[test]
fn index_only_loads_existing_files() {
    let index = read(&ui_dir().join("index.html"));
    for attr in ["href=\"", "src=\""] {
        for part in index.split(attr).skip(1) {
            let target = part.split('"').next().unwrap();
            if target.starts_with('#') {
                continue;
            }
            assert!(
                ui_dir().join(target).is_file(),
                "index.html references {target}, which does not exist"
            );
        }
    }
}

/// Slugs the UI requests through `open_help` (`{ article: "<slug>" }`; `null` is the help center).
fn help_slugs(text: &str) -> Vec<String> {
    let mut slugs = Vec::new();
    for (start, _) in text.match_indices("\"open_help\"") {
        let rest = &text[start..];
        let args = &rest[..rest.find('}').unwrap_or(rest.len())];
        if let Some(pos) = args.find("article:") {
            let value = args[pos + "article:".len()..].trim_start();
            if let Some(unquoted) = value.strip_prefix('"') {
                slugs.push(unquoted[..unquoted.find('"').unwrap()].to_string());
            }
        }
    }
    slugs
}

#[test]
fn help_articles_requested_by_ui_exist_on_web() {
    let articles =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/features/help/articles/en");
    if !articles.exists() {
        return; // build outside the monorepo
    }
    let mut requested = Vec::new();
    for file in text_files(&ui_dir().join("js")) {
        requested.extend(help_slugs(&read(&file)));
    }
    assert!(
        requested.len() >= 3,
        "expected help menu articles: {requested:?}"
    );
    for slug in requested {
        assert!(
            articles.join(format!("{slug}.md")).exists(),
            "the desktop UI opens article {slug}, which does not exist in web/src/features/help/articles/en"
        );
    }
}
