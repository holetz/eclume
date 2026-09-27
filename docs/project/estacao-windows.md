---
type: project
title: Estação de desenvolvimento e teste no Windows
description: Como preparar uma máquina Windows para operar o host GPU e testar o app desktop do eclume — chave SSH, contexto Docker gpu-host, remote-run sem rsync, CA e PAT no app, depuração pela janela via CDP do WebView2, log do app e build cruzado de binários Windows no host com cargo xwin.
resource: desktop/**, deploy/**
tags: [windows, estacao, desktop, runbook, cross-build]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#28, holetz/eclume#34
maintainer: holetz
---

# Estação de desenvolvimento e teste no Windows

A estação Windows opera o host `192.168.15.199` ([host-setup.md](host-setup.md)) e testa o app
desktop instalado de verdade. Ela **não tem Rust nem MSVC**: cargo, npm e as imagens rodam no
host. Os comandos abaixo rodam no Git Bash, salvo quando indicado.

## 1. SSH e contexto Docker

```bash
ssh-keygen -t ed25519 -N "" -C "<estacao>" -f ~/.ssh/id_ed25519
cat >> ~/.ssh/config <<'EOF'
Host gpu-host 192.168.15.199
  HostName 192.168.15.199
  User holetz
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
EOF
docker context create gpu-host --docker "host=ssh://holetz@192.168.15.199"
```

Autorizar a chave pede a senha do `holetz`, uma vez só. No PowerShell, porque o Windows não tem
`ssh-copy-id`:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh holetz@192.168.15.199 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Confira com `docker --context gpu-host ps --filter label=com.docker.compose.project=eclume`.

## 2. `remote-run` sem rsync

O Git Bash não traz `rsync`. A versão da estação, em `~/.local/bin/remote-run`, empacota o
diretório com `tar` (sem `.git`, `target/`, `node_modules/`, `.venv/` e `dist/`), extrai por cima
de `~/build/<nome>` no host, que preserva esses caches, e roda o comando com `nice`:

```bash
#!/usr/bin/env bash
set -euo pipefail
dir="${1:?uso: remote-run <dir> '<comando>'}"; cmd="${2:?}"; host="${REMOTE_RUN_HOST:-gpu-host}"
abs="$(cd "$dir" && pwd)"; name="$(basename "$abs")"
tar -C "$abs" --exclude=.git --exclude=target --exclude=node_modules --exclude=.venv --exclude=dist \
  -czf - . | ssh "$host" "mkdir -p ~/build/$name && tar -xzf - -C ~/build/$name"
ssh "$host" "export PATH=\$HOME/.cargo/bin:\$HOME/.local/bin:\$PATH; cd ~/build/$name && nice -n 10 bash -lc $(printf '%q' "$cmd")"
```

Um arquivo apagado na estação continua na cópia do host até um `rm` explícito. Arquivos gerados
lá (um `Cargo.lock`, um `cargo fmt`) voltam por `scp gpu-host:build/<nome>/<arquivo> <local>`.
Exemplos: `remote-run desktop 'cargo test --workspace'`, `remote-run . 'uv run pytest server/tests'`.

A cópia do host não tem `.git`: um `git diff` dentro do `remote-run` sai com 129. Checagens que
dependem do git, como a do cliente gerado (`npm --prefix web run gen:api` seguido de
`git diff --exit-code web/src/api/schema.gen.ts`), rodam na estação. Os testes do web (Vitest com
jsdom) também rodam no host: na estação alguns `findBy` de 1 s estouram o tempo por lentidão do
jsdom no Windows, sem ser regressão.

## 3. App instalado: CA, PAT e log

- **CA.** `curl -k -O https://192.168.15.199:8443/downloads/eclume-root.crt`, confira a impressão
  digital e, num PowerShell **como administrador**, `certutil -addstore -f Root eclume-root.crt`.
  O `curl.exe` do Windows exige `--ssl-no-revoke`, porque a CA interna não publica CRL. Navegadores
  e o app não são afetados. Sem administrador, o app ainda sincroniza e se atualiza apontando a
  **CA extra** (`ca_path`) para o `.crt` nas configurações.
- **Instalar.** `eclume_<versão>_x64-setup.exe /S` instala em silêncio, por usuário, em
  `%LOCALAPPDATA%\eclume`. Config, fila e gravações ficam em
  `%APPDATA%\io.github.holetz.eclume`, e o PAT fica no Gerenciador de Credenciais (alvo
  `pat.eclume-desktop`).
- **Log.** `%LOCALAPPDATA%\io.github.holetz.eclume\logs\eclume.log`
  ([desktop-gravacao.md](../standards/code/desktop-gravacao.md#app-e-bandeja)).

## 4. Dirigir o app sem clicar

O WebView2 abre a porta de depuração quando a variável está no ambiente de quem lança o app:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9229"
Start-Process "$env:LOCALAPPDATA\eclume\eclume-desktop.exe"
```

`http://127.0.0.1:9229/json` lista a janela, e um `Runtime.evaluate` com `awaitPromise` chama os
mesmos comandos que ela chama: `window.__TAURI__.core.invoke('status')`, `'recordings'`,
`'toggle_recording'`, `'save_settings'`, `'answer_meeting'` e `'sync_now'`. Para ter áudio do
sistema numa gravação de teste, toque um WAV com
`(New-Object System.Media.SoundPlayer x.wav).PlaySync()`. A detecção ignora qualquer
executável cujo **nome** contenha "eclume": rode o simulador de reunião com outro nome.

## 5. Binários Windows cruzados no host

Para diagnosticar a captura (WASAPI) sem MSVC na estação, compile no host para
`x86_64-pc-windows-msvc` com o `cargo xwin` e traga o `.exe`:

```bash
remote-run desktop 'cargo xwin build --release --target x86_64-pc-windows-msvc -p eclume-desktop --example gravar'
scp gpu-host:build/desktop/target/x86_64-pc-windows-msvc/release/examples/gravar.exe .
./gravar.exe 12 ./saida    # grava 12 s de mic + sistema e imprime o .ogg
```

O host tem a toolchain instalada no espaço do `holetz`, sem apt: o target `x86_64-pc-windows-msvc`
(`rustup target add`), o `cargo-xwin` (`cargo install --locked cargo-xwin`), o `ninja` e o
`cmake` pelo `uv tool`, e links em `~/.local/bin`: `clang-cl` → `clang-18`, `lld-link` → o
`rust-lld` da toolchain, `llvm-rc` → `llvm-rc-18`, `llvm-mt` → `llvm-mt-18` e `llvm-lib` →
`llvm-lib-18`. O primeiro build baixa o CRT e o SDK da Microsoft para `~/.cache/cargo-xwin`.
Os instaladores oficiais continuam saindo do `desktop-release`
([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)).

## Validação de 2026-09-25 (holetz/eclume#28)

Windows 11, Realtek e grupo de microfones Intel Smart Sound, com o 0.1.1 publicado. Funcionaram:
instalação silenciosa, PAT no chaveiro, sync, detecção de um app no mic com a pergunta, gravação
automática que para 15 s depois de o mic soltar, e o updater de 0.1.0 para 0.1.1 com o app
reaberto. O áudio do sistema chegava mudo ao servidor por um defeito na dívida da mixagem, já
corrigido. O grupo de microfones dessa máquina entrega silêncio digital, e isso é do driver.

Depois da correção (0.1.2, publicada pelo `desktop-release`), o updater levou o app de 0.1.1 para
0.1.2 e o reabriu. Uma gravação manual de 35 s com `duas-vozes.ogg` tocando nos alto-falantes saiu
com 86 KB (antes, 18 KB mudos) e chegou ao servidor transcrita com 13 segmentos e 2 locutores, o
mesmo resultado da fixture enviada direto. O `eclume.log` registrou a abertura, a gravação e o sync.
