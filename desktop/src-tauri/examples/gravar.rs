//! Grava mic + áudio do sistema por alguns segundos, sem janela nem bandeja, e mostra onde ficou
//! o `.ogg`. Serve para provar a captura real numa máquina com sessão de áudio.
//!
//! ```bash
//! cargo run -p eclume-desktop --example gravar -- 5 /tmp/eclume-gravar
//! ```

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use eclume_desktop_lib::capture::open_sources;
use eclume_recorder::session::{self, RecorderConfig};
use eclume_recorder::Queue;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut args = std::env::args().skip(1);
    let seconds: u64 = args
        .next()
        .map(|s| s.parse())
        .transpose()
        .context("o primeiro argumento é a duração em segundos")?
        .unwrap_or(5);
    let dir = args
        .next()
        .map_or_else(|| std::env::temp_dir().join("eclume-gravar"), PathBuf::from);

    let queue = Queue::open(&dir.join("queue.sqlite"))?;
    let opened = open_sources()?;
    for reason in &opened.missing {
        eprintln!("aviso: gravando sem {reason}");
    }
    let fontes = opened.sources.len();
    let active = session::start(&RecorderConfig::new(&dir), &queue, opened.sources)?;
    eprintln!("gravando {fontes} fonte(s) por {seconds} s...");
    std::thread::sleep(Duration::from_secs(seconds));
    let rec = active.stop(&queue)?;

    println!("{}", rec.path.display());
    eprintln!(
        "duração {} ms, {} bytes, estado {}",
        rec.duration_ms.unwrap_or(0),
        rec.bytes.unwrap_or(0),
        rec.status.as_str()
    );
    Ok(())
}
