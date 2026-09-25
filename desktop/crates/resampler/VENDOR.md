# resampler (vendorizado do Anarlog)

- Origem: <https://github.com/fastrepl/anarlog>, `crates/resampler`
- Commit fixado: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- Licença: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (texto integral em `LICENSE`)

## O que foi trazido

- `src/driver.rs` — sem alterações além do cabeçalho de origem.
- `src/lib.rs` — reexportações e `Error` originais, sem o módulo `async_source`.

## O que ficou de fora

- A feature `async-source` e o diretório `src/async_source/`: dependem de
  `anlg-audio-interface`, `dasp`, `pin-project` e `futures-util` do workspace do Anarlog.
- `benches/` e as dev-dependencies ligadas a dados de teste do Anarlog (`anlg-data`).

Para atualizar: repita a cópia a partir de um commit novo, registre o SHA aqui e rode
`cargo test -p resampler`.
