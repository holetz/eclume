//! Espelho local da biblioteca do eclume: o resumo atual de cada gravação como `.md` e a
//! transcrição como `.jsonl`, numa subpasta por Collection.
//!
//! A pasta serve ao mesmo tempo de vault do Obsidian (o `.md` traz propriedades em front matter;
//! `.jsonl` e o manifesto não aparecem no Obsidian) e de pasta de trabalho de agente (`AGENTS.md`
//! na raiz). O servidor é a fonte: o que o app gerou é sobrescrito. Contrato em
//! docs/standards/code/desktop-pasta-sincronizada.md.

pub mod agents;
pub mod layout;
pub mod manifest;
pub mod reconcile;
pub mod render;

pub use layout::{base_name, collection_dir, month_dir, slug, NO_COLLECTION};
pub use manifest::Manifest;
pub use reconcile::{Applied, Mirror};

/// O que o espelho sabe de uma gravação para escrevê-la em disco. Sem rede nem Tauri: quem chama
/// converte os tipos do `eclume-sync` nestes.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorItem {
    pub recording_id: String,
    pub title: String,
    /// `recorded_at` do servidor (ISO 8601, UTC): vai para o front matter e, sem `local_start`,
    /// dá nome e mês ao arquivo.
    pub recorded_at: Option<String>,
    /// O início da gravação em hora local (`AAAA-MM-DDTHH:MM:SS`), que o app calcula: dá o mês da
    /// subpasta e o nome do arquivo, para baterem com o que a pessoa vê.
    pub local_start: Option<String>,
    /// Nomes das Collections da gravação; vazio cai em [`NO_COLLECTION`].
    pub collections: Vec<String>,
    pub agenda_type: Option<String>,
    pub summary: Option<Summary>,
    pub transcript: Option<Transcript>,
    /// As notas dos marcadores (só os que têm nota), em ordem de instante.
    pub markers: Vec<MirrorMarker>,
}

/// Um marcador com nota: vira uma linha da seção "Notas dos marcadores" do `.md`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorMarker {
    pub at_ms: u64,
    pub note: String,
}

/// O resumo atual.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub version: u64,
    pub markdown: String,
    /// A `revision` da transcrição de que o resumo partiu; `None` num servidor anterior ao 2.25.0.
    pub transcript_revision: Option<u64>,
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

/// Diretório temporário de teste, apagado ao sair de escopo.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    pub struct Tmp(PathBuf);

    impl Tmp {
        pub fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "eclume-mirror-{name}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
