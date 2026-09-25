---
type: standard
title: Distribuição do app desktop
description: Como o app desktop do eclume vira instaladores e se atualiza — versão no tauri.conf.json, tag desktop-v<versão>, workflow desktop-release com matriz Windows/Linux/macOS universal, pacotes do updater assinados com a chave minisign própria, latest.json e instaladores.json com URLs do servidor eclume e publicação em /srv/eclume/downloads pelo deploy/publicar-desktop.sh.
resource: desktop/src-tauri/tauri.conf.json, desktop/src-tauri/icons/**, desktop/src-tauri/Info.plist, desktop/src-tauri/src/updater.rs, desktop/scripts/**, desktop/INSTALACAO.md, .github/workflows/desktop-release.yml, deploy/publicar-desktop.sh
tags: [code, desktop, release, updater, tauri, ci, instaladores]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#16
maintainer: holetz
---

# Distribuição do app desktop

O app desktop sai em instaladores para Windows, Linux e macOS **sem assinatura de código** (não
há certificado) e se atualiza sozinho pelo updater do Tauri, cujo pacote é assinado com uma
**chave minisign própria**. Como o repositório é privado, os clientes nunca baixam do GitHub:
baixam do próprio servidor eclume, em `https://192.168.15.199:8443/downloads/`.

```
tag desktop-v0.1.0 ──► desktop-release.yml ──► GitHub Release (privado)
                        │ build Windows / Linux / macOS universal     │
                        │ assina os pacotes do updater (.sig)         │ gh release download
                        └ latest.json, instaladores.json, SHA256SUMS  ▼
                                               deploy/publicar-desktop.sh (no host)
                                                              │
                                   /srv/eclume/downloads/ ◄───┘ ──► Caddy /downloads/ ──► app e página
```

## Versão e tag

- A versão publicada é o campo `version` de `desktop/src-tauri/tauri.conf.json`. O `version` do
  workspace cargo (`desktop/Cargo.toml`) acompanha por convenção, mas o release não o lê.
- A tag é `desktop-v<versão>`. O workflow **recusa** uma tag que não bate com o `tauri.conf.json`.
- Lançar uma versão: subir o `version`, fazer merge em `main` e
  `git tag -a desktop-v<versão> -m "eclume desktop <versão>" && git push origin desktop-v<versão>`.

## Workflow `desktop-release.yml`

- Dispara **só** por tag `desktop-v*` ou `workflow_dispatch`, nunca em PR/push: com o repo
  privado, o minuto de macOS custa 10× e o de Windows 2×. No dispatch, `publicar: false` (padrão)
  é ensaio — os artefatos ficam no run — e `macos: false` pula o job mais caro.
- A CLI do Tauri roda por `npx @tauri-apps/cli@2 build --ci --bundles <lista>`, sem
  `tauri-action`: o `latest.json` dela apontaria para URLs privadas do GitHub.

| Job | Runner | Saída |
|---|---|---|
| Windows | `windows-latest` | `eclume_<v>_x64-setup.exe` (NSIS, por usuário, sem admin) e `eclume_<v>_x64_pt-BR.msi` (WiX), com `.sig` |
| Linux | `ubuntu-24.04` (o `libspa` do crate `pipewire` não compila com o PipeWire 0.3.48 do 22.04; o AppImage exige glibc 2.39+) | `eclume_<v>_amd64.AppImage` e `eclume_<v>_amd64.deb`, com `.sig` |
| macOS | `macos-latest`, `--target universal-apple-darwin` | `eclume_<v>_universal.dmg` e `eclume_<v>_universal.app.tar.gz` (+ `.sig`), um só para Intel e Apple Silicon |

- O AppImage é gerado com `APPIMAGE_EXTRACT_AND_RUN=1` (sem FUSE no runner) e `NO_STRIP=true`
  (o `strip` do linuxdeploy falha em binários com `.relr.dyn`).
- O job `release` junta os artefatos, copia `desktop/INSTALACAO.md`, roda
  `desktop/scripts/manifestos_release.py` e cria o GitHub Release `desktop-v<versão>` com tudo.

## Bundle

- `bundle.createUpdaterArtifacts: true` assina cada pacote com `TAURI_SIGNING_PRIVATE_KEY` e
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (secrets do GitHub).
- O `.deb` declara as libs de áudio que o binário liga dinamicamente (`libasound2`,
  `libpulse0`, `libpipewire-0.3-0`, com a alternativa `t64` do Ubuntu 24.04); o TLS é rustls,
  sem `libssl`.
- macOS: `minimumSystemVersion` 15.0 (o `cidre` da captura de sistema compila com `macos_15_0`),
  assinatura **ad hoc** (`signingIdentity: "-"`), sem hardened runtime, e o `Info.plist` com
  `NSMicrophoneUsageDescription` e `NSAudioCaptureUsageDescription`, sem os quais o macOS nega o
  microfone e o process tap.
- Os ícones do bundle são gerados de `desktop/src-tauri/icons/icon.svg` por `tauri icon`, e só
  entram os que o `bundle.icon` lista; os `tray-*.png` da bandeja são à parte.

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

## Updater no app

- `desktop/src-tauri/src/updater.rs` checa `<web_url>/downloads/latest.json` 30 s depois de abrir e
  a cada 6 h; o `web_url` é o da config do app, então trocar o endereço do servidor não exige
  release. O `endpoints` do `tauri.conf.json` é só o padrão.
- Só baixa e instala com o app **ocioso** (nem gravando, nem sincronizando) e só reinicia se
  continuar ocioso. No Windows, o instalador roda em modo `passive` e reabre o app. Build de
  depuração não se atualiza.
- O TLS é o do sistema (rustls com `rustls-platform-verifier`): a CA raiz do Caddy instalada no
  cliente vale para o updater. Nada de `dangerousAcceptInvalidCerts`.

## Chave do updater

- A privada e a senha vivem nos secrets `TAURI_SIGNING_PRIVATE_KEY` e
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` e, como cópia de segurança, em
  `/srv/eclume/secrets/tauri-updater.key` e `tauri-updater.key.password` no host (`chmod 600`).
  **Nunca** no repositório.
- A pública fica em `plugins.updater.pubkey` do `tauri.conf.json`.
- Trocar a chave invalida a atualização automática de todo cliente instalado: a versão com a
  chave nova precisa ser instalada à mão.
