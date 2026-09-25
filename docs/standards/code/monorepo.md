---
type: standard
title: Layout do monorepo e comandos por pilar
description: Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/ e workspace cargo em desktop/ — e estes são os comandos de build, lint e teste que a CI e as specs usam.
resource: pyproject.toml, web/package.json, desktop/Cargo.toml, .github/workflows/ci.yml, .github/workflows/desktop-plataformas.yml
tags: [code, monorepo, toolchain, ci]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#2
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
| `contracts/` | OpenAPI v1 e JSON Schema da transcrição | — |
| `deploy/` | compose de dev e, depois, de produção | Docker compose |
| `docs/` | bundle OKF | `cq knowledge` |

## Python — workspace uv

- A raiz `pyproject.toml` é um workspace **virtual** (`[tool.uv] package = false`): declara os
  membros `engines`, `server` e `worker-gpu`, o grupo `dev` (ruff, pytest) e a config
  compartilhada de ruff e pytest. Python 3.12 (`.python-version`).
- Cada membro é um pacote hatchling com `src/` layout e testes em `<pilar>/tests/`. `server` e
  `worker-gpu` dependem de `eclume-engines` por `[tool.uv.sources] eclume-engines = { workspace = true }`.
- Uma dependência entra no pacote que a usa, na spec que a usa: o `uv.lock` não carrega torch nem
  WhisperX antes da spec `engine-asr-whisperx`.
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
uv run eclume-server admin bootstrap --org "<organização>" --email <e-mail> --name "<nome>" --password-stdin
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
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
```

## Serviços de apoio — `deploy/docker-compose.dev.yml`

Postgres com pgvector (`pgvector/pgvector:pg16`), Redis e MinIO, **toda porta publicada só em
`127.0.0.1`**: o Docker publica por fora do ufw.

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

`deploy/docker-compose.test.yml` sobe os mesmos três serviços para a suíte do server, com dados em
`tmpfs` e portas próprias (`55532`, `56479`, `59100`); rode-o sempre com `-p eclume-test`.

## CI — `.github/workflows/ci.yml`

Jobs `ubuntu-latest` independentes, em `pull_request` e em `push` para `main`: `python`,
`contracts`, `web` e `desktop`, cada um rodando os comandos acima (com `--locked` no uv e no
cargo; `gen:api -- --check` no web), e `web-browser`, que roda os testes de navegador da conversão
e o E2E contra o mock no Google Chrome do runner (`E2E_CHANNEL=chrome`).
O job `python` sobe antes os serviços de `deploy/docker-compose.test.yml` e roda o pytest com
`ECLUME_TEST_REQUIRE_SERVICES=1`, para que a suíte do server nunca pule na CI.
macOS e Windows ficam fora da CI de PR enquanto o repositório for privado; o workflow manual
`.github/workflows/desktop-plataformas.yml` faz `cargo check` do desktop nas duas plataformas sob
demanda (`gh workflow run desktop-plataformas.yml`). Os instaladores do desktop saem de
`.github/workflows/desktop-release.yml`, só por tag `desktop-v<versão>` ou à mão; o processo está
em [desktop-distribuicao.md](desktop-distribuicao.md).
