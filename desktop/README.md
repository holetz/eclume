# eclume desktop

App Tauri 2 do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus mono 16 kHz, guarda a
fila local de gravações e fica na bandeja do sistema. A detecção automática de reunião e o sync
com o servidor entram na spec `desktop-deteccao-e-sync`.

Os instaladores (Windows, Linux e macOS) saem do workflow `desktop-release` e o app se atualiza
sozinho pelo updater do Tauri; o processo está em
[docs/standards/code/desktop-distribuicao.md](../docs/standards/code/desktop-distribuicao.md) e o
passo a passo para o usuário, em [INSTALACAO.md](INSTALACAO.md).

| Caminho | O que é |
|---|---|
| `src-tauri/` | o app: bandeja, janela, estado, config e comandos |
| `ui/` | a janela de status e fila (HTML, CSS e JS, sem bundler) |
| `crates/audio-capture/` | captura do mic (`cpal`) e do áudio do sistema (PipeWire/Pulse, WASAPI, Core Audio), adaptada do Anarlog |
| `crates/recorder/` | mixagem para 16 kHz, encoder Ogg/Opus, fila SQLite, sessão de gravação e traits de sync/detecção |
| `crates/resampler/` | reamostrador vendorizado do Anarlog |
| `scripts/manifestos_release.py` | monta `latest.json`, `instaladores.json` e `SHA256SUMS` de um release |

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

Os ícones do bundle são gerados de `src-tauri/icons/icon.svg` (os da bandeja, `tray-*.png`, não):

```bash
npx @tauri-apps/cli@2 icon src-tauri/icons/icon.svg -o /tmp/icones
# copie só 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico e icon.png
```
