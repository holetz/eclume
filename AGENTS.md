# AGENTS.md — eclume

Language: en — the contract is /docs/standards/agents/communication.md

Self-hosted institutional transcription service. This file is the operational pointer agents
load; durable knowledge lives in `docs/`.

## Operating this repo

Monorepo with one pillar per top-level folder; the layout and the reason for each command are in
[docs/standards/code/monorepo.md](docs/standards/code/monorepo.md). The Python environment is
managed by `uv`; always use `uv run` for Python commands.

```bash
uv sync --all-packages
uv run pytest
uv run ruff check .
uv run ruff format --check .
npm --prefix web ci
npm --prefix web run gen:api
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
npm --prefix web run test:e2e
cargo fmt --manifest-path desktop/Cargo.toml --all --check
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
docker compose -f deploy/docker-compose.dev.yml up -d
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
uv run arq eclume_server.worker.AgentWorkerSettings
git config core.hooksPath .githooks
bash deploy/gate.sh
bash deploy/gate.sh --estado
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
cq knowledge validate
```

- CI (`.github/workflows/ci.yml`) runs the `python`, `contracts`, `web`, `web-browser`, `desktop`
  and `mobile` jobs on Linux for every PR and every push to `main`, each through `deploy/pilares.sh`.
- The host gate (`bash deploy/gate.sh`, status `eclume/gate`) runs the same pillars plus `windows`
  and is what clears deploys and releases; the pre-push hook fires it on every push to `main`.
- Rust/Tauri never builds on this workstation: the `desktop`, `mobile`, `android` and `windows`
  pillars run on the host gate (or in CI).
- Dependency changes require updating `pyproject.toml`/`uv.lock`, `web/package.json`/
  `web/package-lock.json` or `desktop/**/Cargo.toml`/`desktop/Cargo.lock`, per pillar.
- Hosting target: `192.168.15.199` (Ubuntu, GTX 1660 Super with 6 GB), reached through
  `docker --context gpu-host`; runbook in [docs/project/host-setup.md](docs/project/host-setup.md).
  Production at `https://192.168.15.199:8443` (project `eclume`); deploy, secrets and backup in
  [docs/project/deploy-producao.md](docs/project/deploy-producao.md).
  This development machine has no GPU: in dev, ASR runs on CPU or points at the host.
- The repository is being prepared for its open-source release (epic in the specs workspace):
  much of the existing prose, code and UI is still pt-BR while that work translates it. Author
  every new artifact — doc, comment, identifier, commit, PR, spec — in English.

## Where knowledge lives

Knowledge does not live in this file; it lives in the OKF bundle under [docs/](docs/index.md).
Point to the source instead of duplicating its prose.

**Resolving a term.** Check the [glossary](docs/glossary.md) first: `grep -i '<term>' docs/glossary.md`.

- [docs/standards/](docs/standards/index.md) — the repository's current contracts and conventions.
- [docs/concepts/](docs/concepts/index.md) — generic concepts the project relies on.
- [docs/vision/](docs/vision/index.md) — direction with no operational deadline.
- [docs/project/](docs/project/index.md) — the repository's manual: market references and the host runbook.

The specs workspace is managed by the GitHub backend (`holetz/eclume`); product direction is in
`docs/vision/`, and epic `holetz/eclume#1` records the first build. Use the `quenching-specs:specs:*`
skills to query or drive that cycle and `quenching-align:knowledge:*` to create, edit or move knowledge.
