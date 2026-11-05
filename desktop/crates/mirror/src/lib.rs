//! Local mirror of the eclume library: each recording's current summary as `.md` and its
//! transcript as `.jsonl`, in one subfolder per collection.
//!
//! The folder serves as both an Obsidian vault (`.md` has front matter properties; `.jsonl` and
//! the manifest do not appear in Obsidian) and an agent workspace (`AGENTS.md` at the root).
//! The server is the source: what the app generated is overwritten. Contract in
//! docs/standards/code/desktop-pasta-sincronizada.md.

pub mod agents;
pub mod layout;
pub mod manifest;
pub mod reconcile;
pub mod render;

pub use layout::{base_name, collection_dir, month_dir, slug, NO_COLLECTION};
pub use manifest::Manifest;
pub use reconcile::{Applied, Mirror};

/// What the mirror knows about a recording to write it to disk. No network or Tauri: the caller
/// converts `eclume-sync` types into these.
#[derive(Clone, Debug, PartialEq)]
pub struct MirrorItem {
    pub recording_id: String,
    pub title: String,
    /// The server's `recorded_at` (ISO 8601, UTC): added to front matter; without `local_start`,
    /// determines the file name and month.
    pub recorded_at: Option<String>,
    /// The recording start in local time (`AAAA-MM-DDTHH:MM:SS`), calculated by the app: determines
    /// the monthly subfolder and file name to match what the person sees.
    pub local_start: Option<String>,
    /// The recording's collection names; an empty list falls back to [`NO_COLLECTION`].
    pub collections: Vec<String>,
    pub agenda_type: Option<String>,
    pub summary: Option<Summary>,
    pub transcript: Option<Transcript>,
    /// Marker notes (only markers with notes), ordered by timestamp.
    pub markers: Vec<MirrorMarker>,
}

/// A marker with a note: becomes a line in the `.md` marker notes section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MirrorMarker {
    pub at_ms: u64,
    pub note: String,
}

/// The current summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub version: u64,
    pub markdown: String,
    /// The transcript's `revision` used for the summary; `None` on a server before 2.25.0.
    pub transcript_revision: Option<u64>,
}

/// The transcript, with anything the mirror does not use removed.
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

/// Test temporary directory, deleted when it goes out of scope.
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
