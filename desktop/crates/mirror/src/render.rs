//! File contents: the summary `.md` with front matter (Obsidian properties) and the transcript
//! `.jsonl`, one line per segment.

use serde_json::json;

use crate::{layout, MirrorItem, Transcript};

/// Text as a double-quoted YAML string: `\`, `"` and line breaks are escaped.
fn yaml_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `HH:MM:SS` from milliseconds.
fn hms(ms: u64) -> String {
    let seconds = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}

/// The summary is from an earlier revision of the mirrored transcript. Without both revisions,
/// comparison is impossible and no warning appears (the same rule as the web app).
fn is_stale(item: &MirrorItem) -> bool {
    match (
        item.summary.as_ref().and_then(|s| s.transcript_revision),
        item.transcript.as_ref(),
    ) {
        (Some(summary), Some(transcript)) => summary < transcript.revision,
        _ => false,
    }
}

/// The summary `.md`: front matter and server Markdown, or `None` without a summary.
///
/// The `transcript` property is the `.jsonl` name in the same folder (same base name); included
/// only when the transcript is mirrored.
pub fn markdown(item: &MirrorItem) -> Option<String> {
    let summary = item.summary.as_ref()?;
    let mut out = String::from("---\n");
    out.push_str("source: eclume\n");
    out.push_str(&format!(
        "recording_id: {}\n",
        yaml_string(&item.recording_id)
    ));
    out.push_str(&format!("title: {}\n", yaml_string(&item.title)));
    // The file name omits the title: `aliases` lets Obsidian find the note by title.
    out.push_str(&format!("aliases:\n  - {}\n", yaml_string(&item.title)));
    if let Some(recorded_at) = &item.recorded_at {
        out.push_str(&format!("recorded_at: {}\n", yaml_string(recorded_at)));
    }
    if item.collections.is_empty() {
        out.push_str("collections: []\n");
    } else {
        out.push_str("collections:\n");
        let mut names: Vec<&String> = item.collections.iter().collect();
        names.sort();
        names.dedup();
        for name in names {
            out.push_str(&format!("  - {}\n", yaml_string(name)));
        }
    }
    if let Some(agenda) = item.agenda_type.as_deref().filter(|name| !name.is_empty()) {
        out.push_str(&format!("agenda_type: {}\n", yaml_string(agenda)));
    }
    out.push_str(&format!("summary_version: {}\n", summary.version));
    let stale = is_stale(item);
    if stale {
        out.push_str("summary_stale: true\n");
    }
    if item.transcript.is_some() {
        let file = layout::base_name(layout::start_of(item), &item.recording_id);
        out.push_str(&format!(
            "transcript: {}\n",
            yaml_string(&format!("{file}.jsonl"))
        ));
    }
    out.push_str("---\n\n");
    if stale {
        out.push_str(
            "> [!warning] Resumo de uma versão anterior da transcrição\n\
> A transcrição foi alterada depois deste resumo. Use Regenerar para refletir as mudanças.\n\n",
        );
    }
    out.push_str(summary.markdown.trim_end());
    out.push('\n');
    let notes: Vec<String> = item
        .markers
        .iter()
        .filter_map(|marker| {
            // One line per note: a line break must not start another item or section.
            let note = marker.note.split_whitespace().collect::<Vec<_>>().join(" ");
            (!note.is_empty()).then(|| format!("- [{}] {note}\n", hms(marker.at_ms)))
        })
        .collect();
    if !notes.is_empty() {
        out.push_str("\n## Notas dos marcadores\n\n");
        notes.iter().for_each(|line| out.push_str(line));
    }
    Some(out)
}

/// The transcript's first line (`meta`) and one line per segment (`segment`).
pub fn jsonl(item: &MirrorItem) -> Option<String> {
    let transcript: &Transcript = item.transcript.as_ref()?;
    let label = |speaker_id: &Option<String>| -> Option<&str> {
        let id = speaker_id.as_deref()?;
        transcript
            .speakers
            .iter()
            .find(|speaker| speaker.id == id)
            .map(|speaker| speaker.label.as_str())
    };
    let mut out = String::new();
    let meta = json!({
        "type": "meta",
        "id": transcript.id,
        "recording_id": item.recording_id,
        "title": item.title,
        "language": transcript.language,
        "recorded_at": item.recorded_at,
        "duration_ms": transcript.duration_ms,
        "revision": transcript.revision,
        "speakers": transcript
            .speakers
            .iter()
            .map(|speaker| json!({"id": speaker.id, "label": speaker.label}))
            .collect::<Vec<_>>(),
    });
    out.push_str(&meta.to_string());
    out.push('\n');
    for segment in &transcript.segments {
        let line = json!({
            "type": "segment",
            "speaker": label(&segment.speaker_id),
            "speaker_id": segment.speaker_id,
            "start_ms": segment.start_ms,
            "end_ms": segment.end_ms,
            "text": segment.text,
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MirrorMarker, Segment, Speaker, Summary};

    fn item() -> MirrorItem {
        MirrorItem {
            recording_id: "01928f3a-1c00".into(),
            title: "Alinhamento \"Q4\"".into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            local_start: Some("2026-09-18T11:00:05".into()),
            collections: vec!["Interno".into(), "Clientes".into()],
            agenda_type: Some("Reunião de equipe".into()),
            summary: Some(Summary {
                version: 3,
                markdown: "# Ata\n\n- decisão\n\n".into(),
                transcript_revision: Some(2),
            }),
            markers: vec![],
            transcript: Some(Transcript {
                id: "t1".into(),
                language: Some("pt".into()),
                duration_ms: Some(61_000),
                revision: 2,
                speakers: vec![Speaker {
                    id: "S1".into(),
                    label: "Mariana".into(),
                }],
                segments: vec![
                    Segment {
                        speaker_id: Some("S1".into()),
                        start_ms: 0,
                        end_ms: 4200,
                        text: "Bom dia, \"time\".\nVamos começar.".into(),
                    },
                    Segment {
                        speaker_id: None,
                        start_ms: 4200,
                        end_ms: 5000,
                        text: "ok".into(),
                    },
                ],
            }),
        }
    }

    #[test]
    fn markdown_has_property_front_matter_and_server_summary() {
        let md = markdown(&item()).unwrap();
        let expected = "---\n\
source: eclume\n\
recording_id: \"01928f3a-1c00\"\n\
title: \"Alinhamento \\\"Q4\\\"\"\n\
aliases:\n  - \"Alinhamento \\\"Q4\\\"\"\n\
recorded_at: \"2026-09-18T14:00:05Z\"\n\
collections:\n  - \"Clientes\"\n  - \"Interno\"\n\
agenda_type: \"Reunião de equipe\"\n\
summary_version: 3\n\
transcript: \"2026-09-18_1100_01928f3a.jsonl\"\n\
---\n\n# Ata\n\n- decisão\n";
        assert_eq!(md, expected);
    }

    #[test]
    fn summary_from_earlier_revision_gets_property_and_warning() {
        let mut old = item();
        old.summary.as_mut().unwrap().transcript_revision = Some(1);
        let md = markdown(&old).unwrap();
        assert!(md.contains("summary_version: 3\nsummary_stale: true\ntranscript:"));
        assert!(md.contains(
            "---\n\n> [!warning] Resumo de uma versão anterior da transcrição\n\
> A transcrição foi alterada depois deste resumo. Use Regenerar para refletir as mudanças.\n\n# Ata\n"
        ));
    }

    #[test]
    fn equal_newer_or_missing_revision_has_no_warning() {
        for revision in [Some(2), Some(5), None] {
            let mut current = item();
            current.summary.as_mut().unwrap().transcript_revision = revision;
            let md = markdown(&current).unwrap();
            assert!(!md.contains("summary_stale"), "{revision:?}");
            assert!(!md.contains("[!warning]"), "{revision:?}");
        }
        let mut without_transcript = item();
        without_transcript
            .summary
            .as_mut()
            .unwrap()
            .transcript_revision = Some(0);
        without_transcript.transcript = None;
        assert!(!markdown(&without_transcript)
            .unwrap()
            .contains("summary_stale"));
    }

    #[test]
    fn marker_notes_become_a_section_at_end_of_markdown() {
        let mut noted = item();
        noted.markers = vec![
            MirrorMarker {
                at_ms: 65_000,
                note: "decisão: aprovar\n## forjada".into(),
            },
            MirrorMarker {
                at_ms: 3_723_000,
                note: "   ".into(),
            },
        ];
        let md = markdown(&noted).unwrap();
        assert!(md.ends_with(
            "- decisão\n\n## Notas dos marcadores\n\n- [00:01:05] decisão: aprovar ## forjada\n"
        ));
        assert!(!md.contains("01:02:03"));
        // Without any notes, the section does not exist.
        noted.markers.clear();
        assert!(!markdown(&noted).unwrap().contains("Notas dos marcadores"));
    }

    #[test]
    fn no_markdown_without_summary_and_no_link_without_transcript() {
        let mut without_summary = item();
        without_summary.summary = None;
        assert!(markdown(&without_summary).is_none());
        let mut without_transcript = item();
        without_transcript.transcript = None;
        without_transcript.collections.clear();
        without_transcript.agenda_type = None;
        let md = markdown(&without_transcript).unwrap();
        assert!(md.contains("collections: []\n"));
        assert!(!md.contains("transcript:"));
        assert!(!md.contains("agenda_type:"));
    }

    #[test]
    fn jsonl_has_meta_and_one_line_per_segment() {
        let text = jsonl(&item()).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["type"], "meta");
        assert_eq!(lines[0]["revision"], 2);
        assert_eq!(lines[0]["speakers"][0]["label"], "Mariana");
        assert_eq!(lines[1]["type"], "segment");
        assert_eq!(lines[1]["speaker"], "Mariana");
        assert_eq!(lines[1]["end_ms"], 4200);
        // The text's line break is escaped: one line per segment.
        assert_eq!(lines[1]["text"], "Bom dia, \"time\".\nVamos começar.");
        assert_eq!(lines[2]["speaker"], serde_json::Value::Null);
        assert!(text.ends_with('\n'));
        assert!(text.contains("Vamos começar"));
    }

    #[test]
    fn no_jsonl_without_transcript() {
        let mut without = item();
        without.transcript = None;
        assert!(jsonl(&without).is_none());
    }
}
