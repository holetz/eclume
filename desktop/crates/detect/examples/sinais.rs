//! Diagnóstico de campo: imprime, a cada segundo, o retrato dos sinais do SO e a classificação.
//!
//!     cargo run --manifest-path desktop/Cargo.toml -p eclume-detect --example sinais -- 10

use std::time::Duration;

use eclume_detect::{classify, SignalSource, SystemSignals};

fn main() {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(10);
    let mut signals = SystemSignals::new();
    for _ in 0..seconds {
        match signals.snapshot() {
            Ok(snapshot) => println!("{:?} ← {snapshot:?}", classify(&snapshot)),
            Err(err) => println!("erro: {err:#}"),
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
