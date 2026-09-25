# eclume desktop

App Tauri 2 do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus mono 16 kHz, percebe
sozinho quando uma reunião começa (Teams, Zoom, Meet, com a política de cada app), guarda a fila
local de gravações, sobe-as ao servidor por PAT com upload resumível e fica na bandeja do
sistema.

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
| `crates/detect/` | detecção de reuniões: sinais de mic por SO (adaptados do Anarlog), classificação, debounce e gravação automática |
| `crates/sync/` | sync: upload resumível do contrato v1 por PAT, PAT no chaveiro do SO e CA extra |
| `scripts/manifestos_release.py` | monta `latest.json`, `instaladores.json` e `SHA256SUMS` de um release |

O formato da gravação, a fila e os pontos de extensão estão em
[docs/standards/code/desktop-gravacao.md](../docs/standards/code/desktop-gravacao.md); a detecção,
as políticas, o sync, o PAT e a retenção, em
[docs/standards/code/desktop-deteccao-e-sync.md](../docs/standards/code/desktop-deteccao-e-sync.md); o layout,
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
# sinais de reunião, sem janela: imprime por 10 s quem usa o mic e a classificação
cargo run --manifest-path desktop/Cargo.toml -p eclume-detect --example sinais -- 10
# sync contra o mock do contrato (deploy/docker-compose.mock.yml em 127.0.0.1:4010)
ECLUME_MOCK_URL=http://127.0.0.1:4010 cargo test --manifest-path desktop/Cargo.toml -p eclume-sync --test mock
```

O servidor (padrão `https://192.168.15.199:8443`), o PAT, a CA extra, as políticas por app e a
retenção se configuram pela janela ("Gravações e configurações" na bandeja) e ficam em
`config.json` no diretório de config do app — o PAT, no chaveiro do SO. Sem tocar no arquivo,
`ECLUME_WEB_URL`, `ECLUME_API_URL` e `ECLUME_PAT` sobrepõem servidor, API e PAT.

Os ícones do bundle são gerados de `src-tauri/icons/icon.svg` (os da bandeja, `tray-*.png`, não):

```bash
npx @tauri-apps/cli@2 icon src-tauri/icons/icon.svg -o /tmp/icones
# copie só 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico e icon.png
```
