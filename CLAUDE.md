# CLAUDE.md — eclume

Language: pt-BR — the contract is /docs/standards/agents/communication.md

Serviço de transcrição institucional e auto-hospedado. Este arquivo é o ponteiro operacional
carregado pelo Claude; o conhecimento durável vive em `docs/`.

## Operating this repo

Monorepo com um pilar por pasta de topo; o layout e o porquê de cada comando estão em
[docs/standards/code/monorepo.md](docs/standards/code/monorepo.md). O ambiente Python é gerido
por `uv`; use sempre `uv run` para comandos Python.

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
cargo check --manifest-path desktop/Cargo.toml --workspace
cargo clippy --manifest-path desktop/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path desktop/Cargo.toml --workspace
docker compose -f deploy/docker-compose.dev.yml up -d
cq knowledge validate
```

- A CI (`.github/workflows/ci.yml`) roda os jobs `python`, `contracts`, `web`, `web-browser` e
  `desktop` em Linux a cada PR e push em `main`.
- Mudanças de dependência exigem atualizar `pyproject.toml`/`uv.lock`, `web/package.json`/
  `web/package-lock.json` ou `desktop/**/Cargo.toml`/`desktop/Cargo.lock`, conforme o pilar.
- Destino de hospedagem: `192.168.15.199` (Ubuntu, GTX 1660 Super com 6 GB), acessado por
  `docker --context gpu-host`; runbook em [docs/project/host-setup.md](docs/project/host-setup.md).
  Esta máquina de desenvolvimento não tem GPU: em dev, o ASR roda em CPU ou aponta para o host.

## Where knowledge lives

Conhecimento não vive neste arquivo; vive no bundle OKF em [docs/](docs/index.md). Aponte para a
fonte, sem duplicar sua prosa.

**Resolving a term.** Consulte primeiro o [glossário](docs/glossary.md): `grep -i '<termo>' docs/glossary.md`.

- [docs/standards/](docs/standards/index.md) — contratos e convenções atuais do repositório.
- [docs/concepts/](docs/concepts/index.md) — conceitos genéricos sustentados pelo projeto.
- [docs/vision/](docs/vision/index.md) — direção sem prazo operacional.
- [docs/project/](docs/project/index.md) — manual do repositório: referências de mercado e runbook do host.

O workspace de specs é gerido pelo backend GitHub (`holetz/eclume`); o plano de construção é o
épico `holetz/eclume#1`. Use as skills `quenching:specs:*` para consultar ou conduzir esse ciclo e
`quenching:knowledge:*` para criar, editar ou mover conhecimento.
