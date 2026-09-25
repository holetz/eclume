# eclume desktop

App Tauri 2 do eclume. `desktop/Cargo.toml` é o workspace cargo; o app fica em `src-tauri/` e a UI
estática em `ui/`. Captura de áudio, detecção de reunião, bandeja e sync entram nas specs
`desktop-captura-e-bandeja` e `desktop-deteccao-e-sync`; os instaladores, em
`distribuicao-desktop`.

No Linux, o build exige `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libxdo-dev`, `libssl-dev` e `build-essential`.

```bash
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
```
