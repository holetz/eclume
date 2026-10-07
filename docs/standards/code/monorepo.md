---
type: standard
title: Layout do monorepo e comandos por pilar
description: Cada pilar do eclume fica na raiz com a própria toolchain — workspace uv (server, worker-gpu, engines), npm em web/, workspace cargo em desktop/ e o app móvel em mobile/ (npm e workspace cargo próprio que usa os crates do desktop) — e estes são os comandos de build, lint e teste que a CI, o gate do host e as specs usam.
resource: pyproject.toml, web/package.json, desktop/Cargo.toml, mobile/Cargo.toml, mobile/package.json, .github/workflows/ci.yml, .github/workflows/desktop-plataformas.yml, deploy/pilares.sh, deploy/gate.sh, deploy/gate-host.sh, deploy/pulos.py, web/e2e/flaky-reporter.ts, .githooks/pre-push, .nvmrc, desktop/rust-toolchain.toml, mobile/rust-toolchain.toml, .github/dependabot.yml, deploy/fixacoes.py
tags: [code, monorepo, toolchain, ci, gate]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#2, holetz/eclume#41, holetz/eclume#89, holetz/eclume#90, holetz/eclume#125, holetz/eclume#113, holetz/eclume#130, holetz/eclume#126, holetz/eclume#127
maintainer: holetz
---

# Layout do monorepo e comandos por pilar

O eclume é um monorepo com **um pilar por pasta de topo**, cada um com a própria toolchain. Não há
`packages/`: o nome da pasta é o nome da peça no épico `holetz/eclume#1`.

**O host de build é opção, não requisito.** `remote-run <dir> '<comando>'` sincroniza o checkout
para o host de build da consultoria e roda o comando lá, para poupar uma estação fraca. Todo
`remote-run` desta norma tem o equivalente local: o mesmo comando, rodado em `<dir>` do checkout
(com o Chrome, o Docker ou o SDK Android que ele pede instalados). O caminho completo sem GPU e sem
o host, com a tabela dos equivalentes, está em
[desenvolver-sem-gpu.md](../../how-to/desenvolver-sem-gpu.md).

| Pilar | O que é | Toolchain |
|---|---|---|
| `engines/` | interface de engine de ASR (`eclume_engines`), compartilhada | uv (membro do workspace) |
| `server/` | API (`eclume_server`) | uv (membro do workspace) |
| `worker-gpu/` | worker de ASR (`eclume_worker`) | uv (membro do workspace) |
| `web/` | frontend React + Vite + TS | npm, Node do `.nvmrc` (22) |
| `desktop/` | app Tauri 2 (`desktop/src-tauri`) | cargo (workspace em `desktop/Cargo.toml`) |
| `mobile/` | app móvel Tauri 2 (Android; `mobile/src-tauri`) | npm em `mobile/` e cargo (workspace em `mobile/Cargo.toml`) |
| `contracts/` | OpenAPI v1 e JSON Schema da transcrição | — |
| `deploy/` | compose de dev, de teste e de produção, imagens do server e do web, scripts de deploy e backup ([deploy-producao.md](../../project/deploy-producao.md)) | Docker compose |
| `docs/` | bundle OKF | `cq knowledge` |
| `design-system/` | o Design System do eclume, exportado do Claude Design e versionado: `styles.css` (a fonte das três cópias do `eclume.css`), componentes, exemplos e `sincronizar.py` ([web-design-system.md](web-design-system.md)) | Python da stdlib, no `uv run pytest` |

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
- O ruff roda com `select = ["ALL"]`; um ignore novo entra com o motivo comentado ao lado, e deixa
  de fora a projeção gerada em `.design/build/`.
- Os `testpaths` do pytest incluem `design-system`: o `test_sincronizar.py` falha quando uma cópia
  do `eclume.css` diverge da fonte.

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
uv run arq eclume_server.worker.AgentWorkerSettings
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
npm --prefix web run budget
```

O `budget` roda depois do build: o JS inicial do `dist/index.html` não passa do teto em gzip de
`web/bundle-budget.json`. O `build` também gera a referência da API (`dist/referencia-api.html` e
`dist/referencia-api/`) do `contracts/openapi-v1.bundled.yaml`, por `web/scripts/referencia-api.mjs`
([contrato-v1.md](../api/contrato-v1.md#referência-navegável)); é página à parte, fora do
`index.html` e do orçamento. Por isso o contexto da imagem da borda com o web (`deploy/web.Dockerfile` e o
`.dockerignore` ao lado) inclui o bundle, além de `contracts/fixtures/`. Os testes de navegador ficam fora do `npm test`: os da conversão de mídia
e da transcrição longa (vitest browser mode no Google Chrome, no Firefox e no WebKit; o porquê e as
fixtures estão em [formato-audio-upload.md](formato-audio-upload.md)) e o E2E Playwright do app
contra o mock (todos os cenários no Chromium, o smoke `@smoke` no WebKit e no Firefox). Rodam no host de build ou localmente, com o mesmo comando sem o `remote-run` (no checkout, em
`web/` ou na raiz); o E2E precisa do mock
no ar, e `ECLUME_MOCK_URL` indica a porta quando a 4010 está ocupada.

```bash
remote-run web 'npx playwright install webkit firefox && npm run fixtures && npm run test:browser'
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
`eclume-mobile-core` para `aarch64-linux-android` com o NDK fixado (`28.2.13676358`, instalado pelo
`sdkmanager` e passado em `ECLUME_ANDROID_NDK`), sem o gradle: prova a compilação cruzada do libopus (cmake e ninja) e
do SQLite. O compilador e o linker do NDK entram por `CC_aarch64_linux_android`,
`AR_aarch64_linux_android` e `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`; no host, o
`android-env.sh` os exporta pelo nome, com o `bin` do NDK no fim do `PATH`. Não há
`mobile/.cargo/config.toml`: um `CC` por nome nele valeria também dentro do `tauri android build`,
que não o acha no `PATH` dele. O APK de release sai do host, por `deploy/release-movel.sh`
([mobile-distribuicao.md](mobile-distribuicao.md)), e é provado a cada gate no pilar `android`.

## Serviços de apoio — `deploy/docker-compose.dev.yml`

Postgres com pgvector (`pgvector/pgvector:pg16`), Redis e MinIO, **toda porta publicada só em
`127.0.0.1`**: o Docker publica por fora do ufw.

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

`deploy/docker-compose.test.yml` sobe os mesmos três serviços para a suíte do server, com dados em
`tmpfs` e portas próprias (`55532`, `56479`, `59100`); rode-o sempre com `-p eclume-test`.

## Toolchains, fixações e atualização

Cada toolchain tem uma fonte, e tudo o que roda o pilar a lê:

- **Rust**: `desktop/rust-toolchain.toml` e `mobile/rust-toolchain.toml`, com a mesma versão exata
  (`channel`), `clippy` e `rustfmt` (e os alvos Android no mobile). O `rustup` lê o arquivo da pasta
  de onde o cargo roda: o `deploy/pilares.sh` entra em `desktop/` ou `mobile/`, a CI roda
  `rustup toolchain install` ali, e a imagem de build (`desktop/build.Dockerfile`) instala o Rust do
  arquivo e leva a versão na tag (`eclume-desktop-build:<versão>`, idem `-windows` e `eclume-gate`).
- **Node**: o major em `.nvmrc` (`node-version-file` nos workflows, `engines.node` nos
  `package.json`, `node:<major>` por digest nas imagens).
- **Python**: `.python-version`.
- **CLI do Tauri**: versão exata em `desktop/package.json` e `mobile/package.json`, com lockfile;
  nenhum script, workflow ou Dockerfile roda `npx --yes`.
- **Actions** por SHA de commit com o comentário da versão (`uses: actions/checkout@<sha> # v7.0.1`)
  e `runs-on` com a imagem nomeada (`ubuntu-24.04`, `windows-2025`), nunca `*-latest`; o Rust dos
  workflows vem do `rustup` do runner, sem action de terceiros.
- **Imagens externas** (Dockerfiles e composes de produção, dev, teste, e2e, GPU e mock) por
  `tag@sha256:`: uma imagem nova só chega ao host por mudança de digest no repositório.
- **NDK** `28.2.13676358`, o de `mobile/scripts/android-sdk.sh`: a CI o instala pelo `sdkmanager` e
  o passa ao pilar `mobile` em `ECLUME_ANDROID_NDK` (o gate monta o do host).

`deploy/fixacoes.py` (com `deploy/test_fixacoes.py`) falha se qualquer dessas fixações regredir e
se um diretório com manifesto ficar sem entrada no `.github/dependabot.yml`.

**Atualização.** O Dependabot abre PRs semanais, agrupados por ecossistema e com espera
(`cooldown`) de 7 dias depois da publicação, para uv, npm (`web`, `mobile`, `desktop`,
`desktop/ui-tests`), cargo (`desktop`, `mobile`), gradle, github-actions, docker, docker-compose e
rust-toolchain; os alertas e as atualizações de segurança estão ligados no repositório. Um PR do
Dependabot só entra com `eclume/gate` = `success` no SHA dele (`bash deploy/gate.sh <ref>`). Major
(Python, Node, Postgres, Tauri) se decide no próprio PR.

**Auditoria.** O pilar `auditoria` do gate roda `pip-audit` sobre o `uv export --locked --all-extras`
(com os extras: o `gpu` do `eclume-worker-gpu` é o que a imagem do worker GPU instala, e sem ele
torch, transformers e nltk ficavam fora da auditoria, holetz/eclume#161),
`npm audit --omit=dev --audit-level=high` em `web`, `mobile` e `desktop` e
`cargo deny --locked check advisories` em `desktop` e `mobile`, com as ferramentas de versão fixada
na imagem do gate. Exceção só com motivo e prazo: `deploy/auditoria-excecoes.txt` (Python; vencida,
deixa de valer), o `[advisories] ignore` de `desktop/deny.toml` e `mobile/deny.toml` (Rust) e
`overrides` no `package.json` (npm).

## CI e gate — `deploy/pilares.sh`, `.github/workflows/ci.yml` e `deploy/gate.sh`

Os comandos de prova de cada pilar vivem num só lugar, `deploy/pilares.sh <pilar>`
(`--lista` enumera os onze: `python`, `contracts`, `web`, `web-browser`, `desktop`, `mobile`,
`docs`, `windows`, `auditoria`, `android` e `gpu-e2e`), com `--locked` no uv e no cargo, `gen:api -- --check` e o
`budget` depois do build no `web`, `playwright install webkit firefox` no `web-browser` e
`CARGO_PROFILE_DEV_DEBUG=line-tables-only` nos pilares cargo (o `Bus error` no link; o dev local
mantém o debuginfo cheio). Quem chama prepara o ambiente — o script não sobe serviço nenhum e lê os
serviços e o mock de `ECLUME_TEST_*` e `ECLUME_MOCK_URL`. A CI e o gate chamam o mesmo script;
`deploy/test_gate.py` falha se um job da CI deixar de chamar o seu pilar ou se `windows`,
`auditoria` ou `android` entrarem na CI.

O `python` também exercita o `deploy.sh --voltar`: `deploy/test_deploy_voltar.py` roda o script de
verdade (`--plan --voltar` e as recusas por migration desconhecida e imagem retida ausente) num
repositório descartável, com `docker`, `ssh` e `gh` trocados por stubs no `PATH`. Quebrar o ramo
`--voltar` do script faz o pilar falhar; o ramo de escrita (subir o trio retido) segue provado só pelo
smoke do host. Em Windows o teste pula por falta de `bash` POSIX.

**CI (aviso, não requisito de publicação).** Jobs `ubuntu-24.04` independentes, em `pull_request`,
em `push` para `main`, à mão e num noturno (`schedule` às 06:00 UTC): `python`, `contracts`, `web`,
`web-browser`, `desktop`, `mobile` e `docs`, cada um com o seu setup (actions, apt, serviços de
`deploy/docker-compose.test.yml` no `python`, mock no `contracts` e no `web-browser`, dependências do
Chromium no `desktop`, do WebKit e do Firefox no `web-browser`) e uma chamada a
`bash deploy/pilares.sh <job>`. O `web-browser` usa o Google Chrome do runner (`E2E_CHANNEL=chrome`)
e o WebKit e o Firefox do Playwright, com as dependências de sistema do `playwright install-deps`
(no gate, já na `deploy/gate.Dockerfile`); o `python` roda com `ECLUME_TEST_REQUIRE_SERVICES=1`, para
a suíte do server nunca pular; o `desktop` imprime `df -h` e `free -m` antes do cargo.
Com o repositório privado, os minutos de Actions têm cota, então a CI só roda o que mudou: mudança só
em `.design/`, `.impeccable/` ou `.claude/` não dispara o workflow, e o job `mudancas`
(`dorny/paths-filter`) liga cada job só quando o pilar dele, ou algo de que ele depende, foi tocado:
mudança só de documentação (`docs/`, qualquer `.md`) liga só o `docs`; o `python` e o `web` também
rodam com `contracts/`, o `python` com `design-system/**` e as três cópias do `eclume.css`, o `desktop` com `web/src/styles/eclume.css` e os artigos de ajuda, o `mobile` com `desktop/crates/` e o `python` com `deploy/**` (um PR que mexa só no `deploy/` roda
os `test_*.py` de lá) e os workflows de release. O `python` cobre cada pasta do `testpaths` do pytest
por um glob `<prefixo>/**`, e o `deploy/test_gate.py` falha, nomeando a pasta, se uma ficar fora do
filtro. Mudar o `ci.yml` ou o `deploy/pilares.sh`, ou
disparar o workflow à mão, roda todos os jobs; o noturno também, mas só quando o `main` mudou desde o
último noturno verde. Cada job tem `timeout-minutes`. Ao criar uma dependência nova entre pilares,
acrescente o caminho ao filtro do job que a consome.

**Pulos documentados e flaky.** O pilar `python` roda o pytest com `--junitxml` e passa o relatório
a `deploy/pulos.py`, que o compara com a lista versionada do ambiente (`ECLUME_PULOS`: `ci`, o
padrão, ou `gate`): `deploy/pulos-esperados-ci.txt` e `deploy/pulos-esperados-gate.txt`, uma linha
`arquivo::teste | motivo` por pulo. Pulo fora da lista falha o pilar, e pulo listado que deixou de
ocorrer também (a lista não apodrece). Na CI os pulos esperados são os 2 de `test_gpu_e2e.py`
(pilar `gpu-e2e`, S4) e os 3 de `test_agents_real.py`; o `ffmpeg` é instalado no job para os 9 testes
de pré-processamento rodarem. No gate, só os 2 de GPU: o `gate-host.sh` roda o pilar `python` com
`ECLUME_TEST_CLAUDE=1`, a credencial do Claude do host (`~/.claude/.credentials.json`) montada
somente leitura em `$HOME/.claude/` e o binário da CLI somente leitura em `/usr/local/bin/claude`,
só nesse pilar (o menor alcance: nenhum outro pilar vê a credencial, e ela não entra em variável de
ambiente nem em log). O `test_agents_real` gasta cota do token do host e falha o gate se o serviço
estiver fora. O `web/e2e/flaky-reporter.ts` soma ao reporter `list` do Playwright um resumo dos
testes que só passaram no retry e, na CI, um `::warning::` por teste; é aviso, não falha.

**Documentação (pilar `docs`).** `cq knowledge validate` (a conformidade do bundle OKF, com o
`cq` do repositório público `holetz/quenching` fixado por SHA — o da tag 6.3.0 —, por `ARG
QUENCHING_SHA` no `deploy/gate.Dockerfile` e por checkout no job `docs`; `deploy/test_docs_check.py`
confere que as duas referências são a mesma) e `deploy/docs_check.py`, que varre `docs/**/*.md`, os
`.md` da raiz e os `README.md`/`INSTALACAO.md` dos pilares: link relativo (ou absoluto a partir da
raiz) para arquivo que existe e, com `#`, para um título que existe (slug do GitHub); caminho em
crase que começa por uma pasta de topo existe (`:linha` ignorado; curinga, `<`, `{`, `$`, comando e
`node_modules` ficam de fora); e o glossário em ordem alfabética sem caixa nem acento. Um caminho
citado que não existe de propósito (gerado em execução, de outro repositório, exemplo hipotético)
entra em `EXCECOES`, no próprio script, com o motivo; a exceção que deixa de ser necessária também
falha. Links para fora não são seguidos. O pilar também roda `cq design build --check`: as projeções
do front de design (`.design/build/`, geradas do `.design/tokens.json`) são versionadas, com a
exceção `!.design/build/` no `.gitignore` e fora do ruff, e o `--check` acusa a deriva.

**Gate do host (o que libera a publicação).** `bash deploy/gate.sh [<ref>]` envia o `git archive` do
commit para o host GPU e roda lá `deploy/gate-host.sh`: os pilares que o diff exige (até os onze),
cada um num contêiner da imagem `eclume-gate:<versão do Rust>` (`deploy/gate.Dockerfile`, `--cpus 2`,
`--cpu-shares 256`, teto de memória, `nice`, uid 1000, sem socket do Docker nem token do `gh`), contra os serviços e o mock do projeto compose
`eclume-gate` (portas `55632`, `56579`, `59200` e `4210` em `127.0.0.1`, `down -v` ao fim), uma
execução por vez (`flock`) e recusa com o disco em 90%. O resultado vira o status `eclume/gate` no
commit: `pending` enquanto roda, `success` só com os pilares exigidos verdes (a descrição diz quais
rodaram e quantos ficaram dispensados), `failure` nomeando os pilares que falharam e `error` quando o
gate não consegue provar; o log fica em
`~/eclume-gate/logs/<sha>.log` no host (`bash deploy/gate.sh --estado <sha>`). `--pilares a,b` roda
uma parte e nunca publica; `--todos` publica rodando os onze.

**O gate é proporcional.** Depois da trava, o host acha o SHA verde mais próximo no histórico do
commit (`eclume/gate` = `success`, até 30 commits atrás), lista os arquivos que mudaram desde ele
(`gh api compare`) e `python3 deploy/gate.py pilares --stdin` devolve os pilares exigidos pelo mapa
de caminhos de `FILTROS` — o mesmo dos filtros do `ci.yml` para os sete pilares da CI (o
`deploy/test_gate.py` falha se divergirem), mais `windows` (os caminhos do `desktop`), `android` (os
do `mobile`) e `auditoria` (manifestos, locks, `deny.toml` e as exceções). Mudança em `deploy/`, no
`ci.yml`, num lock ou numa toolchain (`rust-toolchain.toml`, `.nvmrc`, `.python-version`) roda todos,
e sem SHA verde encontrável (primeira execução, histórico reescrito) ou com o diff truncado também.
Cada pilar fora do diff é dispensado, não faltante: o status só fica `success` com todos os
exigidos verdes, e um diff que não toca pilar nenhum (só `.design/`, `.claude/`) publica `success`
com "nenhum pilar exigido", de modo que o deploy nunca fica sem status. A dispensa vale por
transitividade (cada verde provou o estado inteiro naquele SHA); `--todos` força a prova completa.

**SHA superado.** O hook de pre-push passa `--superavel`: depois da trava, se o `main` do GitHub
já está à frente do SHA (`compare` = `ahead`), o host publica `eclume/gate` = `error`
"superado por <sha>" e sai sem rodar; o deploy usa a ponta, que tem o gate próprio e cujo diff
desde o último verde cobre o SHA abandonado. Um gate pedido à mão (`bash deploy/gate.sh <ref>`)
nunca é abandonado, e ponta igual, atrás, divergente ou ilegível (o push ainda em curso) também não.
A cada execução o host poda logs de mais de 30 dias, imagens de build de outra versão do Rust
(`eclume-gate`, `eclume-desktop-build`, `eclume-desktop-build-windows`, `eclume-mobile-build`) e
árvores `src-*` abandonadas. Os pilares `windows` (`cargo xwin clippy` do desktop para
`x86_64-pc-windows-msvc`, `-D warnings`), `auditoria` e `android` são só do gate. O `android`
recebe o SDK, o NDK e o JDK de `mobile/scripts/android-sdk.sh` do host, só leitura
(`ECLUME_ANDROID_SDK`, `ECLUME_ANDROID_NDK`, `ECLUME_ANDROID_JDK`), e o cache do Gradle em
`~/eclume-gate/cache/gradle`; compila o APK de release minificado (R8) com uma chave descartável
da execução, roda `testDebugUnitTest` e `lintRelease` (com `lint-baseline.xml` e `abortOnError`)
do plugin e do app e confere a ponte JNI por `mobile/scripts/simbolos_jni.py` (cada
`external fun` do `EclumeCore.kt` com o símbolo `Java_…` na `.so`, pelo `llvm-nm` do NDK, e a
classe com os métodos nativos no dex, pelo `apkanalyzer` do SDK).
**O pilar `gpu-e2e` (só do gate, holetz/eclume#158).** Prova o caminho CUDA (WhisperX e diarização na
GTX 1660 de 6 GB, fila `eclume:gpu`, MinIO), que nenhum outro pilar toca: o staging roda o worker em
CPU. Exigido por mudança em `worker-gpu/**`, `engines/**`, `contracts/transcript.schema.json`,
`deploy/docker-compose.gpu-test.yml`, `deploy/gpu-e2e.sh`, `deploy/pilares.sh` e `ci.yml` (e por
qualquer mudança em `deploy/`, que roda todos). Precisa do docker e da GPU do host, então o
`gate-host.sh` o roda no host, fora do contêiner dos outros pilares: `deploy/gpu-e2e.sh` sobe o
compose `eclume-gpu-test` (portas e volumes próprios; os modelos de `/srv/eclume/models` são
compartilhados), roda os 2 testes de `worker-gpu/tests/test_gpu_e2e.py` com `ECLUME_GPU_E2E=1` num
contêiner `eclume-gate` com `--network host`, confere os pulos contra uma lista vazia
(`deploy/pulos-esperados-gpu-e2e.txt`: pulo é falha) e derruba o compose com `down -v` em todos os
caminhos. Antes de subir, espera a GPU livre (o `busy` do worker de produção, `gpu_busy` em
`deploy/gpu-lib.sh`, o mesmo do `deploy.sh`, e VRAM livre acima de `ECLUME_GPU_E2E_VRAM_MIN_MIB`,
4096) em laços de 30 s até `ECLUME_GPU_E2E_ESPERA` minutos (20); passado o limite, sai **75**
(inconclusivo) sem subir nada e sem parar a produção, e o gate publica `error` "sem prova: gpu-e2e
(inconclusivo: GPU ocupada)", nunca `success`: quem lê `eclume/gate` segue exigindo `success`. Fora
o 75, saída diferente de zero é `failure`. O mínimo de 4096 MiB é o pico do teste (3876 MiB) mais
folga, não um host vazio: parado, o host já ocupa ~0,9 GB com a sessão gráfica e o driver retém
~400 MiB que nunca aparecem como livres, então 5120 MiB deixaria o pilar inconclusivo sempre que o
desktop do host estivesse em uso (holetz/eclume#159). O mínimo sobe junto quando o pico do teste
sobe. A primeira execução baixa modelos e constrói a imagem do
worker (~8 GB, em cache depois). O pilar não monta as credenciais do `~/.claude`.

Nenhum caminho que publica aceita um SHA sem `eclume/gate` = `success`: `deploy/deploy.sh`,
`deploy/release-desktop.sh --publicar`, `deploy/release-movel.sh --publicar` e
`desktop-release.yml`. A saída de emergência é `--sem-gate "<motivo>"`, por invocação, no
`deploy.sh`, no `release-desktop.sh` e no `release-movel.sh`:
dispensa só o status (árvore limpa e commit no GitHub seguem exigidos) e deixa no commit o status
`eclume/gate-dispensa` = `failure` com o motivo. O workflow de release não tem dispensa.

**Hook de pre-push.** `.githooks/pre-push`, ativado uma vez por clone com
`git config core.hooksPath .githooks`, dispara `bash deploy/gate.sh --fundo --superavel <sha>` para cada
atualização de `refs/heads/main` do push: o gate roda no host em segundo plano e o push nunca espera
nem falha por ele (host fora do alcance vira aviso). Ramos de trabalho rodam o gate à mão.

macOS e Windows ficam fora da CI de PR enquanto o repositório for privado; o código só-Windows do
desktop compila a cada gate (pilar `windows`), e o workflow manual
`.github/workflows/desktop-plataformas.yml` faz `cargo check` do desktop num Windows de verdade sob
demanda (`gh workflow run desktop-plataformas.yml`); o macOS fica fora até o repositório ficar
público. Os instaladores do desktop saem do host, por `deploy/release-desktop.sh`, sem gastar minutos
de Actions; o `.github/workflows/desktop-release.yml` é a alternativa, só à mão. O processo está em
[desktop-distribuicao.md](desktop-distribuicao.md).
