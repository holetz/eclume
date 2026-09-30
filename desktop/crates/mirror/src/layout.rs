//! Onde cada arquivo mora: `<coleção>/<AAAA-MM-DD> <título> - <id8>.md`, com o `.jsonl` de nome
//! igual ao lado. Os nomes valem em Windows, macOS e Linux e não quebram links do Obsidian.

use std::path::PathBuf;

use crate::MirrorItem;

/// Subpasta das gravações que não estão em nenhuma Collection.
pub const NO_COLLECTION: &str = "sem-colecao";

/// Limites que mantêm o caminho abaixo do `MAX_PATH` de 260 do Windows, com folga para a raiz.
const MAX_TITLE: usize = 70;
const MAX_COLLECTION: usize = 50;

/// Nomes que o Windows reserva, com ou sem extensão.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Caracteres proibidos em nomes de arquivo (Windows) ou que quebram wikilinks e links do
/// Obsidian (`[ ] # ^ |`); viram espaço.
fn is_forbidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^'
        )
}

/// Um nome de arquivo ou pasta seguro a partir de um texto livre: caracteres proibidos viram
/// espaço, espaços se juntam, pontos e espaços do fim caem, nomes reservados do Windows ganham
/// um `_` na frente e o comprimento (em caracteres) é limitado a `max`. Nunca devolve vazio.
pub fn slug(text: &str, max: usize) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if is_forbidden(c) { ' ' } else { c })
        .collect();
    let mut name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > max {
        name = name.chars().take(max).collect();
    }
    let name = name.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if name.is_empty() {
        return "sem titulo".to_string();
    }
    let stem = name.split('.').next().unwrap_or(name).to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("_{name}");
    }
    name.to_string()
}

/// O nome da subpasta de uma Collection.
pub fn collection_dir(name: &str) -> String {
    slug(name, MAX_COLLECTION)
}

/// O nome-base (sem extensão) de uma gravação: data, título e os 8 primeiros caracteres do id,
/// que tornam o nome único e estável mesmo com títulos repetidos.
pub fn base_name(recorded_at: Option<&str>, title: &str, recording_id: &str) -> String {
    let date = recorded_at
        .and_then(|value| value.get(..10))
        .filter(|day| {
            day.len() == 10
                && day.char_indices().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        c == '-'
                    } else {
                        c.is_ascii_digit()
                    }
                })
        })
        .unwrap_or("0000-00-00");
    let id8: String = recording_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    format!("{date} {} - {id8}", slug(title, MAX_TITLE))
}

/// Os caminhos relativos (com `/`) que uma gravação ocupa: uma cópia por Collection.
pub fn paths(item: &MirrorItem, extension: &str) -> Vec<String> {
    let base = base_name(item.recorded_at.as_deref(), &item.title, &item.recording_id);
    let mut dirs: Vec<String> = item.collections.iter().map(|c| collection_dir(c)).collect();
    if dirs.is_empty() {
        dirs.push(NO_COLLECTION.to_string());
    }
    dirs.sort();
    dirs.dedup();
    dirs.into_iter()
        .map(|dir| {
            let mut path = PathBuf::from(dir);
            path.push(format!("{base}.{extension}"));
            path.to_string_lossy().replace('\\', "/")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caracteres_proibidos_viram_espaco_e_se_juntam() {
        assert_eq!(slug("Cliente: A/B  <urgente>?", 70), "Cliente A B urgente");
        assert_eq!(
            slug("nota [[link]] #tag ^bloco | x", 70),
            "nota link tag bloco x"
        );
        assert_eq!(
            slug("linha\nquebrada\tcom tab", 70),
            "linha quebrada com tab"
        );
    }

    #[test]
    fn acentos_e_maiusculas_ficam() {
        assert_eq!(
            slug("Reunião de Diretoria — São Paulo", 70),
            "Reunião de Diretoria — São Paulo"
        );
    }

    #[test]
    fn ponto_e_espaco_do_fim_caem() {
        assert_eq!(slug("  fim.  ", 70), "fim");
        assert_eq!(slug("...", 70), "sem titulo");
        assert_eq!(slug("", 70), "sem titulo");
        assert_eq!(slug("///", 70), "sem titulo");
    }

    #[test]
    fn nomes_reservados_do_windows_ganham_prefixo() {
        assert_eq!(slug("CON", 70), "_CON");
        assert_eq!(slug("nul", 70), "_nul");
        assert_eq!(slug("com1.txt", 70), "_com1.txt");
        assert_eq!(slug("console", 70), "console");
    }

    #[test]
    fn o_limite_conta_caracteres_e_nao_bytes() {
        let longo = "ã".repeat(200);
        assert_eq!(slug(&longo, 10).chars().count(), 10);
        // Cortar no meio de uma palavra não deixa ponto nem espaço no fim.
        assert_eq!(slug("abcd. efgh", 5), "abcd");
    }

    #[test]
    fn nome_base_leva_data_titulo_e_id8() {
        assert_eq!(
            base_name(
                Some("2026-09-18T14:00:05Z"),
                "Alinhamento",
                "01928f3a-1c00-7a00"
            ),
            "2026-09-18 Alinhamento - 01928f3a"
        );
        assert_eq!(
            base_name(None, "Sem data", "abc"),
            "0000-00-00 Sem data - abc"
        );
        assert_eq!(
            base_name(Some("lixo"), "x", "abcdefghijk"),
            "0000-00-00 x - abcdefgh"
        );
    }

    #[test]
    fn titulo_repetido_nao_colide_por_causa_do_id() {
        let a = base_name(Some("2026-09-18"), "Reunião", "aaaaaaaa-1");
        let b = base_name(Some("2026-09-18"), "Reunião", "bbbbbbbb-2");
        assert_ne!(a, b);
    }

    #[test]
    fn caminho_relativo_cabe_no_limite_do_windows() {
        let item = MirrorItem {
            recording_id: "01928f3a-1c00".into(),
            title: "x".repeat(500),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            collections: vec!["c".repeat(500)],
            agenda_type: None,
            summary: None,
            transcript: None,
        };
        let path = &paths(&item, "jsonl")[0];
        assert!(path.chars().count() < 150, "{path}");
    }

    #[test]
    fn uma_copia_por_colecao_e_sem_colecao_cai_na_pasta_propria() {
        let mut item = MirrorItem {
            recording_id: "01928f3a".into(),
            title: "Ata".into(),
            recorded_at: Some("2026-09-18".into()),
            collections: vec!["Clientes".into(), "Interno".into(), "Clientes".into()],
            agenda_type: None,
            summary: None,
            transcript: None,
        };
        assert_eq!(
            paths(&item, "md"),
            [
                "Clientes/2026-09-18 Ata - 01928f3a.md",
                "Interno/2026-09-18 Ata - 01928f3a.md"
            ]
        );
        item.collections.clear();
        assert_eq!(
            paths(&item, "md"),
            ["sem-colecao/2026-09-18 Ata - 01928f3a.md"]
        );
    }
}
