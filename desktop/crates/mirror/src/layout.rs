//! Onde cada arquivo mora: `<coleção>/AAAA-MM/AAAA-MM-DD_HHMM_<id8>.md`, com o `.jsonl` de nome
//! igual ao lado. O mês em subpasta mantém cada pasta pequena; o nome, sem título, tem tamanho
//! fixo e ordena por data, então nenhum caminho estoura o limite de nenhum sistema. Os nomes de
//! pasta valem em Windows, macOS e Linux e não quebram links do Obsidian.

use crate::MirrorItem;

/// Subpasta das gravações que não estão em nenhuma Collection.
pub const NO_COLLECTION: &str = "sem-colecao";

/// Limites que mantêm o caminho abaixo do `MAX_PATH` de 260 do Windows, com folga para a raiz.
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

/// O início da gravação em partes, a partir de `AAAA-MM-DDTHH:MM…` (o que o app informa em hora
/// local, ou o `recorded_at` do servidor como reserva): `(ano-mês, dia, hora e minuto)`.
fn stamp_parts(start: Option<&str>) -> Option<(String, String, String)> {
    let text = start?;
    let bytes = text.as_bytes();
    let digits = |from: usize, to: usize| {
        bytes
            .get(from..to)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let valid = bytes.len() >= 16
        && digits(0, 4)
        && bytes[4] == b'-'
        && digits(5, 7)
        && bytes[7] == b'-'
        && digits(8, 10)
        && matches!(bytes[10], b'T' | b' ')
        && digits(11, 13)
        && bytes[13] == b':'
        && digits(14, 16);
    valid.then(|| {
        (
            text[..7].to_string(),
            text[..10].to_string(),
            format!("{}{}", &text[11..13], &text[14..16]),
        )
    })
}

/// A subpasta do mês (`AAAA-MM`); sem data legível, `0000-00`.
pub fn month_dir(start: Option<&str>) -> String {
    stamp_parts(start).map_or_else(|| "0000-00".to_string(), |(month, _, _)| month)
}

/// O nome-base (sem extensão) de uma gravação: `AAAA-MM-DD_HHMM_<id8>`, em que `<id8>` são os
/// 8 primeiros caracteres alfanuméricos do id da gravação. Ordena por data e hora, tem tamanho
/// fixo e o id o torna único mesmo para duas gravações no mesmo minuto.
pub fn base_name(start: Option<&str>, recording_id: &str) -> String {
    let (day, time) = stamp_parts(start).map_or_else(
        || ("0000-00-00".to_string(), "0000".to_string()),
        |(_, day, time)| (day, time),
    );
    let id8: String = recording_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    format!("{day}_{time}_{id8}")
}

/// O início que dá nome ao arquivo: a hora local do app, ou o `recorded_at` do servidor.
pub(crate) fn start_of(item: &MirrorItem) -> Option<&str> {
    item.local_start.as_deref().or(item.recorded_at.as_deref())
}

/// Os caminhos relativos (com `/`) que uma gravação ocupa: uma cópia por Collection, cada uma na
/// subpasta do mês.
pub fn paths(item: &MirrorItem, extension: &str) -> Vec<String> {
    let start = start_of(item);
    let base = base_name(start, &item.recording_id);
    let month = month_dir(start);
    let mut dirs: Vec<String> = item.collections.iter().map(|c| collection_dir(c)).collect();
    if dirs.is_empty() {
        dirs.push(NO_COLLECTION.to_string());
    }
    dirs.sort();
    // Windows e macOS não distinguem maiúsculas em nomes de pasta: "Clientes" e "clientes" são a
    // mesma pasta, e listá-las duas vezes faria uma remoção apagar o arquivo da outra.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.to_lowercase()));
    dirs.into_iter()
        .map(|dir| format!("{dir}/{month}/{base}.{extension}"))
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
    fn nome_base_e_ordenavel_de_tamanho_fixo_e_sem_titulo() {
        assert_eq!(
            base_name(Some("2026-09-18T14:05:33"), "01928f3a-1c00-7a00"),
            "2026-09-18_1405_01928f3a"
        );
        // O `recorded_at` do servidor (UTC, com sufixo) também serve de reserva.
        assert_eq!(
            base_name(Some("2026-09-18T14:00:05Z"), "abc"),
            "2026-09-18_1400_abc"
        );
        assert_eq!(base_name(None, "abc"), "0000-00-00_0000_abc");
        assert_eq!(
            base_name(Some("lixo"), "abcdefghijk"),
            "0000-00-00_0000_abcdefgh"
        );
        assert_eq!(
            base_name(Some("2026-09-18T14:05:33"), "01928f3a-1c00").len(),
            24
        );
        // Ordenar os nomes é ordenar por data e hora.
        let mut nomes = vec![
            base_name(Some("2026-10-01T09:00:00"), "b"),
            base_name(Some("2026-09-30T23:59:00"), "a"),
            base_name(Some("2026-09-30T08:10:00"), "c"),
        ];
        nomes.sort();
        assert_eq!(
            nomes,
            [
                "2026-09-30_0810_c",
                "2026-09-30_2359_a",
                "2026-10-01_0900_b"
            ]
        );
    }

    #[test]
    fn a_pasta_do_mes_e_aaaa_mm() {
        assert_eq!(month_dir(Some("2026-09-18T14:05:33")), "2026-09");
        assert_eq!(month_dir(Some("2026-12-31T23:59:59Z")), "2026-12");
        assert_eq!(month_dir(None), "0000-00");
        assert_eq!(month_dir(Some("2026-9-1")), "0000-00");
    }

    #[test]
    fn duas_gravacoes_no_mesmo_minuto_nao_colidem_por_causa_do_id() {
        let a = base_name(Some("2026-09-18T14:05:00"), "aaaaaaaa-1");
        let b = base_name(Some("2026-09-18T14:05:00"), "bbbbbbbb-2");
        assert_ne!(a, b);
    }

    fn item(title: &str, collections: &[&str]) -> MirrorItem {
        MirrorItem {
            recording_id: "01928f3a-1c00".into(),
            title: title.into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            local_start: Some("2026-09-18T11:00:05".into()),
            collections: collections.iter().map(|c| c.to_string()).collect(),
            agenda_type: None,
            summary: None,
            transcript: None,
            markers: vec![],
        }
    }

    #[test]
    fn o_titulo_nunca_entra_no_caminho_e_o_caminho_cabe_em_qualquer_sistema() {
        // Título e Collection gigantes: o caminho depende só da Collection (limitada) e do nome fixo.
        let path = &paths(
            &item(&"x".repeat(5000), &["c".repeat(500).as_str()]),
            "jsonl",
        )[0];
        assert!(!path.contains('x'));
        assert!(path.chars().count() <= 50 + 1 + 7 + 1 + 24 + 6, "{path}");
        assert!(path.chars().count() < 100, "{path}");
    }

    #[test]
    fn a_hora_local_manda_e_o_recorded_at_e_reserva() {
        let mut it = item("Ata", &["Clientes"]);
        assert_eq!(
            paths(&it, "md"),
            ["Clientes/2026-09/2026-09-18_1100_01928f3a.md"]
        );
        it.local_start = None;
        assert_eq!(
            paths(&it, "md"),
            ["Clientes/2026-09/2026-09-18_1400_01928f3a.md"]
        );
    }

    #[test]
    fn colecoes_que_so_diferem_em_maiusculas_sao_uma_pasta() {
        let it = item("Ata", &["clientes", "Clientes", "Interno"]);
        assert_eq!(
            paths(&it, "md"),
            [
                "Clientes/2026-09/2026-09-18_1100_01928f3a.md",
                "Interno/2026-09/2026-09-18_1100_01928f3a.md"
            ]
        );
    }

    #[test]
    fn uma_copia_por_colecao_e_sem_colecao_cai_na_pasta_propria() {
        let mut it = item("Ata", &["Clientes", "Interno", "Clientes"]);
        assert_eq!(
            paths(&it, "md"),
            [
                "Clientes/2026-09/2026-09-18_1100_01928f3a.md",
                "Interno/2026-09/2026-09-18_1100_01928f3a.md"
            ]
        );
        it.collections.clear();
        assert_eq!(
            paths(&it, "md"),
            ["sem-colecao/2026-09/2026-09-18_1100_01928f3a.md"]
        );
    }
}
