//! Records mic + system audio for a few seconds, without a window or tray, and shows where the
//! `.ogg` was saved. Verifies real capture on a machine with an audio session.
//!
//! ```bash
//! cargo run -p eclume-desktop --example record -- 5 /tmp/eclume-record
//! ```

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use eclume_desktop_lib::capture::{open_sources, AudioChoice};
use eclume_recorder::session::{self, RecorderConfig};
use eclume_recorder::Queue;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut args = std::env::args().skip(1);
    let seconds: u64 = args
        .next()
        .map(|s| s.parse())
        .transpose()
        .context("the first argument is the duration in seconds")?
        .unwrap_or(5);
    let dir = args
        .next()
        .map_or_else(|| std::env::temp_dir().join("eclume-gravar"), PathBuf::from);

    let queue = Queue::open(&dir.join("queue.sqlite"))?;
    let opened = open_sources(&AudioChoice::default())?;
    for reason in &opened.missing {
        eprintln!("warning: recording without {reason}");
    }
    let source_count = opened.sources.len();
    let active = session::start(
        &RecorderConfig::new(&dir),
        &queue,
        opened.sources,
        session::StartOptions::MEETING,
    )?;
    eprintln!("recording {source_count} source(s) for {seconds} s...");
    std::thread::sleep(Duration::from_secs(seconds));
    let rec = active.stop(&queue)?;

    println!("{}", rec.path.display());
    eprintln!(
        "duration {} ms, {} bytes, status {}",
        rec.duration_ms.unwrap_or(0),
        rec.bytes.unwrap_or(0),
        rec.status.as_str()
    );
    Ok(())
}
