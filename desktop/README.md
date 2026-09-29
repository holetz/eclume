# eclume desktop

App Tauri 2 do eclume: grava reuniões (mic + áudio do sistema) em Ogg/Opus mono 16 kHz, percebe
sozinho quando uma reunião começa (Teams, Zoom, Meet, com a política de cada app), grava notas por
voz que param no silêncio, marca instantes durante a gravação, importa arquivos de áudio e vídeo,
guarda a fila local e a sobe ao servidor com upload resumível, e fica na bandeja do sistema. Na
primeira execução, a pessoa entra com e-mail e senha no servidor embutido no instalador (ou achado
na rede por mDNS), com a CA fixada pela impressão digital.

Os instaladores saem do host, por `bash deploy/release-desktop.sh` (Linux; Windows com
`--windows`; macOS fora enquanto o repositório for privado), ou do workflow `desktop-release` à
mão, e o app se atualiza sozinho pelo updater do Tauri; o processo está em
[docs/standards/code/desktop-distribuicao.md](../docs/standards/code/desktop-distribuicao.md) e o
passo a passo para o usuário, em [INSTALACAO.md](INSTALACAO.md).

| Caminho | O que é |
|---|---|
| `src-tauri/` | o app: bandeja, janela, estado, config e comandos |
| `ui/` | a janela no Design System do eclume (HTML e módulos ES, sem bundler) |
| `ui-tests/` | testes Playwright da janela com o Tauri simulado, inclusive a verificação visual |
| `crates/audio-capture/` | captura do mic (`cpal`) e do áudio do sistema (PipeWire/Pulse, WASAPI, Core Audio), adaptada do Anarlog |
| `crates/recorder/` | mixagem para 16 kHz, encoder Ogg/Opus, detector de silêncio da nota, fila SQLite (v3, com marcadores), sessão de gravação e traits de sync/detecção |
| `crates/resampler/` | reamostrador vendorizado do Anarlog |
| `crates/detect/` | detecção de reuniões: sinais de mic por SO (adaptados do Anarlog), classificação, debounce e gravação automática |
| `crates/sync/` | sync: upload resumível do contrato v1, login e pareamento de dispositivo, CA fixada, descoberta mDNS e a credencial no chaveiro do SO |
| `crates/import/` | importação: duração e data do arquivo (`mvhd`, tags, modificação) e conversão para Opus pelo `symphonia` |
| `scripts/manifestos_release.py` | monta `latest.json`, `instaladores.json` e `SHA256SUMS` de um release |
| `scripts/sincronizar_ds.sh` | copia o `eclume.css` e as fontes do Design System para `ui/` |
| `scripts/cdp.mjs` | `eval` e captura na janela real pelo CDP do WebView2 |
| `scripts/prova-windows.ps1`, `scripts/prova_nota.py` | a prova da nota por voz numa estação Windows |

O formato da gravação, a nota por voz, os marcadores e a fila estão em
[docs/standards/code/desktop-gravacao.md](../docs/standards/code/desktop-gravacao.md); a detecção,
as políticas, a conta, o sync e a retenção, em
[docs/standards/code/desktop-deteccao-e-sync.md](../docs/standards/code/desktop-deteccao-e-sync.md); a
janela, em [desktop-interface.md](../docs/standards/code/desktop-interface.md); a importação, em
[desktop-importacao.md](../docs/standards/code/desktop-importacao.md); o layout, os comandos e a
regra de vendorização, em [docs/standards/code/monorepo.md](../docs/standards/code/monorepo.md).

No Linux, o build exige `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libxdo-dev`, `libssl-dev`, `build-essential`, `libasound2-dev`, `libpipewire-0.3-dev`,
`libpulse-dev`, `clang` e `cmake`. Sem elas (ou sem sudo), o `build.Dockerfile` monta o mesmo
ambiente da CI num contêiner; o `cargo` e a CLI do Tauri rodam dentro dele, com o repositório
montado. O build do desktop é pesado: numa estação que também roda IDE e navegador, limite a CPU
(`--cpus 2`, `CARGO_BUILD_JOBS=2`) ou rode num host à parte.

```bash
docker build -t eclume-desktop-build -f desktop/build.Dockerfile desktop
docker run --rm --cpus 2 -e CARGO_BUILD_JOBS=2 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/src" -w /src eclume-desktop-build \
  cargo test --manifest-path desktop/Cargo.toml --workspace
# o .deb, sem os artefatos assinados do updater
docker run --rm --cpus 2 -e CARGO_BUILD_JOBS=2 -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/src" -w /src/desktop/src-tauri eclume-desktop-build \
  npx --yes @tauri-apps/cli@2 build --bundles deb --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

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
# a janela num Chromium, com o Tauri simulado (capturas em ui-tests/capturas/)
npm --prefix desktop/ui-tests ci && npm --prefix desktop/ui-tests test
# um build com o servidor embutido, como o release faz
ECLUME_SERVER_URL=https://192.168.15.199:8443 ECLUME_SERVER_CA_SHA256=<sha256> cargo build --manifest-path desktop/Cargo.toml -p eclume-desktop
```

O servidor e a conta (na primeira execução), a CA extra, as políticas por app, o microfone, os
atalhos, a parada por silêncio e a retenção se configuram pela janela ("Abrir o eclume" na
bandeja) e ficam em `config.json` no diretório de config do app — a credencial, no chaveiro do
SO. Sem tocar no arquivo, `ECLUME_WEB_URL`, `ECLUME_API_URL` e `ECLUME_PAT` sobrepõem servidor,
API e credencial (dev e testes).

Os ícones do bundle são gerados de `src-tauri/icons/icon.svg` (os da bandeja, `tray-*.png`, não):

```bash
npx @tauri-apps/cli@2 icon src-tauri/icons/icon.svg -o /tmp/icones
# copie só 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico e icon.png
```
