//! A UI estática do desktop (`desktop/ui`) segue o Design System: a cópia fiel do `styles.css`
//! (igual à do web, quando ela existe), fontes locais, nenhum recurso externo e nenhum atributo
//! `style`, que a CSP da janela bloqueia.

use std::fs;
use std::path::{Path, PathBuf};

fn ui_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui")
}

/// Os arquivos de texto da UI (HTML, CSS e JS), recursivamente.
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
fn eclume_css_e_a_mesma_copia_do_web() {
    let desktop = read(&ui_dir().join("eclume.css"));
    assert!(!desktop.contains("fonts.googleapis.com"));
    assert!(
        desktop.contains("--color-rec"),
        "não parece o styles.css do DS"
    );
    let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/styles/eclume.css");
    if web.exists() {
        assert!(
            desktop == read(&web),
            "desktop/ui/eclume.css difere de web/src/styles/eclume.css: rode \
             uv run python design-system/sincronizar.py"
        );
    }
}

#[test]
fn nenhum_recurso_externo() {
    for path in text_files(&ui_dir()) {
        let text = read(&path);
        for scheme in ["http://", "https://"] {
            assert!(
                !text.contains(scheme),
                "{} usa {scheme}: a UI só carrega do próprio app",
                path.display()
            );
        }
        assert!(
            !text
                .lines()
                .any(|line| line.trim_start().starts_with("@import")),
            "{} usa @import",
            path.display()
        );
    }
}

#[test]
fn fontes_declaradas_existem_e_tem_licenca() {
    let fonts = read(&ui_dir().join("fonts.css"));
    let mut declared = Vec::new();
    for part in fonts.split("url(").skip(1) {
        let target = part.split(')').next().unwrap().trim_matches(['\'', '"']);
        let path = ui_dir().join(target);
        assert!(
            path.is_file(),
            "fonts.css aponta para {target}, que não existe"
        );
        declared.push(path.file_name().unwrap().to_owned());
    }
    assert_eq!(declared.len(), 7, "Archivo 400–800 e IBM Plex Mono 400/500");
    for entry in fs::read_dir(ui_dir().join("fonts")).unwrap() {
        let name = entry.unwrap().file_name();
        if Path::new(&name)
            .extension()
            .is_some_and(|ext| ext == "woff2")
        {
            assert!(declared.contains(&name), "{name:?} sem @font-face");
        }
    }
    let license = read(&ui_dir().join("fonts/OFL.txt"));
    assert!(license.contains("SIL Open Font License"));
    assert!(license.contains("Archivo") && license.contains("IBM Plex"));
}

#[test]
fn sem_atributo_style() {
    for path in text_files(&ui_dir()) {
        let text = read(&path);
        let offending = match path.extension().and_then(|ext| ext.to_str()) {
            Some("html") => text.contains(" style="),
            Some("js") => text.contains("setAttribute(\"style\"") || text.contains("style: "),
            _ => false,
        };
        assert!(
            !offending,
            "{} escreve atributo style; use classes ou style.setProperty",
            path.display()
        );
    }
}

#[test]
fn index_carrega_so_arquivos_que_existem() {
    let index = read(&ui_dir().join("index.html"));
    for attr in ["href=\"", "src=\""] {
        for part in index.split(attr).skip(1) {
            let target = part.split('"').next().unwrap();
            if target.starts_with('#') {
                continue;
            }
            assert!(
                ui_dir().join(target).is_file(),
                "index.html referencia {target}, que não existe"
            );
        }
    }
}

/// Os slugs que a UI pede ao `open_help` (`{ article: "<slug>" }`; `null` é a central).
fn slugs_de_ajuda(texto: &str) -> Vec<String> {
    let mut slugs = Vec::new();
    for (inicio, _) in texto.match_indices("\"open_help\"") {
        let resto = &texto[inicio..];
        let args = &resto[..resto.find('}').unwrap_or(resto.len())];
        if let Some(pos) = args.find("article:") {
            let valor = args[pos + "article:".len()..].trim_start();
            if let Some(sem_aspas) = valor.strip_prefix('"') {
                slugs.push(sem_aspas[..sem_aspas.find('"').unwrap()].to_string());
            }
        }
    }
    slugs
}

#[test]
fn artigos_de_ajuda_pedidos_pela_ui_existem_no_web() {
    let artigos =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/features/help/articles");
    if !artigos.exists() {
        return; // build fora do monorepo
    }
    let mut pedidos = Vec::new();
    for arquivo in text_files(&ui_dir().join("js")) {
        pedidos.extend(slugs_de_ajuda(&read(&arquivo)));
    }
    assert!(
        pedidos.len() >= 3,
        "esperava os artigos do menu de ajuda: {pedidos:?}"
    );
    for slug in pedidos {
        assert!(
            artigos.join(format!("{slug}.md")).exists(),
            "a UI do desktop abre o artigo {slug}, que não existe em web/src/features/help/articles"
        );
    }
}
