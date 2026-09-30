//! Leva a pasta ao estado do servidor: escreve o que difere, move e apaga só o que o manifesto
//! lista e nunca sai da raiz. O servidor é a fonte: uma edição local num arquivo do app é
//! sobrescrita no ciclo seguinte.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::layout;
use crate::manifest::{sha256_hex, write_atomic, Entry, Manifest};
use crate::{render, MirrorItem};

/// O que um passo de sincronização fez em disco.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub written: usize,
    pub unchanged: usize,
    pub removed: usize,
}

impl Applied {
    pub fn add(&mut self, other: Applied) {
        self.written += other.written;
        self.unchanged += other.unchanged;
        self.removed += other.removed;
    }
}

/// A pasta sincronizada: a raiz e o manifesto em memória (gravado por [`Mirror::save`]).
#[derive(Debug)]
pub struct Mirror {
    pub(crate) root: PathBuf,
    pub(crate) manifest: Manifest,
    /// O manifesto estava ilegível e recomeçou vazio: nada antigo é removido neste ciclo.
    pub recovered: bool,
}

impl Mirror {
    /// Abre (criando, se preciso) a raiz e lê o manifesto.
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root).with_context(|| format!("criar a pasta {}", root.display()))?;
        let (manifest, recovered) = Manifest::load(root);
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            recovered,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// O que o manifesto sabe de uma gravação.
    pub fn entry(&self, recording_id: &str) -> Option<&Entry> {
        self.manifest.recordings.get(recording_id)
    }

    /// Os ids que o manifesto conhece.
    pub fn known_ids(&self) -> BTreeSet<String> {
        self.manifest.recordings.keys().cloned().collect()
    }

    pub fn save(&self) -> Result<()> {
        self.manifest.save(&self.root)
    }

    /// O caminho absoluto de um relativo do manifesto: só componentes normais, dentro da raiz.
    fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let path = Path::new(relative);
        let normal = path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
        if relative.is_empty() || !normal {
            bail!("caminho fora da pasta sincronizada: {relative}");
        }
        Ok(self.root.join(path))
    }

    /// Escreve o conteúdo no caminho relativo, se o disco for diferente.
    pub(crate) fn write_file(&self, relative: &str, content: &[u8]) -> Result<bool> {
        let path = self.resolve(relative)?;
        if let Ok(current) = fs::read(&path) {
            if sha256_hex(&current) == sha256_hex(content) {
                return Ok(false);
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("criar {}", parent.display()))?;
        }
        write_atomic(&path, content)?;
        Ok(true)
    }

    /// Apaga um arquivo do manifesto e as pastas que ficarem vazias (nunca a raiz).
    fn remove_file(&self, relative: &str) -> Result<bool> {
        let path = self.resolve(relative)?;
        let existed = match fs::remove_file(&path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).with_context(|| format!("apagar {}", path.display())),
        };
        let mut dir = path.parent().map(Path::to_path_buf);
        while let Some(current) = dir {
            if current == self.root || !current.starts_with(&self.root) {
                break;
            }
            // `remove_dir` recusa pasta com conteúdo (arquivos do usuário ficam).
            if fs::remove_dir(&current).is_err() {
                break;
            }
            dir = current.parent().map(Path::to_path_buf);
        }
        Ok(existed)
    }

    /// Escreve uma gravação: um `.md` e um `.jsonl` por Collection, e tira o que o manifesto tinha
    /// para ela e deixou de valer (título ou Collection mudou).
    pub fn apply(&mut self, item: &MirrorItem) -> Result<Applied> {
        let mut wanted: Vec<(String, String)> = Vec::new();
        if let Some(markdown) = render::markdown(item) {
            for path in layout::paths(item, "md") {
                wanted.push((path, markdown.clone()));
            }
        }
        if let Some(jsonl) = render::jsonl(item) {
            for path in layout::paths(item, "jsonl") {
                wanted.push((path, jsonl.clone()));
            }
        }
        if wanted.is_empty() {
            return self.forget(&item.recording_id);
        }
        let mut applied = Applied::default();
        for (path, content) in &wanted {
            if self.write_file(path, content.as_bytes())? {
                applied.written += 1;
            } else {
                applied.unchanged += 1;
            }
        }
        let files: Vec<String> = wanted.into_iter().map(|(path, _)| path).collect();
        if let Some(previous) = self.manifest.recordings.get(&item.recording_id) {
            for old in previous.files.clone() {
                if !files.contains(&old) && self.remove_file(&old)? {
                    applied.removed += 1;
                }
            }
        }
        self.manifest.recordings.insert(
            item.recording_id.clone(),
            Entry {
                summary_version: item.summary.as_ref().map(|summary| summary.version),
                transcript_revision: item.transcript.as_ref().map(|t| t.revision),
                files,
            },
        );
        Ok(applied)
    }

    /// Esquece uma gravação: apaga os arquivos que o manifesto lista para ela.
    pub fn forget(&mut self, recording_id: &str) -> Result<Applied> {
        let mut applied = Applied::default();
        let Some(entry) = self.manifest.recordings.get(recording_id).cloned() else {
            return Ok(applied);
        };
        for file in &entry.files {
            if self.remove_file(file)? {
                applied.removed += 1;
            }
        }
        self.manifest.recordings.remove(recording_id);
        Ok(applied)
    }

    /// Esquece o que não está em `keep` (gravações que saíram do servidor).
    pub fn retain_only(&mut self, keep: &BTreeSet<String>) -> Result<Applied> {
        let mut applied = Applied::default();
        for id in self.known_ids() {
            if !keep.contains(&id) {
                applied.add(self.forget(&id)?);
            }
        }
        Ok(applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Tmp;
    use crate::{Segment, Speaker, Summary, Transcript};

    fn item(id: &str, title: &str, colecoes: &[&str], versao: u64) -> MirrorItem {
        MirrorItem {
            recording_id: id.into(),
            title: title.into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            collections: colecoes.iter().map(|c| c.to_string()).collect(),
            agenda_type: None,
            summary: Some(Summary {
                version: versao,
                markdown: format!("# {title} v{versao}"),
            }),
            transcript: Some(Transcript {
                id: format!("t-{id}"),
                language: Some("pt".into()),
                duration_ms: Some(1000),
                revision: 1,
                speakers: vec![Speaker {
                    id: "S1".into(),
                    label: "Ana".into(),
                }],
                segments: vec![Segment {
                    speaker_id: Some("S1".into()),
                    start_ms: 0,
                    end_ms: 900,
                    text: "oi".into(),
                }],
            }),
        }
    }

    fn files(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    #[test]
    fn primeira_passada_escreve_e_a_segunda_nao_mexe_em_nada() {
        let tmp = Tmp::new("reconcile-idempotente");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let ata = item("aaaaaaaa-1", "Ata", &["Clientes", "Interno"], 1);
        let first = mirror.apply(&ata).unwrap();
        assert_eq!((first.written, first.unchanged, first.removed), (4, 0, 0));
        assert_eq!(
            files(tmp.path()),
            [
                "Clientes/2026-09-18 Ata - aaaaaaaa.jsonl",
                "Clientes/2026-09-18 Ata - aaaaaaaa.md",
                "Interno/2026-09-18 Ata - aaaaaaaa.jsonl",
                "Interno/2026-09-18 Ata - aaaaaaaa.md",
            ]
        );
        let second = mirror.apply(&ata).unwrap();
        assert_eq!(
            (second.written, second.unchanged, second.removed),
            (0, 4, 0)
        );
    }

    #[test]
    fn edicao_local_de_arquivo_do_app_e_sobrescrita() {
        let tmp = Tmp::new("reconcile-sobrescreve");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let ata = item("aaaaaaaa-1", "Ata", &["Clientes"], 1);
        mirror.apply(&ata).unwrap();
        let md = tmp.path().join("Clientes/2026-09-18 Ata - aaaaaaaa.md");
        let original = fs::read_to_string(&md).unwrap();
        fs::write(&md, "editei à mão").unwrap();
        let again = mirror.apply(&ata).unwrap();
        assert_eq!(again.written, 1);
        assert_eq!(fs::read_to_string(&md).unwrap(), original);
    }

    #[test]
    fn titulo_novo_move_os_arquivos_e_a_versao_nova_reescreve() {
        let tmp = Tmp::new("reconcile-renomeia");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        let moved = mirror
            .apply(&item("aaaaaaaa-1", "Ata final", &["Clientes"], 2))
            .unwrap();
        assert_eq!((moved.written, moved.removed), (2, 2));
        assert_eq!(
            files(tmp.path())
                .into_iter()
                .filter(|f| !f.starts_with('.'))
                .collect::<Vec<_>>(),
            [
                "Clientes/2026-09-18 Ata final - aaaaaaaa.jsonl",
                "Clientes/2026-09-18 Ata final - aaaaaaaa.md",
            ]
        );
        assert_eq!(mirror.entry("aaaaaaaa-1").unwrap().summary_version, Some(2));
    }

    #[test]
    fn sair_de_uma_colecao_apaga_a_copia_e_a_pasta_vazia() {
        let tmp = Tmp::new("reconcile-colecao");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes", "Interno"], 1))
            .unwrap();
        let applied = mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        // O `.md` que fica muda: a lista `collections` do front matter perdeu uma.
        assert_eq!((applied.written, applied.removed), (1, 2));
        assert!(!tmp.path().join("Interno").exists());
        assert!(tmp.path().join("Clientes").is_dir());
        // Sem nenhuma Collection, vai para `sem-colecao`.
        mirror.apply(&item("aaaaaaaa-1", "Ata", &[], 1)).unwrap();
        assert!(!tmp.path().join("Clientes").exists());
        assert!(tmp
            .path()
            .join("sem-colecao/2026-09-18 Ata - aaaaaaaa.md")
            .exists());
    }

    #[test]
    fn so_o_que_o_manifesto_lista_e_apagado() {
        let tmp = Tmp::new("reconcile-alheios");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        mirror
            .apply(&item("bbbbbbbb-2", "Outra", &["Clientes"], 1))
            .unwrap();
        // Uma nota do usuário na mesma pasta e outra na raiz.
        fs::write(tmp.path().join("Clientes/minha nota.md"), "minha").unwrap();
        fs::write(tmp.path().join("diario.md"), "diario").unwrap();

        let mut keep = BTreeSet::new();
        keep.insert("bbbbbbbb-2".to_string());
        let applied = mirror.retain_only(&keep).unwrap();
        assert_eq!(applied.removed, 2);
        assert!(tmp.path().join("Clientes/minha nota.md").exists());
        assert!(tmp.path().join("diario.md").exists());
        assert!(tmp
            .path()
            .join("Clientes/2026-09-18 Outra - bbbbbbbb.md")
            .exists());
        assert!(!tmp
            .path()
            .join("Clientes/2026-09-18 Ata - aaaaaaaa.md")
            .exists());

        // A pasta com nota do usuário não some, mesmo depois de esquecer tudo.
        mirror.retain_only(&BTreeSet::new()).unwrap();
        assert!(tmp.path().join("Clientes/minha nota.md").exists());
    }

    #[test]
    fn manifesto_salvo_e_relido_e_o_ilegivel_nao_apaga_nada() {
        let tmp = Tmp::new("reconcile-recupera");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        mirror.save().unwrap();
        let reopened = Mirror::open(tmp.path()).unwrap();
        assert!(!reopened.recovered);
        assert_eq!(reopened.known_ids().len(), 1);

        fs::write(tmp.path().join(crate::manifest::FILE), b"lixo").unwrap();
        let mut broken = Mirror::open(tmp.path()).unwrap();
        assert!(broken.recovered);
        assert!(broken.known_ids().is_empty());
        // Sem manifesto, nada foi apagado e a gravação é reescrita sem duplicar.
        let applied = broken
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        assert_eq!(
            (applied.written, applied.unchanged, applied.removed),
            (0, 2, 0)
        );
    }

    #[test]
    fn caminho_do_manifesto_que_foge_da_raiz_e_recusado() {
        let tmp = Tmp::new("reconcile-fuga");
        let fora = tmp.path().join("fora.txt");
        let raiz = tmp.path().join("raiz");
        fs::create_dir_all(&raiz).unwrap();
        fs::write(&fora, "nao apague").unwrap();
        let mut mirror = Mirror::open(&raiz).unwrap();
        for hostil in ["../fora.txt", "/etc/passwd", "a/../../fora.txt", ""] {
            mirror.manifest.recordings.insert(
                "x".into(),
                Entry {
                    files: vec![hostil.into()],
                    ..Entry::default()
                },
            );
            assert!(mirror.forget("x").is_err(), "{hostil}");
        }
        assert_eq!(fs::read_to_string(&fora).unwrap(), "nao apague");
    }

    #[test]
    fn sem_resumo_escreve_so_a_transcricao_e_sem_nada_esquece() {
        let tmp = Tmp::new("reconcile-sem-resumo");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let mut so_transcricao = item("aaaaaaaa-1", "Ata", &["Clientes"], 1);
        so_transcricao.summary = None;
        let applied = mirror.apply(&so_transcricao).unwrap();
        assert_eq!(applied.written, 1);
        assert_eq!(
            files(tmp.path()),
            ["Clientes/2026-09-18 Ata - aaaaaaaa.jsonl"]
        );
        let mut vazio = so_transcricao.clone();
        vazio.transcript = None;
        assert_eq!(mirror.apply(&vazio).unwrap().removed, 1);
        assert!(mirror.entry("aaaaaaaa-1").is_none());
        assert!(files(tmp.path()).is_empty());
    }
}
