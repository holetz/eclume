//! The root `.eclume-sync.json` manifest: what the app wrote, per recording. Allows moving and
//! deleting only its own files. Starts with a dot, so Obsidian does not show it.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Manifest name at the root of the synced folder.
pub const FILE: &str = ".eclume-sync.json";

const VERSION: u32 = 1;

/// The file layout version (folder and name). Bumped when the layout changes: a manifest from
/// another version makes the next cycle rebuild everything, removing files from the old layout.
pub const LAYOUT: u32 = 2;

/// What was written for a recording.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Mirrored summary version, when there is a `.md`.
    #[serde(default)]
    pub summary_version: Option<u64>,
    /// Mirrored transcript revision, when there is a `.jsonl`.
    #[serde(default)]
    pub transcript_revision: Option<u64>,
    /// Paths relative to the root, with `/`.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub recordings: BTreeMap<String, Entry>,
    /// Recordings that failed to load and await a retry: the cursor advances even on failure, and
    /// the next cycle retries these recordings rather than the entire library.
    #[serde(default)]
    pub pending: BTreeSet<String>,
    /// Whether transcripts were enabled when files were written; absent means "unknown".
    /// Changing the option rebuilds everything next cycle (writes or removes `.jsonl` files).
    #[serde(default)]
    pub transcripts: Option<bool>,
    /// The layout used to write the files; absent (old manifest) means `0`.
    #[serde(default)]
    pub layout: u32,
    /// The greatest mirrored `updated_at`: the next cycle's `?since=`. Stored here rather than in
    /// the app state so that deleting the folder (or changing it) rebuilds everything.
    #[serde(default)]
    pub since: Option<String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: VERSION,
            recordings: BTreeMap::new(),
            pending: BTreeSet::new(),
            transcripts: None,
            layout: 0,
            since: None,
        }
    }
}

impl Manifest {
    /// Reads the root manifest. Missing or unreadable becomes an empty manifest (`true` in the
    /// second value when unreadable): without a manifest the app deletes nothing, only rewrites.
    pub fn load(root: &Path) -> (Self, bool) {
        match fs::read(root.join(FILE)) {
            Ok(bytes) => match serde_json::from_slice::<Manifest>(&bytes) {
                Ok(manifest) if manifest.version == VERSION => (manifest, false),
                _ => (Self::default(), true),
            },
            Err(_) => (Self::default(), false),
        }
    }

    /// Saves the manifest via a temporary file and rename, so it is never left half-written.
    pub fn save(&self, root: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(self).context("serializar o manifesto")?;
        write_atomic(&root.join(FILE), text.as_bytes())
    }
}

/// Writes `bytes` to `path` via an adjacent temporary file (with a dot: Obsidian ignores it).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, bytes).with_context(|| format!("escrever {}", tmp.display()))?;
    if let Err(error) = fs::rename(&tmp, path) {
        // On Windows, renaming fails while the file is open (Obsidian, antivirus, OneDrive):
        // do not leave the temporary file behind.
        let _ = fs::remove_file(&tmp);
        return Err(error).with_context(|| format!("renomear para {}", path.display()));
    }
    Ok(())
}

/// SHA-256 in lowercase hexadecimal.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Tmp;

    #[test]
    fn manifest_round_trips_through_disk() {
        let tmp = Tmp::new("manifest-roundtrip");
        let mut manifest = Manifest::default();
        manifest.recordings.insert(
            "r1".into(),
            Entry {
                summary_version: Some(2),
                transcript_revision: Some(1),
                files: vec!["Clientes/a.md".into()],
            },
        );
        manifest.save(tmp.path()).unwrap();
        let (loaded, recovered) = Manifest::load(tmp.path());
        assert!(!recovered);
        assert_eq!(loaded, manifest);
        assert!(!tmp.path().join(".eclume-sync.json.tmp").exists());
    }

    #[test]
    fn missing_manifest_is_empty_and_corrupt_manifest_is_flagged_empty() {
        let tmp = Tmp::new("manifest-ausente");
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), false));
        fs::write(tmp.path().join(FILE), b"{ isto nao e json").unwrap();
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), true));
        fs::write(tmp.path().join(FILE), br#"{"version": 99}"#).unwrap();
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), true));
    }

    #[test]
    fn known_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
