//! Brings the folder to the server's state: writes what differs, moves and deletes only what the
//! manifest lists, and never leaves the root. The server is the source: local edits to an app file
//! are overwritten on the next cycle.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::layout;
use crate::manifest::{sha256_hex, write_atomic, Entry, Manifest};
use crate::{render, MirrorItem};

/// What a sync step did on disk.
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

/// The synced folder: the root and in-memory manifest (saved by [`Mirror::save`]).
#[derive(Debug)]
pub struct Mirror {
    pub(crate) root: PathBuf,
    pub(crate) manifest: Manifest,
}

impl Mirror {
    /// Opens (creating if needed) the root and reads the manifest.
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root).with_context(|| format!("criar a pasta {}", root.display()))?;
        // An unreadable manifest starts empty: without entries, no old files are removed.
        let (manifest, _) = Manifest::load(root);
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// What the manifest knows about a recording.
    pub fn entry(&self, recording_id: &str) -> Option<&Entry> {
        self.manifest.recordings.get(recording_id)
    }

    /// The ids the manifest knows.
    pub fn known_ids(&self) -> BTreeSet<String> {
        self.manifest.recordings.keys().cloned().collect()
    }

    /// Files were written with a different folder and name layout, or a previous transcript option:
    /// the next cycle rebuilds everything, and the manifest moves and deletes what was left behind.
    pub fn needs_rebuild(&self, transcripts: bool) -> bool {
        self.manifest.layout != crate::manifest::LAYOUT
            || self.manifest.transcripts != Some(transcripts)
    }

    /// Stores the transcript option used when the files were written.
    pub fn set_transcripts(&mut self, transcripts: bool) {
        self.manifest.transcripts = Some(transcripts);
    }

    /// Recordings that failed and await a retry.
    pub fn pending(&self) -> &std::collections::BTreeSet<String> {
        &self.manifest.pending
    }

    pub fn set_pending(&mut self, pending: std::collections::BTreeSet<String>) {
        self.manifest.pending = pending;
    }

    /// Marks everything as written in the current layout (only after a cycle without failures).
    pub fn mark_layout_current(&mut self) {
        self.manifest.layout = crate::manifest::LAYOUT;
    }

    /// The next `?since=` cursor; `None` on the first pass.
    pub fn since(&self) -> Option<&str> {
        self.manifest.since.as_deref()
    }

    pub fn set_since(&mut self, since: Option<String>) {
        self.manifest.since = since;
    }

    pub fn save(&self) -> Result<()> {
        self.manifest.save(&self.root)
    }

    /// The absolute path of a manifest relative path: only normal components, within the root.
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

    /// Writes content to the relative path if the disk content differs.
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

    /// Deletes a manifest file and any folders left empty (never the root).
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
            // `remove_dir` refuses nonempty folders (user files stay).
            if fs::remove_dir(&current).is_err() {
                break;
            }
            dir = current.parent().map(Path::to_path_buf);
        }
        Ok(existed)
    }

    /// Writes a recording: one `.md` and one `.jsonl` per collection, removing manifest entries
    /// for it that no longer apply (title or collection changed).
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

    /// Forgets a recording: deletes the files the manifest lists for it.
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

    /// Forgets what is not in `keep` (recordings removed from the server).
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

    fn item(id: &str, title: &str, collections: &[&str], version: u64) -> MirrorItem {
        MirrorItem {
            recording_id: id.into(),
            title: title.into(),
            recorded_at: Some("2026-09-18T14:00:05Z".into()),
            local_start: Some("2026-09-18T11:00:05".into()),
            collections: collections.iter().map(|c| c.to_string()).collect(),
            agenda_type: None,
            summary: Some(Summary {
                version,
                markdown: format!("# {title} v{version}"),
                transcript_revision: None,
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
            markers: vec![],
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
    fn first_pass_writes_and_second_pass_changes_nothing() {
        let tmp = Tmp::new("reconcile-idempotente");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let minutes = item("aaaaaaaa-1", "Ata", &["Clientes", "Interno"], 1);
        let first = mirror.apply(&minutes).unwrap();
        assert_eq!((first.written, first.unchanged, first.removed), (4, 0, 0));
        assert_eq!(
            files(tmp.path()),
            [
                "Clientes/2026-09/2026-09-18_1100_aaaaaaaa.jsonl",
                "Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md",
                "Interno/2026-09/2026-09-18_1100_aaaaaaaa.jsonl",
                "Interno/2026-09/2026-09-18_1100_aaaaaaaa.md",
            ]
        );
        let second = mirror.apply(&minutes).unwrap();
        assert_eq!(
            (second.written, second.unchanged, second.removed),
            (0, 4, 0)
        );
    }

    #[test]
    fn local_edit_to_app_file_is_overwritten() {
        let tmp = Tmp::new("reconcile-sobrescreve");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let minutes = item("aaaaaaaa-1", "Ata", &["Clientes"], 1);
        mirror.apply(&minutes).unwrap();
        let md = tmp
            .path()
            .join("Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md");
        let original = fs::read_to_string(&md).unwrap();
        fs::write(&md, "editei à mão").unwrap();
        let again = mirror.apply(&minutes).unwrap();
        assert_eq!(again.written, 1);
        assert_eq!(fs::read_to_string(&md).unwrap(), original);
    }

    #[test]
    fn new_title_rewrites_in_place_and_new_start_time_moves_files() {
        let tmp = Tmp::new("reconcile-renomeia");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        // The name omits the title: changing the title (and version) rewrites `.md` and `.jsonl`
        // (the title is in meta) in place, without moving anything.
        let renamed = mirror
            .apply(&item("aaaaaaaa-1", "Ata final", &["Clientes"], 2))
            .unwrap();
        assert_eq!((renamed.written, renamed.removed), (2, 0));
        assert_eq!(
            files(tmp.path())
                .into_iter()
                .filter(|f| !f.starts_with('.'))
                .collect::<Vec<_>>(),
            [
                "Clientes/2026-09/2026-09-18_1100_aaaaaaaa.jsonl",
                "Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md",
            ]
        );
        let md = std::fs::read_to_string(
            tmp.path()
                .join("Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md"),
        )
        .unwrap();
        assert!(md.contains("title: \"Ata final\"") && md.contains("aliases:"));
        assert_eq!(mirror.entry("aaaaaaaa-1").unwrap().summary_version, Some(2));

        // Changing the start (the computer's time zone changed, or the date was fixed) moves files,
        // even across months, and deletes the old month's folder.
        let mut later = item("aaaaaaaa-1", "Ata final", &["Clientes"], 2);
        later.local_start = Some("2026-10-01T00:30:00".into());
        let moved = mirror.apply(&later).unwrap();
        assert_eq!((moved.written, moved.removed), (2, 2));
        assert!(!tmp.path().join("Clientes/2026-09").exists());
        assert!(tmp
            .path()
            .join("Clientes/2026-10/2026-10-01_0030_aaaaaaaa.md")
            .exists());
    }

    #[test]
    fn leaving_a_collection_deletes_copy_and_empty_folder() {
        let tmp = Tmp::new("reconcile-colecao");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes", "Interno"], 1))
            .unwrap();
        let applied = mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        // The remaining `.md` changes: its front matter `collections` list lost one entry.
        assert_eq!((applied.written, applied.removed), (1, 2));
        assert!(!tmp.path().join("Interno").exists());
        assert!(tmp.path().join("Clientes").is_dir());
        // Without any collection, it goes to `sem-colecao`.
        mirror.apply(&item("aaaaaaaa-1", "Ata", &[], 1)).unwrap();
        assert!(!tmp.path().join("Clientes").exists());
        assert!(tmp
            .path()
            .join("sem-colecao/2026-09/2026-09-18_1100_aaaaaaaa.md")
            .exists());
    }

    #[test]
    fn only_files_listed_in_manifest_are_deleted() {
        let tmp = Tmp::new("reconcile-alheios");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        mirror
            .apply(&item("bbbbbbbb-2", "Outra", &["Clientes"], 1))
            .unwrap();
        // A user note in the same folder and another at the root.
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
            .join("Clientes/2026-09/2026-09-18_1100_bbbbbbbb.md")
            .exists());
        assert!(!tmp
            .path()
            .join("Clientes/2026-09/2026-09-18_1100_aaaaaaaa.md")
            .exists());

        // The folder with a user note stays, even after forgetting everything.
        mirror.retain_only(&BTreeSet::new()).unwrap();
        assert!(tmp.path().join("Clientes/minha nota.md").exists());
    }

    #[test]
    fn saved_manifest_is_reloaded_and_unreadable_manifest_deletes_nothing() {
        let tmp = Tmp::new("reconcile-recupera");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        mirror
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        mirror.save().unwrap();
        let reopened = Mirror::open(tmp.path()).unwrap();
        assert_eq!(reopened.known_ids().len(), 1);

        fs::write(tmp.path().join(crate::manifest::FILE), b"lixo").unwrap();
        let mut broken = Mirror::open(tmp.path()).unwrap();
        assert!(broken.known_ids().is_empty());
        // Without a manifest, nothing was deleted; the recording is rewritten without duplicates.
        let applied = broken
            .apply(&item("aaaaaaaa-1", "Ata", &["Clientes"], 1))
            .unwrap();
        assert_eq!(
            (applied.written, applied.unchanged, applied.removed),
            (0, 2, 0)
        );
    }

    #[test]
    fn manifest_from_another_layout_requires_full_rebuild() {
        let tmp = Tmp::new("reconcile-layout");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        assert!(mirror.needs_rebuild(true));
        mirror.mark_layout_current();
        mirror.set_transcripts(true);
        mirror.save().unwrap();
        let again = Mirror::open(tmp.path()).unwrap();
        assert!(!again.needs_rebuild(true));
        // Changing the transcript option also requires rebuilding everything.
        assert!(again.needs_rebuild(false));
        // A manifest from before the layout version (without the field) is outdated.
        fs::write(
            tmp.path().join(crate::manifest::FILE),
            br#"{"version": 1, "recordings": {}}"#,
        )
        .unwrap();
        assert!(Mirror::open(tmp.path()).unwrap().needs_rebuild(true));
    }

    #[test]
    fn cursor_travels_with_folder() {
        let tmp = Tmp::new("reconcile-since");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        assert_eq!(mirror.since(), None);
        mirror.set_since(Some("2026-09-19T10:00:05Z".into()));
        mirror.save().unwrap();
        assert_eq!(
            Mirror::open(tmp.path()).unwrap().since(),
            Some("2026-09-19T10:00:05Z")
        );
        // A manifest from before the cursor (without the field) reads as "first pass".
        fs::write(
            tmp.path().join(crate::manifest::FILE),
            br#"{"version": 1, "recordings": {}}"#,
        )
        .unwrap();
        assert_eq!(Mirror::open(tmp.path()).unwrap().since(), None);
    }

    #[test]
    fn manifest_path_escaping_root_is_rejected() {
        let tmp = Tmp::new("reconcile-fuga");
        let outside = tmp.path().join("fora.txt");
        let root = tmp.path().join("raiz");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "nao apague").unwrap();
        let mut mirror = Mirror::open(&root).unwrap();
        for hostile in ["../fora.txt", "/etc/passwd", "a/../../fora.txt", ""] {
            mirror.manifest.recordings.insert(
                "x".into(),
                Entry {
                    files: vec![hostile.into()],
                    ..Entry::default()
                },
            );
            assert!(mirror.forget("x").is_err(), "{hostile}");
        }
        assert_eq!(fs::read_to_string(&outside).unwrap(), "nao apague");
    }

    #[test]
    fn writes_only_transcript_without_summary_and_forgets_without_either() {
        let tmp = Tmp::new("reconcile-sem-resumo");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        let mut transcript_only = item("aaaaaaaa-1", "Ata", &["Clientes"], 1);
        transcript_only.summary = None;
        let applied = mirror.apply(&transcript_only).unwrap();
        assert_eq!(applied.written, 1);
        assert_eq!(
            files(tmp.path()),
            ["Clientes/2026-09/2026-09-18_1100_aaaaaaaa.jsonl"]
        );
        let mut empty = transcript_only.clone();
        empty.transcript = None;
        assert_eq!(mirror.apply(&empty).unwrap().removed, 1);
        assert!(mirror.entry("aaaaaaaa-1").is_none());
        assert!(files(tmp.path()).is_empty());
    }
}
