---
type: standard
title: Layout do monorepo e comandos por pilar
description: Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/, workspace cargo em desktop/ e o app móvel em mobile/ (npm e workspace cargo próprio que usa os crates do desktop) — e estes são os comandos de build, lint e teste que a CI, o gate do host e as specs usam.
resource: pyproject.toml, web/package.json, desktop/Cargo.toml, mobile/Cargo.toml, mobile/package.json, .github/workflows/ci.yml, .github/workflows/desktop-plataformas.yml, deploy/pilares.sh, deploy/gate.sh, deploy/gate-host.sh, .githooks/pre-push
tags: [code, monorepo, toolchain, ci, gate]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#2, holetz/eclume#41, holetz/eclume#89
maintainer: holetz
---

# Layout do monorepo e comandos por pilar

O eclume é um monorepo com **um pilar por pasta de topo**, cada um com a própria toolchain. Não há
`packages/`: o nome da pasta é o nome da peça no épico `holetz/eclume#1`.

| Pilar | O que é | Toolchain |
|---|---|---|
| `engines/` | interface de engine de ASR (`eclume_engines`), compartilhada | uv (membro do workspace) |
| `server/` | API (`eclume_server`) | uv (membro do workspace) |
| `worker-gpu/` | worker de ASR (`eclume_worker`) | uv (membro do workspace) |
| `web/` | frontend React + Vite + TS | npm, Node 22 |
| `desktop/` | app Tauri 2 (`desktop/src-tauri`) | cargo (workspace em `desktop/Cargo.toml`) |
| `mobile/` | app móvel Tauri 2 (Android; `mobile/src-tauri`) | npm em `mobile/` e cargo (workspace em `mobile/Cargo.toml`) |
| `contracts/` | OpenAPI v1 e JSON Schema da transcrição | — |
| `deploy/` | compose de dev, de teste e de produção, imagens do server e do web, scripts de deploy e backup ([deploy-producao.md](../../project/deploy-producao.md)) | Docker compose |
| `docs/` | bundle OKF | `cq knowledge` |

## Python — workspace uv

- A raiz `pyproject.toml` é um workspace **virtual** (`[tool.uv] package = false`): declara os
  membros `engines`, `server` e `worker-gpu`, o grupo `dev` (ruff, pytest) e a config
  compartilhada de ruff e pytest. Python 3.12 (`.python-version`).
- Cada membro é um pacote hatchling com `src/` layout e testes em `<pilar>/tests/`. `server` e
  `worker-gpu` dependem de `eclume-engines` por `[tool.uv.sources] eclume-engines = { workspace = true }`.
- Uma dependência entra no pacote que a usa, na spec que a usa. Dependência pesada (torch,
  WhisperX, faster-whisper) entra como **extra** (`eclume-engines[whisperx]`/`[cpu]`,
  `eclume-worker[gpu]`/`[cpu]`): o `uv.lock` a resolve, mas `uv sync --all-packages` não a
  instala, e a CI e a máquina de dev seguem sem torch. Só a imagem do worker GPU instala `gpu`.
- O ruff roda com `select = ["ALL"]`; um ignore novo entra com o motivo comentado ao lado.

```bash
uv sync --all-packages
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

### Server (`eclume_server`)

A API e o worker CPU do server; persistência, isolamento, autenticação e upload estão em
[server-nucleo.md](server-nucleo.md). A suíte de `server/tests` usa Postgres, Redis e MinIO reais
do compose de teste; sem ele, esses testes pulam (a CI liga `ECLUME_TEST_REQUIRE_SERVICES=1` para
que pulem nunca).

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email <e-mail> --name "<nome>" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
```

## Web — npm em `web/`

Vite + React + TS, eslint (flat config com typescript-eslint, react-hooks e react-refresh) e
vitest com jsdom e Testing Library. `package-lock.json` é versionado. Os tipos da API saem do
contrato por `gen:api` (`src/api/schema.gen.ts`, versionado); a estrutura do app está em
[frontend-web.md](frontend-web.md).

```bash
npm --prefix web ci
npm --prefix web run gen:api
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
```

Os testes de navegador ficam fora do `npm test`: os da conversão de mídia (vitest browser mode,
Chrome; o porquê e as fixtures estão em [formato-audio-upload.md](formato-audio-upload.md)) e o
E2E Playwright do app contra o mock. Localmente, rodam no host de build; o E2E precisa do mock
no ar, e `ECLUME_MOCK_URL` indica a porta quando a 4010 está ocupada.

```bash
remote-run web 'npx playwright install --with-deps chrome && npm run fixtures && npm run test:browser'
remote-run . 'ECLUME_MOCK_PORT=4110 docker compose -p eclume-mock-web -f deploy/docker-compose.mock.yml up -d --wait && cd web && npx playwright install chromium && ECLUME_MOCK_URL=http://127.0.0.1:4110 npm run test:e2e'
```

## Desktop — workspace cargo em `desktop/`

`desktop/Cargo.toml` é o workspace; o app está em `desktop/src-tauri/` e a UI estática em
`desktop/ui/` (HTML, CSS e JS sem bundler, pela API global do Tauri). Os demais crates do
workspace ficam em `desktop/crates/`: `audio-capture` (mic e áudio do sistema), `recorder`
(mixagem, Ogg/Opus e fila), `resampler`, `detect` (detecção de reuniões) e `sync` (upload por
PAT). O formato da gravação e a fila estão em [desktop-gravacao.md](desktop-gravacao.md); a
detecção e o sync, em [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md).
`tauri::generate_context!` lê `frontendDist` e os ícones em tempo de compilação, então todos são
versionados.

**Código de terceiros vendorizado** entra em `desktop/crates/<crate>` com `VENDOR.md` (origem,
commit fixado, o que foi trazido e o que mudou), o `LICENSE` original e, no topo de cada arquivo
copiado ou adaptado, a linha `fastrepl/anarlog@<sha>:<caminho>`. Atualizar é portar a partir de
um commit novo e trocar o SHA registrado.

No Linux, o build exige `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libxdo-dev`, `libssl-dev` e `build-essential` (Tauri), mais `libasound2-dev` (mic por `cpal`),
`libpipewire-0.3-dev`, `libpulse-dev`, `clang` (bindgen do PipeWire) e `cmake` (libopus embutida).
No host de build, o `cmake` vem de `uv tool install cmake`.

```bash
cargo fmt --manifest-path desktop/Cargo.toml --all --check
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
```

## Móvel — npm e workspace cargo em `mobile/`

O app móvel ([mobile-app.md](mobile-app.md)) é Tauri 2 mobile, Android primeiro:

- **UI:** Vite + React + TS em `mobile/ui/src/`, com o `index.html` na raiz de `mobile/`, a mesma
  toolchain do web (eslint, vitest com jsdom e Testing Library) e a cópia fiel do `styles.css` do
  DS em `ui/src/styles/eclume.css`. O `package-lock.json` é versionado.
- **Rust:** o workspace de `mobile/Cargo.toml` tem `src-tauri` (a lib `eclume_mobile_lib`) e
  `crates/core` (`eclume-mobile-core`, sem Tauri, testável no Linux), e mais tarde o plugin nativo em
  `plugins/`. Os crates de gravação e sync são os de `desktop/crates/`, por **dependência de
  caminho**: mover os crates para uma pasta comum mexeria no desktop sem ganho. O `Cargo.lock` é do
  `mobile/`.
- **Android:** `mobile/src-tauri/gen/android/` é gerado uma vez por `tauri android init` e
  **versionado** (manifesto, gradle e assinatura são código); `build/` e `.gradle/` ficam no
  `.gitignore` dele. O SDK, o NDK e o JDK vivem no host de build
  ([host-setup.md](../../project/host-setup.md#ambiente-android-build-e-emulador-do-app-móvel)), e todo
  comando Android começa com `source ~/.config/eclume/android-env.sh`.

```bash
npm --prefix mobile ci
npm --prefix mobile run lint
npm --prefix mobile test
npm --prefix mobile run build
cargo test --manifest-path mobile/Cargo.toml --workspace
cargo clippy --manifest-path mobile/Cargo.toml --workspace -- -D warnings
remote-run . 'source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64'
```

O APK de depuração x86_64 (o do emulador) sai em
`mobile/src-tauri/gen/android/app/build/outputs/apk/*/debug/`.

O job `mobile` da CI roda a UI (lint, vitest e build), o workspace cargo no Linux (fmt, check,
clippy e testes; o plugin compila no Linux pelo lado sem Android) e um `cargo check` do
`eclume-mobile-core` para `aarch64-linux-android` com o NDK que o runner já traz
(`ANDROID_NDK_LATEST_HOME`), sem o gradle: prova a compilação cruzada do libopus (cmake e ninja) e
do SQLite. O compilador e o linker do NDK entram por `CC_aarch64_linux_android`,
`AR_aarch64_linux_android` e `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`; no host, o
`android-env.sh` os exporta pelo nome, com o `bin` do NDK no fim do `PATH`. Não há
`mobile/.cargo/config.toml`: um `CC` por nome nele valeria também dentro do `tauri android build`,
que não o acha no `PATH` dele. O APK de release sai de `mobile-release.yml`
([mobile-distribuicao.md](mobile-distribuicao.md)).

## Serviços de apoio — `deploy/docker-compose.dev.yml`

Postgres com pgvector (`pgvector/pgvector:pg16`), Redis e MinIO, **toda porta publicada só em
`127.0.0.1`**: o Docker publica por fora do ufw.

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

`deploy/docker-compose.test.yml` sobe os mesmos três serviços para a suíte do server, com dados em
`tmpfs` e portas próprias (`55532`, `56479`, `59100`); rode-o sempre com `-p eclume-test`.

## CI e gate — `deploy/pilares.sh`, `.github/workflows/ci.yml` e `deploy/gate.sh`

Os comandos de prova de cada pilar vivem num só lugar, `deploy/pilares.sh <pilar>`
(`--lista` enumera os sete: `python`, `contracts`, `web`, `web-browser`, `desktop`, `mobile` e
`windows`), com `--locked` no uv e no cargo, `gen:api -- --check` no web e
`CARGO_PROFILE_DEV_DEBUG=line-tables-only` nos pilares cargo (o `Bus error` no link; o dev local
mantém o debuginfo cheio). Quem chama prepara o ambiente — o script não sobe serviço nenhum e lê os
serviços e o mock de `ECLUME_TEST_*` e `ECLUME_MOCK_URL`. A CI e o gate chamam o mesmo script;
`deploy/test_gate.py` falha se um job da CI deixar de chamar o seu pilar ou se `windows` entrar na CI.

**CI (aviso, não requisito de publicação).** Jobs `ubuntu-latest` independentes, em `pull_request`,
em `push` para `main`, à mão e num noturno (`schedule` às 06:00 UTC): `python`, `contracts`, `web`,
`web-browser`, `desktop` e `mobile`, cada um com o seu setup (actions, apt, serviços de
`deploy/docker-compose.test.yml` no `python`, mock no `contracts` e no `web-browser`, dependências do
Chromium no `desktop`) e uma chamada a `bash deploy/pilares.sh <job>`. O `web-browser` usa o Google
Chrome do runner (`E2E_CHANNEL=chrome`); o `python` roda com `ECLUME_TEST_REQUIRE_SERVICES=1`, para
a suíte do server nunca pular; o `desktop` imprime `df -h` e `free -m` antes do cargo.
Com o repositório privado, os minutos de Actions têm cota, então a CI só roda o que mudou: mudança só
de documentação (`docs/`, `.design/`, `.impeccable/`, `.claude/`, os `.md` da raiz) não dispara o
workflow, e o job `mudancas` (`dorny/paths-filter`) liga cada job só quando o pilar dele, ou algo
de que ele depende, foi tocado: o `python` e o `web` também rodam com `contracts/`, o `desktop` com
`web/src/styles/eclume.css`, o `mobile` com `desktop/crates/` e o `python` com `deploy/gate.py`,
`deploy/test_gate.py` e os workflows de release. Mudar o `ci.yml` ou o `deploy/pilares.sh`, ou
disparar o workflow à mão, roda todos os jobs; o noturno também, mas só quando o `main` mudou desde o
último noturno verde. Cada job tem `timeout-minutes`. Ao criar uma dependência nova entre pilares,
acrescente o caminho ao filtro do job que a consome.

**Gate do host (o que libera a publicação).** `bash deploy/gate.sh [<ref>]` envia o `git archive` do
commit para o host GPU e roda lá `deploy/gate-host.sh`: os sete pilares, cada um num contêiner da
imagem `eclume-gate:24.04` (`deploy/gate.Dockerfile`, `--cpus 2`, teto de memória, `nice`, uid
1000, sem socket do Docker nem token do `gh`), contra os serviços e o mock do projeto compose
`eclume-gate` (portas `55632`, `56579`, `59200` e `4210` em `127.0.0.1`, `down -v` ao fim), uma
execução por vez (`flock`) e recusa com o disco em 90%. O resultado vira o status `eclume/gate` no
commit: `pending` enquanto roda, `success` só com os sete pilares verdes numa execução completa,
`failure` nomeando os pilares que falharam e `error` quando o gate não consegue provar; o log fica em
`~/eclume-gate/logs/<sha>.log` no host (`bash deploy/gate.sh --estado <sha>`). `--pilares a,b` roda
uma parte e nunca publica. O pilar `windows` (`cargo xwin clippy` do desktop para
`x86_64-pc-windows-msvc`, `-D warnings`) é só do gate.
Nenhum caminho que publica aceita um SHA sem `eclume/gate` = `success`: `deploy/deploy.sh`,
`deploy/release-desktop.sh --publicar`, `desktop-release.yml` e `mobile-release.yml`. A saída de
emergência é `--sem-gate "<motivo>"`, por invocação, no `deploy.sh` e no `release-desktop.sh`:
dispensa só o status (árvore limpa e commit no GitHub seguem exigidos) e deixa no commit o status
`eclume/gate-dispensa` = `failure` com o motivo. Os workflows de release não têm dispensa.

**Hook de pre-push.** `.githooks/pre-push`, ativado uma vez por clone com
`git config core.hooksPath .githooks`, dispara `bash deploy/gate.sh --fundo <sha>` para cada
atualização de `refs/heads/main` do push: o gate roda no host em segundo plano e o push nunca espera
nem falha por ele (host fora do alcance vira aviso). Ramos de trabalho rodam o gate à mão.

macOS e Windows ficam fora da CI de PR enquanto o repositório for privado; o código só-Windows do
desktop compila a cada gate (pilar `windows`), e o workflow manual
`.github/workflows/desktop-plataformas.yml` faz `cargo check` do desktop num Windows de verdade sob
demanda (`gh workflow run desktop-plataformas.yml`); o macOS fica fora até o repositório ficar
público. Os instaladores do desktop saem do host, por `deploy/release-desktop.sh`, sem gastar minutos
de Actions; o `.github/workflows/desktop-release.yml` é a alternativa, só à mão. O processo está em
[desktop-distribuicao.md](desktop-distribuicao.md).
