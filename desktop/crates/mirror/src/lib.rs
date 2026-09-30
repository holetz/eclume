//! Espelho local da biblioteca do eclume: o resumo atual de cada gravação como `.md` e a
//! transcrição como `.jsonl`, numa subpasta por Collection.
//!
//! A pasta serve ao mesmo tempo de vault do Obsidian (o `.md` traz propriedades em front matter;
//! `.jsonl` e o manifesto não aparecem no Obsidian) e de pasta de trabalho de agente (`AGENTS.md`
//! na raiz). O servidor é a fonte: o que o app gerou é sobrescrito. Contrato em
//! docs/standards/code/desktop-pasta-sincronizada.md.

pub mod layout;

pub use layout::{base_name, collection_dir, slug, NO_COLLECTION};

/// O que o espelho sabe de uma gravação para escrevê-la em disco. Sem rede nem Tauri: quem chama
/// converte os tipos do `eclume-sync` nestes.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorItem {
    pub recording_id: String,
    pub title: String,
    /// `recorded_at` do servidor (ISO 8601); só a data entra no nome do arquivo.
    pub recorded_at: Option<String>,
    /// Nomes das Collections da gravação; vazio cai em [`NO_COLLECTION`].
    pub collections: Vec<String>,
    pub agenda_type: Option<String>,
    pub summary: Option<Summary>,
    pub transcript: Option<Transcript>,
}

/// O resumo atual.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub version: u64,
    pub markdown: String,
}

/// A transcrição, já sem o que o espelho não usa.
#[derive(Clone, Debug, PartialEq)]
pub struct Transcript {
    pub id: String,
    pub language: Option<String>,
    pub duration_ms: Option<u64>,
    pub revision: u64,
    pub speakers: Vec<Speaker>,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Speaker {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub speaker_id: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
