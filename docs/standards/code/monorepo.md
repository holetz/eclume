---
type: standard
title: Monorepo layout and commands per pillar
description: Each eclume pillar sits at the root with its own toolchain — uv workspace (server, worker-gpu, engines), npm in web/, cargo workspace in desktop/ and the mobile app in mobile/ (npm and its own cargo workspace that uses the desktop crates) — and these are the build, lint and test commands that CI, the host gate and the specs use.
resource: pyproject.toml, web/package.json, desktop/Cargo.toml, mobile/Cargo.toml, mobile/package.json, .github/workflows/ci.yml, .github/actions/ffmpeg/action.yml, .github/workflows/desktop-plataformas.yml, deploy/pilares.sh, deploy/gate.sh, deploy/gate-host.sh, deploy/pulos.py, web/e2e/flaky-reporter.ts, .githooks/pre-push, .nvmrc, desktop/rust-toolchain.toml, mobile/rust-toolchain.toml, .github/dependabot.yml, deploy/fixacoes.py
tags: [code, monorepo, toolchain, ci, gate]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#2, holetz/eclume#41, holetz/eclume#89, holetz/eclume#90, holetz/eclume#125, holetz/eclume#113, holetz/eclume#130, holetz/eclume#126, holetz/eclume#127
maintainer: holetz
---

# Monorepo layout and commands per pillar

eclume is a monorepo with **one pillar per top-level folder**, each with its own toolchain. There is
no `packages/`: the folder name is the name of the piece in the epic `holetz/eclume#1`.

**The build host is an option, not a requirement.** `remote-run <dir> '<comando>'` syncs the checkout
to the project's build host and runs the command there, to spare a weak workstation. Every
`remote-run` in this standard has its local equivalent: the same command, run in `<dir>` of the checkout
(with the Chrome, Docker or Android SDK it asks for installed). The full path without a GPU and without
the host, with the table of equivalents, is in
[desenvolver-sem-gpu.md](../../how-to/desenvolver-sem-gpu.md).

| Pillar | What it is | Toolchain |
|---|---|---|
| `engines/` | ASR engine interface (`eclume_engines`), shared | uv (workspace member) |
| `server/` | API (`eclume_server`) | uv (workspace member) |
| `worker-gpu/` | ASR worker (`eclume_worker`) | uv (workspace member) |
| `web/` | React + Vite + TS frontend | npm, Node from `.nvmrc` (22) |
| `desktop/` | Tauri 2 app (`desktop/src-tauri`) | cargo (workspace in `desktop/Cargo.toml`) |
| `mobile/` | Tauri 2 mobile app (Android; `mobile/src-tauri`) | npm in `mobile/` and cargo (workspace in `mobile/Cargo.toml`) |
| `contracts/` | OpenAPI v1 and the transcript JSON Schema | — |
| `deploy/` | dev, test and production compose files, server and web images, deploy and backup scripts ([deploy-producao.md](../../project/deploy-producao.md)) | Docker compose |
| `docs/` | OKF bundle | `cq knowledge` |
| `design-system/` | the eclume Design System, exported from Claude Design and versioned: `styles.css` (the source of the three copies of `eclume.css`), components, examples and `sincronizar.py` ([web-design-system.md](web-design-system.md)) | stdlib Python, in `uv run pytest` |

## Python — uv workspace

- The root `pyproject.toml` is a **virtual** workspace (`[tool.uv] package = false`): it declares the
  members `engines`, `server` and `worker-gpu`, the `dev` group (ruff, pytest) and the shared ruff
  and pytest config. Python 3.12 (`.python-version`).
- Each member is a hatchling package with a `src/` layout and tests in `<pilar>/tests/`. `server` and
  `worker-gpu` depend on `eclume-engines` through `[tool.uv.sources] eclume-engines = { workspace = true }`.
- A dependency goes into the package that uses it, in the spec that uses it. A heavy dependency (torch,
  WhisperX, faster-whisper) goes in as an **extra** (`eclume-engines[whisperx]`/`[cpu]`,
  `eclume-worker[gpu]`/`[cpu]`): `uv.lock` resolves it, but `uv sync --all-packages` does not
  install it, and CI and the dev machine stay without torch. Only the GPU worker image installs `gpu`.
- ruff runs with `select = ["ALL"]`; a new ignore goes in with its reason commented beside it, and the
  generated projection in `.design/build/` is left out.
- The pytest `testpaths` include `design-system`: `test_sincronizar.py` fails when a copy
  of `eclume.css` diverges from the source.

```bash
uv sync --all-packages
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

### Server (`eclume_server`)

The server's API and CPU worker; persistence, isolation, authentication and upload are in
[server-nucleo.md](server-nucleo.md). The `server/tests` suite uses real Postgres, Redis and MinIO
from the test compose; without it, those tests skip (CI sets `ECLUME_TEST_REQUIRE_SERVICES=1` so
they never skip).

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email <e-mail> --name "<nome>" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
uv run arq eclume_server.worker.AgentWorkerSettings
```

## Web — npm in `web/`

Vite + React + TS, eslint (flat config with typescript-eslint, react-hooks and react-refresh) and
vitest with jsdom and Testing Library. `package-lock.json` is versioned. The API types come out of the
contract through `gen:api` (`src/api/schema.gen.ts`, versioned); the app structure is in
[frontend-web.md](frontend-web.md).

```bash
npm --prefix web ci
npm --prefix web run gen:api
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
npm --prefix web run budget
```

`budget` runs after the build: the initial JS of `dist/index.html` does not exceed the gzip ceiling of
`web/bundle-budget.json`. `build` also generates the API reference (`dist/referencia-api.html` and
`dist/referencia-api/`) from `contracts/openapi-v1.bundled.yaml`, through `web/scripts/referencia-api.mjs`
([contrato-v1.md](../api/contrato-v1.md#browsable-reference)); it is a separate page, outside
`index.html` and the budget. That is why the build context of the edge image with the web (`deploy/web.Dockerfile` and the
`.dockerignore` beside it) includes the bundle, besides `contracts/fixtures/`. The browser tests stay out of `npm test`: the media conversion
and long transcript ones (vitest browser mode in Google Chrome, Firefox and WebKit; the why and the
fixtures are in [formato-audio-upload.md](formato-audio-upload.md)) and the app's Playwright E2E
against the mock (every scenario in Chromium, the `@smoke` smoke in WebKit and Firefox). They run on the build host or locally, with the same command without `remote-run` (in the checkout, in
`web/` or at the root); the E2E needs the mock
up, and `ECLUME_MOCK_URL` names the port when 4010 is taken.

```bash
remote-run web 'npx playwright install webkit firefox && npm run fixtures && npm run test:browser'
remote-run . 'ECLUME_MOCK_PORT=4110 docker compose -p eclume-mock-web -f deploy/docker-compose.mock.yml up -d --wait && cd web && npx playwright install chromium && ECLUME_MOCK_URL=http://127.0.0.1:4110 npm run test:e2e'
```

## Desktop — cargo workspace in `desktop/`

`desktop/Cargo.toml` is the workspace; the app is in `desktop/src-tauri/` and the static UI in
`desktop/ui/` (HTML, CSS and JS without a bundler, through Tauri's global API). The other crates of the
workspace live in `desktop/crates/`: `audio-capture` (mic and system audio), `recorder`
(mixing, Ogg/Opus and queue), `resampler`, `detect` (meeting detection) and `sync` (upload by
PAT). The recording format and the queue are in [desktop-gravacao.md](desktop-gravacao.md); the
detection and the sync, in [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md).
`tauri::generate_context!` reads `frontendDist` and the icons at compile time, so all of them are
versioned.

**Vendored third-party code** goes into `desktop/crates/<crate>` with `VENDOR.md` (origin,
pinned commit, what was brought in and what changed), the original `LICENSE` and, at the top of each
copied or adapted file, the line `fastrepl/anarlog@<sha>:<caminho>`. Updating is porting from
a new commit and replacing the recorded SHA.

On Linux, the build requires `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`libxdo-dev`, `libssl-dev` and `build-essential` (Tauri), plus `libasound2-dev` (mic through `cpal`),
`libpipewire-0.3-dev`, `libpulse-dev`, `clang` (PipeWire bindgen) and `cmake` (embedded libopus).
On the build host, `cmake` comes from `uv tool install cmake`.

```bash
cargo fmt --manifest-path desktop/Cargo.toml --all --check
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
```

## Mobile — npm and cargo workspace in `mobile/`

The mobile app ([mobile-app.md](mobile-app.md)) is Tauri 2 mobile, Android first:

- **UI:** Vite + React + TS in `mobile/ui/src/`, with `index.html` at the root of `mobile/`, the same
  toolchain as the web (eslint, vitest with jsdom and Testing Library) and the faithful copy of the
  DS `styles.css` in `ui/src/styles/eclume.css`. The `package-lock.json` is versioned.
- **Rust:** the `mobile/Cargo.toml` workspace has `src-tauri` (the `eclume_mobile_lib` lib) and
  `crates/core` (`eclume-mobile-core`, without Tauri, testable on Linux), and later the native plugin in
  `plugins/`. The recording and sync crates are those of `desktop/crates/`, through a **path
  dependency**: moving the crates to a common folder would touch the desktop for no gain. The `Cargo.lock` belongs to
  `mobile/`.
- **Android:** `mobile/src-tauri/gen/android/` is generated once by `tauri android init` and
  **versioned** (manifest, gradle and signing are code); `build/` and `.gradle/` stay in
  its `.gitignore`. The SDK, the NDK and the JDK live on the build host
  ([host-setup.md](../../project/host-setup.md#android-environment-build-and-emulator-for-the-mobile-app)), and every
  Android command starts with `source ~/.config/eclume/android-env.sh`.

```bash
npm --prefix mobile ci
npm --prefix mobile run lint
npm --prefix mobile test
npm --prefix mobile run build
cargo test --manifest-path mobile/Cargo.toml --workspace
cargo clippy --manifest-path mobile/Cargo.toml --workspace -- -D warnings
remote-run . 'source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64'
```

The x86_64 debug APK (the emulator's) comes out in
`mobile/src-tauri/gen/android/app/build/outputs/apk/*/debug/`.

The CI `mobile` job runs the UI (lint, vitest and build), the cargo workspace on Linux (fmt, check,
clippy and tests; the plugin compiles on Linux through its non-Android side) and a `cargo check` of
`eclume-mobile-core` for `aarch64-linux-android` with the pinned NDK (`28.2.13676358`, installed by
`sdkmanager` and passed in `ECLUME_ANDROID_NDK`), without gradle: it proves the cross-compilation of libopus (cmake and ninja) and
of SQLite. The NDK compiler and linker come in through `CC_aarch64_linux_android`,
`AR_aarch64_linux_android` and `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`; on the host,
`android-env.sh` exports them by name, with the NDK `bin` at the end of `PATH`. There is no
`mobile/.cargo/config.toml`: a `CC` by name in it would also apply inside `tauri android build`,
which does not find it in its `PATH`. The release APK comes out of the host, through `deploy/release-movel.sh`
([mobile-distribuicao.md](mobile-distribuicao.md)), and is proved at every gate in the `android` pillar.

## Support services — `deploy/docker-compose.dev.yml`

Postgres with pgvector (`pgvector/pgvector:pg16`), Redis and MinIO, **every port published only on
`127.0.0.1`**: Docker publishes outside ufw.

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

`deploy/docker-compose.test.yml` brings up the same three services for the server suite, with data in
`tmpfs` and its own ports (`55532`, `56479`, `59100`); always run it with `-p eclume-test`.

## Toolchains, pins and updates

Each toolchain has one source, and everything that runs the pillar reads it:

- **Rust**: `desktop/rust-toolchain.toml` and `mobile/rust-toolchain.toml`, with the same exact version
  (`channel`), `clippy` and `rustfmt` (and the Android targets on mobile). `rustup` reads the file of the folder
  cargo runs from: `deploy/pilares.sh` enters `desktop/` or `mobile/`, CI runs
  `rustup toolchain install` there, and the build image (`desktop/build.Dockerfile`) installs Rust from the
  file and carries the version in the tag (`eclume-desktop-build:<versão>`, likewise `-windows` and `eclume-gate`).
- **Node**: the major in `.nvmrc` (`node-version-file` in the workflows, `engines.node` in the
  `package.json` files, `node:<major>` by digest in the images).
- **Python**: `.python-version`.
- **Tauri CLI**: exact version in `desktop/package.json` and `mobile/package.json`, with a lockfile;
  no script, workflow or Dockerfile runs `npx --yes`.
- **Actions** by commit SHA with the version comment (`uses: actions/checkout@<sha> # v7.0.1`)
  and `runs-on` with the named image (`ubuntu-24.04`, `windows-2025`), never `*-latest`; the Rust of the
  workflows comes from the runner's `rustup`, without a third-party action.
- **External images** (production, dev, test, e2e, GPU and mock Dockerfiles and compose files) by
  `tag@sha256:`: a new image only reaches the host through a digest change in the repository.
- **NDK** `28.2.13676358`, the one in `mobile/scripts/android-sdk.sh`: CI installs it through `sdkmanager` and
  passes it to the `mobile` pillar in `ECLUME_ANDROID_NDK` (the gate mounts the host's).

`deploy/fixacoes.py` (with `deploy/test_fixacoes.py`) fails if any of these pins regresses and
if a directory with a manifest is left without an entry in `.github/dependabot.yml`.

**Updates.** Dependabot opens weekly PRs, grouped by ecosystem and with a wait
(`cooldown`) of 7 days after publication, for uv, npm (`web`, `mobile`, `desktop`,
`desktop/ui-tests`), cargo (`desktop`, `mobile`), gradle, github-actions, docker, docker-compose and
rust-toolchain; alerts and security updates are on in the repository. A Dependabot PR
only goes in with `eclume/gate` = `success` on its SHA (`bash deploy/gate.sh <ref>`). A major
(Python, Node, Postgres, Tauri) is decided in its own PR.

**Audit.** The gate's `auditoria` pillar runs `pip-audit` over `uv export --locked --all-extras`
(with the extras: the `gpu` of `eclume-worker-gpu` is what the GPU worker image installs, and without it
torch, transformers and nltk stayed out of the audit, holetz/eclume#161),
`npm audit --omit=dev --audit-level=high` in `web`, `mobile` and `desktop` and
`cargo deny --locked check advisories` in `desktop` and `mobile`, with pinned-version tools
in the gate image. An exception only with a reason and a deadline: `deploy/auditoria-excecoes.txt` (Python; once expired,
it stops applying), the `[advisories] ignore` of `desktop/deny.toml` and `mobile/deny.toml` (Rust) and
`overrides` in `package.json` (npm).

## CI and gate — `deploy/pilares.sh`, `.github/workflows/ci.yml` and `deploy/gate.sh`

The proof commands of each pillar live in a single place, `deploy/pilares.sh <pilar>`
(`--lista` lists the eleven: `python`, `contracts`, `web`, `web-browser`, `desktop`, `mobile`,
`docs`, `windows`, `auditoria`, `android` and `gpu-e2e`), with `--locked` on uv and cargo, `gen:api -- --check` and
`budget` after the build in `web`, `playwright install webkit firefox` in `web-browser` and
`CARGO_PROFILE_DEV_DEBUG=line-tables-only` in the cargo pillars (the `Bus error` at link time; local dev
keeps full debuginfo). The caller prepares the environment — the script brings up no service and reads the
services and the mock from `ECLUME_TEST_*` and `ECLUME_MOCK_URL`. CI and the gate call the same script;
`deploy/test_gate.py` fails if a CI job stops calling its pillar or if `windows`,
`auditoria` or `android` enter CI.

`python` also exercises `deploy.sh --voltar`: `deploy/test_deploy_voltar.py` runs the script for
real (`--plan --voltar` and the refusals for an unknown migration and a missing retained image) in a
throwaway repository, with `docker`, `ssh` and `gh` replaced by stubs on `PATH`. Breaking the
`--voltar` branch of the script fails the pillar; the write branch (bringing up the retained trio) stays proved only by
the host smoke test. On Windows the test skips for lack of a POSIX `bash`.

**CI (a warning, not a publication requirement).** Independent `ubuntu-24.04` jobs, on `pull_request`,
on `push` to `main`, by hand and nightly (`schedule` at 06:00 UTC): `python`, `contracts`, `web`,
`web-browser`, `desktop`, `mobile` and `docs`, each with its own setup (actions, apt, services of
`deploy/docker-compose.test.yml` in `python`, mock in `contracts` and `web-browser`, Chromium
dependencies in `desktop`, WebKit and Firefox ones in `web-browser`) and one call to
`bash deploy/pilares.sh <job>`. `web-browser` uses the runner's Google Chrome (`E2E_CHANNEL=chrome`)
and Playwright's WebKit and Firefox, with the system dependencies of `playwright install-deps`
(in the gate, already in `deploy/gate.Dockerfile`); `python` runs with `ECLUME_TEST_REQUIRE_SERVICES=1`, so
the server suite never skips; `desktop` prints `df -h` and `free -m` before cargo.
**ffmpeg in CI.** Jobs that need ffmpeg (`python`, `web-browser`) call the local composite action
`.github/actions/ffmpeg`, never an inline `apt-get install`: it restores the `.deb` set from
`actions/cache` (keyed on the runner image version) and contacts the distro mirror only on a miss,
with its own `timeout-minutes` per step. A slow mirror once ran the `python` job into its 15-minute
ceiling and cancelled it with no test failure; the healthy suite takes about 8 minutes of pytest, so the
ceiling stays and `deploy/test_ci_ffmpeg.py` fails if an inline install returns.

With the repository private, Actions minutes have a quota, so CI only runs what changed: a change only
in `.design/`, `.impeccable/` or `.claude/` does not trigger the workflow, and the `mudancas` job
(`dorny/paths-filter`) turns each job on only when its pillar, or something it depends on, was touched:
a documentation-only change (`docs/`, any `.md`) turns on only `docs`; `python` and `web` also
run with `contracts/`, `python` with `design-system/**` and the three copies of `eclume.css`, `desktop` with `web/src/styles/eclume.css` and the help articles, `mobile` with `desktop/crates/` and `python` with `deploy/**` (a PR that touches only `deploy/` runs
the `test_*.py` there) and the release workflows. `python` covers each folder of the pytest `testpaths`
with a `<prefixo>/**` glob, and `deploy/test_gate.py` fails, naming the folder, if one is left out of the
filter. Changing `ci.yml` or `deploy/pilares.sh`, or
triggering the workflow by hand, runs every job; so does the nightly, but only when `main` changed since the
last green nightly. Each job has `timeout-minutes`. When creating a new dependency between pillars,
add the path to the filter of the job that consumes it.

**Documented skips and flaky tests.** The `python` pillar runs pytest with `--junitxml` and passes the report
to `deploy/pulos.py`, which compares it with the environment's versioned list (`ECLUME_PULOS`: `ci`, the
default, or `gate`): `deploy/pulos-esperados-ci.txt` and `deploy/pulos-esperados-gate.txt`, one line
`arquivo::teste | motivo` per skip. A skip outside the list fails the pillar, and so does a listed skip that stopped
occurring (the list does not rot). In CI the expected skips are the 2 of `test_gpu_e2e.py`
(`gpu-e2e` pillar, S4) and the 3 of `test_agents_real.py`; `ffmpeg` is installed in the job so the 9 preprocessing
tests run. In the gate, only the 2 GPU ones: `gate-host.sh` runs the `python` pillar with
`ECLUME_TEST_CLAUDE=1`, the host's Claude credential (`~/.claude/.credentials.json`) mounted
read-only in `$HOME/.claude/` and the CLI binary read-only in `/usr/local/bin/claude`,
only in that pillar (the smallest reach: no other pillar sees the credential, and it goes into no environment
variable nor log). `test_agents_real` spends quota of the host's token and fails the gate if the service
is down. `web/e2e/flaky-reporter.ts` adds to Playwright's `list` reporter a summary of the
tests that only passed on retry and, in CI, one `::warning::` per test; it is a warning, not a failure.

**Documentation (`docs` pillar).** `cq knowledge validate` (the conformance of the OKF bundle, with the
`cq` of the public repository `holetz/quenching` pinned by SHA — the one of tag 6.14.0 —, through `ARG
QUENCHING_SHA` in `deploy/gate.Dockerfile` and through checkout in the `docs` job; `deploy/test_docs_check.py`
checks that the two references are the same) and `deploy/docs_check.py`, which scans `docs/**/*.md`, the
root `.md` files and the pillars' `README.md`/`INSTALACAO.md`: a relative link (or absolute from the
root) to a file that exists and, with `#`, to a heading that exists (GitHub slug); a backticked path
that starts with a top-level folder exists (`:linha` ignored; wildcard, `<`, `{`, `$`, command and
`node_modules` are left out); and the glossary in alphabetical order ignoring case and accents. A cited
path that deliberately does not exist (generated at run time, from another repository, a hypothetical example)
goes into `EXCECOES`, in the script itself, with the reason; an exception that is no longer needed also
fails. External links are not followed. The pillar also runs `cq design build --check`: the projections
of the design front (`.design/build/`, generated from `.design/tokens.json`) are versioned, with the
exception `!.design/build/` in `.gitignore` and out of ruff, and `--check` flags the drift.

**Host gate (what clears publication).** `bash deploy/gate.sh [<ref>]` sends the `git archive` of the
commit to the GPU host and runs `deploy/gate-host.sh` there: the pillars the diff requires (up to the eleven),
each in a container of the `eclume-gate:<versão do Rust>` image (`deploy/gate.Dockerfile`, `--cpus 3`,
`--cpu-shares 256`, memory ceiling, `nice`, uid 1000, no Docker socket nor `gh` token), against the services and the mock of the compose project
`eclume-gate-<slot>` (ports `55633`, `56580`, `59201` and `4211` plus the slot, on `127.0.0.1`,
`down -v` at the end), and refuses with the disk at 90%. Up to two gates run at once, one per slot
(`flock`); inside a gate, up to two pillars run at once, each from its own copy of the tree, and
`gpu-e2e` runs last under a host-wide GPU lock. The result becomes the `eclume/gate` status on the
commit: `pending` while it runs, `success` only with the required pillars green (the description says which
ran and how many were waived), `failure` naming the pillars that failed and `error` when the
gate cannot prove; the log stays in
`~/eclume-gate/logs/<sha>.log` on the host (`bash deploy/gate.sh --estado <sha>`). `--pilares a,b` runs
a subset and never publishes; `--todos` publishes running all eleven.

**The gate is proportional.** After the lock, the host finds the closest green SHA in the commit's
history (`eclume/gate` = `success`, up to 30 commits back), lists the files that changed since it
(`gh api compare`) and `python3 deploy/gate.py pilares --stdin` returns the pillars required by the path
map of `FILTROS` — the same as the `ci.yml` filters for the seven CI pillars (
`deploy/test_gate.py` fails if they diverge), plus `windows` (the `desktop` paths), `android` (the
`mobile` ones) and `auditoria` (manifests, locks, `deny.toml` and the exceptions). A change in `deploy/`, in
`ci.yml`, in a lock or in a toolchain (`rust-toolchain.toml`, `.nvmrc`, `.python-version`) runs all of them,
and so does having no findable green SHA (first run, rewritten history) or a truncated diff.
Each pillar outside the diff is waived, not missing: the status only becomes `success` with all the
required ones green, and a diff that touches no pillar (only `.design/`, `.claude/`) publishes `success`
with "nenhum pilar exigido" (no pillar required), so the deploy is never left without a status. The waiver holds by
transitivity (each green proved the whole state at that SHA); `--todos` forces the full proof.

**Superseded SHA.** The pre-push hook passes `--superavel`: after the lock, if GitHub's `main`
is already ahead of the SHA (`compare` = `ahead`), the host publishes `eclume/gate` = `error`
"superado por <sha>" (superseded by <sha>) and exits without running; the deploy uses the tip, which has its own gate and whose diff
since the last green covers the abandoned SHA. A gate requested by hand (`bash deploy/gate.sh <ref>`)
is never abandoned, and neither is one whose tip is equal, behind, divergent or unreadable (the push still in progress).
On every run the host prunes logs older than 30 days, build images of another Rust version
(`eclume-gate`, `eclume-desktop-build`, `eclume-desktop-build-windows`, `eclume-mobile-build`) and
abandoned `src-*` trees. The `windows` (`cargo xwin clippy` of the desktop for
`x86_64-pc-windows-msvc`, `-D warnings`), `auditoria` and `android` pillars are gate-only. `android`
receives the SDK, the NDK and the JDK from the host's `mobile/scripts/android-sdk.sh`, read-only
(`ECLUME_ANDROID_SDK`, `ECLUME_ANDROID_NDK`, `ECLUME_ANDROID_JDK`), and the Gradle cache in
`~/eclume-gate/cache/gradle`; it compiles the minified (R8) release APK with a throwaway key
of the run, runs `testDebugUnitTest` and `lintRelease` (with `lint-baseline.xml` and `abortOnError`)
of the plugin and the app and checks the JNI bridge through `mobile/scripts/simbolos_jni.py` (each
`external fun` of `EclumeCore.kt` with its `Java_…` symbol in the `.so`, through the NDK's `llvm-nm`, and the
class with the native methods in the dex, through the SDK's `apkanalyzer`).
**The `gpu-e2e` pillar (gate-only, holetz/eclume#158).** It proves the CUDA path (WhisperX and diarization on the
6 GB GTX 1660, `eclume:gpu` queue, MinIO), which no other pillar touches: staging runs the worker on
CPU. Required by a change in `worker-gpu/**`, `engines/**`, `contracts/transcript.schema.json`,
`deploy/docker-compose.gpu-test.yml`, `deploy/gpu-e2e.sh`, `deploy/pilares.sh` and `ci.yml` (and by
any change in `deploy/`, which runs all of them). It needs the host's docker and GPU, so
`gate-host.sh` runs it on the host, outside the other pillars' container: `deploy/gpu-e2e.sh` brings up the
`eclume-gpu-test` compose (its own ports and volumes; the models of `/srv/eclume/models` are
shared), runs the 2 tests of `worker-gpu/tests/test_gpu_e2e.py` with `ECLUME_GPU_E2E=1` in an
`eclume-gate` container with `--network host`, checks the skips against an empty list
(`deploy/pulos-esperados-gpu-e2e.txt`: a skip is a failure) and tears the compose down with `down -v` on every
path. Before bringing it up, it waits for the GPU to be free (the production worker's `busy`, `gpu_busy` in
`deploy/gpu-lib.sh`, the same as `deploy.sh`'s, and free VRAM above `ECLUME_GPU_E2E_VRAM_MIN_MIB`,
4096) in 30 s loops up to `ECLUME_GPU_E2E_ESPERA` minutes (20); past the limit, it exits **75**
(inconclusive) without bringing anything up and without stopping production, and the gate publishes `error` "sem prova: gpu-e2e
(inconclusivo: GPU ocupada)" (no proof: gpu-e2e (inconclusive: GPU busy)), never `success`: whoever reads `eclume/gate` keeps requiring `success`. Apart
from 75, a non-zero exit is `failure`. The 4096 MiB minimum is the test's peak (3876 MiB) plus
headroom, not an empty host: idle, the host already uses ~0.9 GB with the graphical session and the driver holds
~400 MiB that never show as free, so 5120 MiB would leave the pillar inconclusive whenever the
host's desktop was in use (holetz/eclume#159). The minimum goes up when the test's peak
goes up. The first run downloads models and builds the
worker image (~8 GB, cached afterwards). The pillar does not mount the `~/.claude` credentials.

No path that publishes accepts a SHA without `eclume/gate` = `success`: `deploy/deploy.sh`,
`deploy/release-desktop.sh --publicar`, `deploy/release-movel.sh --publicar` and
`desktop-release.yml`. The emergency exit is `--sem-gate "<motivo>"`, per invocation, in
`deploy.sh`, `release-desktop.sh` and `release-movel.sh`:
it waives only the status (clean tree and commit on GitHub are still required) and leaves on the commit the status
`eclume/gate-dispensa` = `failure` with the reason. The release workflow has no waiver.

**Pre-push hook.** `.githooks/pre-push`, enabled once per clone with
`git config core.hooksPath .githooks`, fires `bash deploy/gate.sh --fundo --superavel <sha>` for each
update of `refs/heads/main` in the push: the gate runs on the host in the background and the push never waits
nor fails because of it (an unreachable host becomes a warning). Work branches run the gate by hand.

macOS and Windows stay out of PR CI while the repository is private; the desktop's Windows-only code
compiles at every gate (`windows` pillar), and the manual workflow
`.github/workflows/desktop-plataformas.yml` runs a `cargo check` of the desktop on a real Windows on
demand (`gh workflow run desktop-plataformas.yml`); macOS stays out until the repository becomes
public. The desktop installers come out of the host, through `deploy/release-desktop.sh`, without spending Actions
minutes; `.github/workflows/desktop-release.yml` is the alternative, by hand only. The process is in
[desktop-distribuicao.md](desktop-distribuicao.md).
