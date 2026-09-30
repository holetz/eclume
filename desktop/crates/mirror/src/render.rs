//! O conteúdo dos arquivos: o `.md` do resumo com front matter (propriedades do Obsidian) e o
//! `.jsonl` da transcrição, uma linha por segmento.

use serde_json::json;

use crate::{layout, MirrorItem, Transcript};

/// Um texto como string YAML entre aspas duplas: `\`, `"` e quebras de linha escapados.
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

/// O `.md` do resumo: front matter e o Markdown do servidor, ou `None` sem resumo.
///
/// `transcript_path` é o caminho relativo do `.jsonl` a partir da pasta do `.md` (mesmo nome-base,
/// então basta o nome do arquivo); só entra nas propriedades quando a transcrição é espelhada.
pub fn markdown(item: &MirrorItem) -> Option<String> {
    let summary = item.summary.as_ref()?;
    let mut out = String::from("---\n");
    out.push_str("source: eclume\n");
    out.push_str(&format!(
        "recording_id: {}\n",
        yaml_string(&item.recording_id)
    ));
    out.push_str(&format!("title: {}\n", yaml_string(&item.title)));
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
    if item.transcript.is_some() {
        let file = layout::base_name(item.recorded_at.as_deref(), &item.title, &item.recording_id);
        out.push_str(&format!(
            "transcript: {}\n",
            yaml_string(&format!("{file}.jsonl"))
        ));
    }
    out.push_str("---\n\n");
    out.push_str(summary.markdown.trim_end());
    out.push('\n');
    Some(out)
}

/// A primeira linha (`meta`) e uma linha por segmento (`segment`) da transcrição.
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
    use crate::{Segment, Speaker, Summary};

    fn item() -> MirrorItem {
        MirrorItem {
            recording_id: "01928f3a-1c00".into(),
            title: "Alinhamento \"Q4\"".into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            collections: vec!["Interno".into(), "Clientes".into()],
            agenda_type: Some("Reunião de equipe".into()),
            summary: Some(Summary {
                version: 3,
                markdown: "# Ata\n\n- decisão\n\n".into(),
            }),
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
    fn markdown_tem_front_matter_de_propriedades_e_o_resumo_do_servidor() {
        let md = markdown(&item()).unwrap();
        let expected = "---\n\
source: eclume\n\
recording_id: \"01928f3a-1c00\"\n\
title: \"Alinhamento \\\"Q4\\\"\"\n\
recorded_at: \"2026-09-18T14:00:05Z\"\n\
collections:\n  - \"Clientes\"\n  - \"Interno\"\n\
agenda_type: \"Reunião de equipe\"\n\
summary_version: 3\n\
transcript: \"2026-09-18 Alinhamento Q4 - 01928f3a.jsonl\"\n\
---\n\n# Ata\n\n- decisão\n";
        assert_eq!(md, expected);
    }

    #[test]
    fn sem_resumo_nao_ha_markdown_e_sem_transcricao_nao_ha_link() {
        let mut sem_resumo = item();
        sem_resumo.summary = None;
        assert!(markdown(&sem_resumo).is_none());
        let mut sem_transcricao = item();
        sem_transcricao.transcript = None;
        sem_transcricao.collections.clear();
        sem_transcricao.agenda_type = None;
        let md = markdown(&sem_transcricao).unwrap();
        assert!(md.contains("collections: []\n"));
        assert!(!md.contains("transcript:"));
        assert!(!md.contains("agenda_type:"));
    }

    #[test]
    fn jsonl_tem_meta_e_uma_linha_por_segmento() {
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
        // A quebra de linha do texto fica escapada: uma linha por segmento.
        assert_eq!(lines[1]["text"], "Bom dia, \"time\".\nVamos começar.");
        assert_eq!(lines[2]["speaker"], serde_json::Value::Null);
        assert!(text.ends_with('\n'));
        assert!(text.contains("Vamos começar"));
    }

    #[test]
    fn sem_transcricao_nao_ha_jsonl() {
        let mut sem = item();
        sem.transcript = None;
        assert!(jsonl(&sem).is_none());
    }
}
