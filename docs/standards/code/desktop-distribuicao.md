---
type: standard
title: Distribuição do app desktop
description: Como o app desktop do eclume vira instaladores e se atualiza — versão no tauri.conf.json, tag desktop-v<versão>, release no host pelo deploy/release-desktop.sh (Linux; Windows opcional por compilação cruzada; macOS fora enquanto o repositório for privado) e o workflow desktop-release como alternativa manual, o endereço e a impressão digital do servidor embutidos no build, pacotes do updater assinados com a chave minisign própria, latest.json e instaladores.json com URLs do servidor eclume, publicação em /srv/eclume/downloads pelo deploy/publicar-desktop.sh e o aviso "Atualizado para X".
resource: desktop/src-tauri/tauri.conf.json, desktop/src-tauri/build.rs, desktop/src-tauri/icons/**, desktop/src-tauri/Info.plist, desktop/src-tauri/src/updater.rs, desktop/src-tauri/src/config.rs, desktop/scripts/manifestos_release.py, desktop/scripts/icones_bandeja.py, desktop/INSTALACAO.md, desktop/build.Dockerfile, desktop/build-windows.Dockerfile, .github/workflows/desktop-release.yml, .github/workflows/desktop-plataformas.yml, deploy/release-desktop.sh, deploy/publicar-desktop.sh
tags: [code, desktop, release, updater, tauri, ci, instaladores]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#16, holetz/eclume#26, holetz/eclume#40, holetz/eclume#57, holetz/eclume#60, holetz/eclume#88, holetz/eclume#89, holetz/eclume#90
maintainer: holetz
---

# Distribuição do app desktop

O app desktop sai em instaladores **sem assinatura de código** (não há certificado) e se atualiza sozinho pelo updater do Tauri, cujo pacote é assinado com uma
**chave minisign própria**. Como o repositório é privado, os clientes nunca baixam do GitHub:
baixam do próprio servidor eclume, em `https://192.168.15.199:8443/downloads/`.

Enquanto o repositório for privado, os minutos do GitHub Actions têm cota, e o release sai **do
host**, sem Actions. Plataformas:

| Plataforma | Estado |
|---|---|
| Linux | sai em todo release (AppImage e deb) |
| Windows | sai em todo release (NSIS); `--sem-windows` no host ou `windows: false` no workflow o deixam de fora |
| macOS | **fora** até o repositório ficar público (o minuto de macOS custa 10×) |

Uma plataforma fora do release some do `latest.json`, e os clientes dela ficam na versão que têm.

```
deploy/release-desktop.sh (na estação) ──► host: contêiner --cpus 2 ──► GitHub Release (privado)
   git archive do commit                   │ build Linux (+ Windows)          │ desktop-v<versão>
                                           │ assina com a chave do host (.sig) │ gh release download
                                           └ latest.json, instaladores.json,   ▼
                                             SHA256SUMS      deploy/publicar-desktop.sh (no host)
                                                                               │
                                   /srv/eclume/downloads/ ◄────────────────────┘ ──► Caddy /downloads/
```

## Versão e tag

- A versão publicada é o campo `version` de `desktop/src-tauri/tauri.conf.json`. O `version` do
  workspace cargo (`desktop/Cargo.toml`) acompanha por convenção, mas o release não o lê.
- A tag é `desktop-v<versão>`, criada pelo próprio release (`gh release create --target <commit>`),
  nunca à mão: ela não dispara workflow nenhum.
- Lançar uma versão: subir o `version`, fazer merge em `main`, publicar a `main`, esperar o gate do
  host (`eclume/gate` = `success` no commit; [monorepo.md](monorepo.md)) e rodar
  `bash deploy/release-desktop.sh --publicar --notas "<notas>"`.

## Release no host — `deploy/release-desktop.sh`

- Roda **na estação** e opera o host pelo contexto Docker (`gpu-host`) e por SSH, como o
  `deploy/deploy.sh`. `--plan` só mostra versão, tag, commit, alvos, pastas, disco e os
  impedimentos, sem escrever.
- O código vai **do commit**, não da árvore de trabalho: `git archive HEAD` segue para
  `~/eclume-build/release/src` no host, recriada a cada release. Com `--publicar`, o script recusa
  árvore suja, commit que o GitHub não tem, commit sem o status `eclume/gate` = `success` (o gate
  do host) e tag que já existe. A dispensa do gate é explícita e por invocação:
  `--sem-gate "<motivo>"` dispensa só o status e publica no commit o rastro
  `eclume/gate-dispensa` = `failure` com o motivo; árvore limpa e commit no GitHub seguem exigidos. Sem `--publicar` é **ensaio**: os
  artefatos ficam em `~/eclume-build/release/dist-<versão>/` no host e nada é publicado.
- A imagem de build sai de `desktop/build.Dockerfile` com o contexto mínimo (só o
  `desktop/rust-toolchain.toml`): Ubuntu 24.04 e Node por digest, o Rust do arquivo, e a tag
  `eclume-desktop-build:<versão do Rust>` (a Windows idem, com o `cargo-xwin` de versão fixada).
  A CLI do Tauri sai de `desktop/package-lock.json`: um contêiner **sem a chave do updater** roda
  `npm ci --ignore-scripts`, e só depois o build, com a chave, executa `npx --no-install tauri`.
- O build roda no contêiner dessa imagem com
  `--cpus 2`, `CARGO_BUILD_JOBS=2` e `nice`, como o uid 1000; `target/` (`target-linux`,
  `target-windows`) e o registry do cargo (`~/eclume-build/cargo-registry`) persistem no host
  para os builds seguintes serem incrementais. O script recusa começar com o disco do host em
  `ECLUME_DISK_LIMIT` (90%) ou mais, e uma trava (`~/eclume-build/release/.trava`) impede dois
  releases ao mesmo tempo.
- **Windows** (padrão; `--sem-windows` omite): compilação cruzada no contêiner de `desktop/build-windows.Dockerfile`
  (`nsis`, `lld`/`llvm` 18, o target `x86_64-pc-windows-msvc` e o `cargo-xwin`), com
  `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis`. Sai só o
  NSIS: o MSI exige o WiX, que só roda no Windows. A imagem e o libopus compilado cruzado foram
  provados no ensaio de holetz/eclume#68 (o NSIS saiu do host).
- Os manifestos saem no host, por `manifestos_release.py` (com `desktop/INSTALACAO.md` copiado), e
  o `SHA256SUMS` é conferido antes de publicar. `--publicar` cria o GitHub Release pelo `gh` do
  host; `--notas` vira o `notes` do `latest.json` e o texto do aviso "Atualizado para X" (vazio,
  `eclume desktop <versão>`).

## Workflow `desktop-release.yml` — a alternativa

- Dispara **só** por `workflow_dispatch`: a tag que o release no host cria não o dispara. Faz o
  mesmo release no GitHub Actions — Linux sempre; Windows (`nsis,msi`, em `windows-2025`) com
  a entrada `windows`, ligada por padrão (o minuto custa 2×; desmarque para só Linux). `publicar: false`
  (padrão) é ensaio — os artefatos ficam no run. Para publicar, o job `plano` confere
  `eclume/gate` = `success` no commit (permissão `statuses: read`, `deploy/gate.py decidir`) e
  falha sem ele; aqui não há dispensa — quem precisa dispensar publica pelo host.
- A CLI do Tauri é a de `desktop/package-lock.json` (versão exata, a mesma do mobile), instalada
  por `npm --prefix desktop ci --ignore-scripts` num passo sem os secrets e executada por
  `npx --no-install tauri build --ci --bundles <lista>`, sem `tauri-action`: o `latest.json` dela
  apontaria para URLs privadas do GitHub.
- O código só-Windows compila e passa no `clippy -D warnings` a cada gate do host, por compilação
  cruzada (pilar `windows`). A prova de **execução** num Windows de verdade segue manual:
  `desktop-plataformas.yml` (à mão) faz o `cargo check` do workspace e roda os testes de
  `eclume-mirror` e `eclume-sync` em `windows-2025`.

## Servidor embutido no instalador

- O release é por servidor (os manifestos já têm URLs absolutas deste host), então o build
  embute o endereço e a impressão digital da CA raiz: o build recebe `ECLUME_SERVER_URL` e
  `ECLUME_SERVER_CA_SHA256` das **variáveis do repositório** (gravadas pela holetz/eclume#35, ao
  lado de `ECLUME_DOWNLOADS_URL`); o `release-desktop.sh` as lê por `gh variable get` e aceita
  override pelo ambiente.
- O app os lê por `option_env!` (`config::embedded_server`), com
  `cargo:rerun-if-env-changed` no `build.rs`. Variável vazia ou endereço inválido não embutem
  nada; um build local, sem elas, não tem servidor embutido.
- A primeira execução mostra o embutido como "Veio com este instalador" e fixa a CA pela
  impressão digital, sem a pessoa digitar endereço
  ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)). O `web_url` padrão de uma config
  nova é o embutido; o `https://192.168.15.199:8443` só vale num build sem servidor embutido.

| Plataforma | Onde compila | Saída |
|---|---|---|
| Linux | Ubuntu 24.04 (o `libspa` do crate `pipewire` não compila com o PipeWire 0.3.48 do 22.04; o AppImage exige glibc 2.39+) | `eclume_<v>_amd64.AppImage` e `eclume_<v>_amd64.deb`, com `.sig` |
| Windows (opcional) | host: cruzado com `cargo-xwin`; Actions: `windows-latest` | `eclume_<v>_x64-setup.exe` (NSIS, por usuário, sem admin), com `.sig`; o `eclume_<v>_x64_pt-BR.msi` (WiX) só pelo Actions |
| macOS (fora) | `macos-latest`, `--target universal-apple-darwin`, quando voltar | `eclume_<v>_universal.dmg` e `eclume_<v>_universal.app.tar.gz` (+ `.sig`), um só para Intel e Apple Silicon |

- O AppImage é gerado com `APPIMAGE_EXTRACT_AND_RUN=1` (sem FUSE no contêiner nem no runner) e
  `NO_STRIP=true` (o `strip` do linuxdeploy falha em binários com `.relr.dyn`).

## Bundle

- `bundle.createUpdaterArtifacts: true` assina cada pacote com `TAURI_SIGNING_PRIVATE_KEY` e
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (no host, lidas da cópia em `/srv/eclume/secrets`; no
  Actions, dos secrets).
- O `.deb` declara as libs de áudio que o binário liga dinamicamente (`libasound2`,
  `libpulse0`, `libpipewire-0.3-0`, com a alternativa `t64` do Ubuntu 24.04); o TLS é rustls,
  sem `libssl`.
- macOS: `minimumSystemVersion` 15.0 (o `cidre` da captura de sistema compila com `macos_15_0`),
  assinatura **ad hoc** (`signingIdentity: "-"`), sem hardened runtime, e o `Info.plist` com
  `NSMicrophoneUsageDescription` e `NSAudioCaptureUsageDescription`, sem os quais o macOS nega o
  microfone e o process tap.
- Os ícones do bundle são gerados de `desktop/src-tauri/icons/icon.svg` por `tauri icon`, e só
  entram os que o `bundle.icon` lista.
- Os da bandeja, `tray-{idle,recording,note,syncing}.png` (64 × 64), saem da mesma marca por
  `uv run --with pillow python desktop/scripts/icones_bandeja.py`: o quadrado laranja com as
  cinco barras brancas; na reunião o quadrado vai na cor de gravação do DS, e a nota e o envio
  ganham um ponto de estado. O `tray.rs` troca o ícone só quando o estado muda — no Linux cada
  troca grava um PNG e recarrega o AppIndicator —, e nunca pelo nível do áudio. No GNOME, a
  extensão do AppIndicator às vezes lê o PNG temporário (`/run/user/<uid>/tray-icon/`) depois
  que o `tray-icon` já o trocou pelo seguinte e registra "Failed to recognize image format": uma
  corrida do crate, cujo único efeito é o ícone daquela troca não aparecer.

## Manifestos

`manifestos_release.py` grava na pasta do release, com URLs absolutas
`<base>/<versão>/<arquivo>` (base na variável de repositório `ECLUME_DOWNLOADS_URL`, padrão
`https://192.168.15.199:8443/downloads`):

- **`latest.json`** — o manifesto do updater: `version`, `notes`, `pub_date` e `platforms` com
  `url` e `signature` (conteúdo do `.sig`). Chaves por instalador (`windows-x86_64-nsis`,
  `windows-x86_64-msi`, `linux-x86_64-appimage`, `linux-x86_64-deb`, `darwin-<arch>-app`) e as
  genéricas (`windows-x86_64` → NSIS, `linux-x86_64` → AppImage, `darwin-aarch64` e
  `darwin-x86_64` → o universal). O updater procura primeiro `<os>-<arch>-<instalador>`.
- **`instaladores.json`** — o que a página de download consome: `versao`, `publicado_em`,
  `notas`, `instalacao` (URL do `INSTALACAO.md`) e `instaladores[]` com `plataforma`,
  `arquitetura`, `tipo`, `arquivo`, `url`, `tamanho`, `sha256` e `recomendado` (NSIS, AppImage e
  DMG).
- **`SHA256SUMS`** — de todos os arquivos, no formato do `sha256sum -c`.

Os nomes `latest.json`, `instaladores.json` e `INSTALACAO.md` na raiz de `/downloads/` são
contrato com a página de download e com os apps já instalados: não mudam.

## Publicação no host

`deploy/publicar-desktop.sh [desktop-v<versão>]` roda no host (onde o `gh` está autenticado):
baixa o release para uma pasta temporária dentro de `/srv/eclume/downloads`, confere o
`SHA256SUMS` e a versão do `latest.json`, move para `/srv/eclume/downloads/<versão>/` e só então
troca `latest.json`, `instaladores.json` e `INSTALACAO.md` da raiz (cópia + `mv`, atômico). Não
retrocede a raiz para uma versão mais antiga sem `FORCAR=1` e mantém as três versões mais
recentes. O Caddy do eclume serve a pasta em `/downloads/`.

## Início automático

O instalador não registra o início com o computador: o próprio app o registra pelo
`tauri-plugin-autostart` (`desktop-interface.md`, "Início com o computador"). No Windows é a chave
`eclume` em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (por usuário, sem admin); no
Linux, um `.desktop` em `~/.config/autostart` (com `$APPIMAGE` quando o app é um AppImage); no
macOS, um LaunchAgent. A linha de comando registrada leva `--autostart`. Como o app concilia o
registro a cada abertura, um update que troque o caminho do executável o corrige na primeira
abertura seguinte.

## Updater no app

- `desktop/src-tauri/src/updater.rs` checa `<web_url>/downloads/latest.json` 30 s depois de abrir e
  a cada 6 h; o `web_url` é o da config do app, então trocar o endereço do servidor não exige
  release. O `endpoints` do `tauri.conf.json` é só o padrão.
- Só baixa e instala com o app **ocioso** (nem gravando, nem sincronizando) e só reinicia se
  continuar ocioso. No Windows, o instalador roda em modo `passive` e reabre o app. Build de
  depuração não se atualiza.
- O TLS é o do sistema (rustls com `rustls-platform-verifier`): a CA raiz do Caddy instalada no
  cliente vale para o updater. Desde a 0.1.1, a **CA extra** da config do sync (`ca_path`) também
  vale: é somada às do sistema no cliente do updater por `UpdaterBuilder::configure_client` +
  `tls_certs_merge`. Uma CA ilegível só gera aviso no log; a checagem segue com as do sistema.
  Nada de `dangerousAcceptInvalidCerts`.
- `configure_client` expõe o `reqwest` do plugin, que pode mudar num minor: o plugin fica fixado
  em `2.12` e o `reqwest` do app é o mesmo `0.13`, sem features próprias.
- **"Atualizado para X".** Antes do `update.install`, o updater grava em `config.json`
  `pending_update: {version, notes}` (o `body` do `latest.json`). Na abertura, se `last_version`
  difere da versão atual e o `pending_update` é desta versão, a janela mostra o `.alert-success`
  "Atualizado para 0.2.0" com as notas, e sai uma vez a notificação "eclume atualizado para
  0.2.0". `dismiss_update_notice` limpa o `pending_update`. Na primeira instalação (sem
  `last_version`), não há aviso.
- **Prova da atualização ponta a ponta** (Linux, no host): a 0.1.0 publicada roda sob Xvfb
  (`xvfb-run -a dbus-run-session -- ./eclume.AppImage`, com `HOME`/`XDG_*` temporários e
  `SSL_CERT_FILE` = CAs do sistema + `eclume-root.crt`, porque a 0.1.0 só conhece as do sistema e
  o `rustls-native-certs` honra a variável), consulta o `latest.json` de produção aos 30 s, baixa
  o AppImage da versão nova, confere a assinatura minisign, troca o arquivo e reinicia. Feita em
  2026-09-25 com `desktop-v0.1.1` publicada: `versão 0.1.1 disponível` → `rewriting AppImage` →
  `versão 0.1.1 instalada` em ~1 s, o arquivo passou a ter o SHA-256 do AppImage 0.1.1 e o app
  reabriu na versão nova.

## Chave do updater

- A privada e a senha vivem em `/srv/eclume/secrets/tauri-updater.key` e
  `tauri-updater.key.password` no host (`chmod 600`, do uid 1000) e nos secrets
  `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` do workflow. O release no host
  as monta **só leitura** no contêiner do build; elas nunca passam pela estação. **Nunca** no
  repositório.
- A pública fica em `plugins.updater.pubkey` do `tauri.conf.json`.
- Trocar a chave invalida a atualização automática de todo cliente instalado: a versão com a
  chave nova precisa ser instalada à mão.
