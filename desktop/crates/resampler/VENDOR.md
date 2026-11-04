# resampler (vendored from Anarlog)

- Source: <https://github.com/fastrepl/anarlog>, `crates/resampler`
- Pinned commit: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- License: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (full text in `LICENSE`)

## What was included

- `src/driver.rs` — unchanged except for the source header.
- `src/lib.rs` — original re-exports and `Error`, without the `async_source` module.

## What was left out

- The `async-source` feature and `src/async_source/` directory: depend on
  `anlg-audio-interface`, `dasp`, `pin-project` and `futures-util` from the Anarlog workspace.
- `benches/` and dev-dependencies tied to Anarlog test data (`anlg-data`).

To update: repeat the copy from a newer commit, record the SHA here and run
`cargo test -p resampler`.
