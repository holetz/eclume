//! Where each file lives: `<collection>/AAAA-MM/AAAA-MM-DD_HHMM_<id8>.md`, with a `.jsonl` of the
//! same name alongside it. Monthly subfolders keep each folder small; the title-free name has
//! fixed length and sorts by date, so paths fit every system's limits. Folder names work on
//! Windows, macOS and Linux and do not break Obsidian links.

use crate::MirrorItem;

/// Subfolder for recordings that are not in any collection.
pub const NO_COLLECTION: &str = "sem-colecao";

/// Limits that keep paths below Windows' 260-character `MAX_PATH`, with room for the root.
const MAX_COLLECTION: usize = 50;

/// Names reserved by Windows, with or without an extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Characters forbidden in file names (Windows) or that break Obsidian wikilinks and links
/// (`[ ] # ^ |`); replaced with spaces.
fn is_forbidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '[' | ']' | '#' | '^'
        )
}

/// A safe file or folder name from free text: forbidden characters become spaces, spaces are
/// collapsed, trailing dots and spaces are removed, Windows reserved names get a leading `_`,
/// and length (in characters) is capped at `max`. Never returns an empty string.
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

/// A collection's subfolder name.
pub fn collection_dir(name: &str) -> String {
    slug(name, MAX_COLLECTION)
}

/// The recording start in parts, from `AAAA-MM-DDTHH:MM…` (the app's local time, or the server's
/// `recorded_at` as a fallback): `(year-month, day, hour and minute)`.
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

/// The monthly subfolder (`AAAA-MM`); `0000-00` if the date is unreadable.
pub fn month_dir(start: Option<&str>) -> String {
    stamp_parts(start).map_or_else(|| "0000-00".to_string(), |(month, _, _)| month)
}

/// A recording's base name (without extension): `AAAA-MM-DD_HHMM_<id8>`, where `<id8>` is the
/// first 8 alphanumeric characters of the recording id. Sorts by date and time, has fixed length,
/// and the id makes it unique even for two recordings in the same minute.
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

/// The start used to name the file: the app's local time, or the server's `recorded_at`.
pub(crate) fn start_of(item: &MirrorItem) -> Option<&str> {
    item.local_start.as_deref().or(item.recorded_at.as_deref())
}

/// The relative paths (with `/`) a recording occupies: one copy per collection, each in the
/// monthly subfolder.
pub fn paths(item: &MirrorItem, extension: &str) -> Vec<String> {
    let start = start_of(item);
    let base = base_name(start, &item.recording_id);
    let month = month_dir(start);
    let mut dirs: Vec<String> = item.collections.iter().map(|c| collection_dir(c)).collect();
    if dirs.is_empty() {
        dirs.push(NO_COLLECTION.to_string());
    }
    dirs.sort();
    // Windows and macOS folder names are case-insensitive: "Clientes" and "clientes" are the same
    // folder, and listing them twice would let a removal delete the other's file.
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
    fn forbidden_characters_become_collapsed_spaces() {
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
    fn accents_and_case_are_preserved() {
        assert_eq!(
            slug("Reunião de Diretoria — São Paulo", 70),
            "Reunião de Diretoria — São Paulo"
        );
    }

    #[test]
    fn trailing_dots_and_spaces_are_removed() {
        assert_eq!(slug("  fim.  ", 70), "fim");
        assert_eq!(slug("...", 70), "sem titulo");
        assert_eq!(slug("", 70), "sem titulo");
        assert_eq!(slug("///", 70), "sem titulo");
    }

    #[test]
    fn windows_reserved_names_get_a_prefix() {
        assert_eq!(slug("CON", 70), "_CON");
        assert_eq!(slug("nul", 70), "_nul");
        assert_eq!(slug("com1.txt", 70), "_com1.txt");
        assert_eq!(slug("console", 70), "console");
    }

    #[test]
    fn limit_counts_characters_rather_than_bytes() {
        let long = "ã".repeat(200);
        assert_eq!(slug(&long, 10).chars().count(), 10);
        // Truncating in the middle of a word leaves no trailing dot or space.
        assert_eq!(slug("abcd. efgh", 5), "abcd");
    }

    #[test]
    fn base_name_is_sortable_fixed_length_and_title_free() {
        assert_eq!(
            base_name(Some("2026-09-18T14:05:33"), "01928f3a-1c00-7a00"),
            "2026-09-18_1405_01928f3a"
        );
        // The server's `recorded_at` (UTC, with a suffix) also works as a fallback.
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
        // Sorting the names sorts by date and time.
        let mut names = vec![
            base_name(Some("2026-10-01T09:00:00"), "b"),
            base_name(Some("2026-09-30T23:59:00"), "a"),
            base_name(Some("2026-09-30T08:10:00"), "c"),
        ];
        names.sort();
        assert_eq!(
            names,
            [
                "2026-09-30_0810_c",
                "2026-09-30_2359_a",
                "2026-10-01_0900_b"
            ]
        );
    }

    #[test]
    fn monthly_folder_is_year_month() {
        assert_eq!(month_dir(Some("2026-09-18T14:05:33")), "2026-09");
        assert_eq!(month_dir(Some("2026-12-31T23:59:59Z")), "2026-12");
        assert_eq!(month_dir(None), "0000-00");
        assert_eq!(month_dir(Some("2026-9-1")), "0000-00");
    }

    #[test]
    fn ids_prevent_collisions_for_recordings_in_the_same_minute() {
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
    fn path_omits_title_and_fits_every_system() {
        // Huge title and collection: the path depends only on the capped collection and fixed name.
        let path = &paths(
            &item(&"x".repeat(5000), &["c".repeat(500).as_str()]),
            "jsonl",
        )[0];
        assert!(!path.contains('x'));
        assert!(path.chars().count() <= 50 + 1 + 7 + 1 + 24 + 6, "{path}");
        assert!(path.chars().count() < 100, "{path}");
    }

    #[test]
    fn local_time_takes_precedence_with_recorded_at_as_fallback() {
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
    fn collections_differing_only_in_case_share_a_folder() {
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
    fn one_copy_per_collection_with_a_dedicated_folder_for_unassigned_recordings() {
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
