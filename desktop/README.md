# eclume desktop

App Tauri 2 do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus mono 16 kHz, guarda a
fila local de gravações e fica na bandeja do sistema. A detecção automática de reunião e o sync
com o servidor entram na spec `desktop-deteccao-e-sync`; os instaladores, em
`distribuicao-desktop`.

| Caminho | O que é |
|---|---|
| `src-tauri/` | o app: bandeja, janela, estado, config e comandos |
| `ui/` | a janela de status e fila (HTML, CSS e JS, sem bundler) |
| `crates/audio-capture/` | captura do mic (`cpal`) e do áudio do sistema (PipeWire/Pulse, WASAPI, Core Audio), adaptada do Anarlog |
| `crates/recorder/` | mixagem para 16 kHz, encoder Ogg/Opus, fila SQLite, sessão de gravação e traits de sync/detecção |
| `crates/resampler/` | reamostrador vendorizado do Anarlog |

O formato da gravação, a fila e os pontos de extensão estão em
[docs/standards/code/desktop-gravacao.md](../docs/standards/code/desktop-gravacao.md); o layout,
os comandos e a regra de vendorização, em
[docs/standards/code/monorepo.md](../docs/standards/code/monorepo.md).

No Linux, o build exige `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libxdo-dev`, `libssl-dev`, `build-essential`, `libasound2-dev`, `libpipewire-0.3-dev`,
`libpulse-dev`, `clang` e `cmake`.

```bash
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
# captura real, sem janela: grava 5 s de mic + sistema e imprime o caminho do .ogg
cargo run --manifest-path desktop/Cargo.toml -p eclume-desktop --example gravar -- 5 /tmp/eclume-gravar
```

O endereço do eclume web (padrão `https://192.168.15.199:8443`) fica em `config.json` no
diretório de config do app e pode ser trocado pela janela ou, sem tocar no arquivo, pela variável
`ECLUME_WEB_URL`.
