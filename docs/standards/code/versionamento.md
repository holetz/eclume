---
type: standard
title: Versioning and CHANGELOG
description: The three SemVer version lines of eclume — the product (server, GPU worker, engines and web, which go up in the same deploy), the desktop app and the phone app — with the contract on its own line; where each version lives and the deploy/version.py that moves them together and checks them; when each line goes up (MAJOR, MINOR, PATCH and the 0.x rule); the Keep a Changelog format in pt-BR with the Para quem hospeda (For self-hosters) block; the app release notes taken from the CHANGELOG; the v<versão> tag on the first deploy; and what each spec's conclude attaches to the merge.
resource: deploy/version.py, deploy/test_version.py, CHANGELOG.md, desktop/CHANGELOG.md, mobile/CHANGELOG.md, deploy/deploy.sh, deploy/release-desktop.sh, deploy/release-mobile.sh, .github/workflows/desktop-release.yml
tags: [code, versao, changelog, release, deploy, semver]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#128
maintainer: holetz
---

# Versioning and CHANGELOG

eclume has **three version lines**, because it has three delivery channels. The **product** — server,
GPU worker, engines and web — goes up whole in one deploy (`deploy/deploy.sh`), so it is a single version. The
**desktop app** and the **phone app** have their own updater, release and tag and talk to servers of
different versions through the contract, so they follow their own line. The **contract** (`info.version` of
v1) follows its own line, with the rule of [contrato-v1.md](../api/contrato-v1.md); each product
entry cites the contract version it carries.

One version for everything would make each desktop fix bump the server and vice versa; one per pillar
would separate server and web, which never go up separately.

## Where each version lives

| Line | Fields (move together) | CHANGELOG | Tag |
|---|---|---|---|
| `product` | `version` of `server/`, `engines/` and `worker-gpu/pyproject.toml`; `web/package.json`; `web/package-lock.json` (root and `packages[""]`); the three members in `uv.lock` | `CHANGELOG.md` | `v<versão>`, on the first deploy |
| `desktop` | `desktop/src-tauri/tauri.conf.json`; `[workspace.package]` of `desktop/Cargo.toml`; its crates in `desktop/Cargo.lock` and `mobile/Cargo.lock` | `desktop/CHANGELOG.md` | `desktop-v<versão>`, at release ([desktop-distribuicao.md](desktop-distribuicao.md)) |
| `mobile` | `mobile/src-tauri/tauri.conf.json`; `[workspace.package]` of `mobile/Cargo.toml`; its crates in `mobile/Cargo.lock` | `mobile/CHANGELOG.md` | `mobile-v<versão>`, at release ([mobile-distribuicao.md](mobile-distribuicao.md)) |

- The `__version__` of the server, the worker and the engines comes from `importlib.metadata.version(...)`: there
  is no literal to forget. `/health`, `GET /api/v1/server` and the heartbeat's `worker_version`
  read it.
- `python3 deploy/version.py set <linha> <versão>` writes the version into every field of the line,
  by expression and without reformatting the files (the locks included, without network); `current <linha>` reads it.
- `python3 deploy/version.py check` fails when a field diverges, when the current version of a
  line has no section in its CHANGELOG, when the CHANGELOG does not open with `[Unreleased]`, when
  `__version__` becomes a literal again or when a migration of
  `server/src/eclume_server/db/migrations/` is not cited (by name, `NNN_assunto`) in
  `CHANGELOG.md`. `deploy/test_version.py` runs `check` over the real tree, in the `python` pillar.

## When it goes up

SemVer from the point of view of whoever self-hosts and whoever uses the app:

- **MAJOR** — whoever self-hosts must act to avoid breakage (a migration that needs intervention, a variable
  removed or renamed, a cut to `/api/v2`), or an already installed app stops working.
- **MINOR** — a new feature, a new migration, a new variable or a MINOR contract.
- **PATCH** — a fix with no migration nor contract change.
- **While the line is at `0.x`, a breaking change bumps MINOR.**
- A change that does not alter what is delivered (only docs, CI, specs, tests) bumps no version nor gets
  an entry.

## Who bumps: each spec's conclude

Bumping the version and writing the entry belongs to the spec's **conclude**, in the same merge as the code, never to a
task in `## Tasks`: as a task, the number would be decided before the work existed, and two branches
would go from the same number to the same number. The conclude reads the spec's whole diff and, for each line
it changes in what is delivered:

1. Decides the level by the section above.
2. If the line's current version **has already been published** (its tag exists; for the product, also 0.1.0,
   in production before the tags), runs `deploy/version.py set <linha> <próxima>` and opens the section of the
   new version, with the merge date. If it **has not been published yet**, the entry goes to the section of the
   current version, which only goes up again if the level asks for more (a breaking change in a PATCH version not yet
   published, for example).
3. Writes the entries and, for the product, the Para quem hospeda (For self-hosters) block.
4. Runs `uv run pytest deploy/test_version.py`.

Specs merged in parallel choose the number **inside the merge lock**, looking at an updated `main`,
like the migrations and `info.version`.

`## [Unreleased]` stays at the top of every CHANGELOG so nothing gets lost between merges: it holds what
went in without a number (the product's backlog before this standard, holetz/eclume#89 to #130). The conclude that
cuts the line's next version moves those entries into its section. While the product's `[Unreleased]`
has entries, the deploy does not create the tag.

## CHANGELOG format

[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) in pt-BR:

- One section per version, the newest on top, `## [X.Y.Z] - AAAA-MM-DD` (the date of the merge that cut the
  version); below `## [Unreleased]`.
- Groups `### Adicionado`, `### Mudado`, `### Corrigido` and `### Removido`, only those that have an
  entry; each entry states the effect for the user, in one sentence, and cites the spec (`holetz/eclume#N`) in the
  product.
- In the product, **`### Para quem hospeda`**, mandatory when there is a new migration or variable:
  - the **migrations** that run, by name; the **destructive** one is marked and asks for the backup first
    ([deploy-producao.md](../../project/deploy-producao.md));
  - the new, changed or removed **environment variables**, and whether the deploy generates them or refuses without
    them;
  - the **contract version** the version carries;
  - the **compatible app versions**.
- In the apps, the entries speak to whoever uses the app: the version's section is the release note.

## App release notes

The notes of `latest.json` (desktop) and of `movel.json` (phone) are the version's section in the line's
CHANGELOG, read by `python3 deploy/version.py notas <linha> <versão>` in `deploy/release-desktop.sh`, in the
`desktop-release` workflow and in `deploy/release-mobile.sh`. It is the text the desktop shows in the
"Atualizado para X" (Updated to X) notice and the phone in "Nova versão disponível" (New version available). An explicit `--notes` still wins;
without it, a version with no section (or with an empty section) refuses the release.

## Tag on deploy

`deploy/deploy.sh` reads the product version in the tree of the target commit and shows it in `--plan`. The
first deploy of a version, after the gate and the check of `/health` and the descriptor, creates the
annotated tag `v<versão>` on the published SHA and pushes it to `origin`. It does not create it on `--rollback`, when the tag
already exists nor with entries in `[Unreleased]`; a failure to create or push the tag only warns, because the
deploy is already live.

## What the conclude attaches to the merge

- The version of each line the spec changes in what is delivered, per the section "Who bumps", with the entry in the
  line's CHANGELOG.
- For the product, the Para quem hospeda (For self-hosters) block with the new migrations, the variables and `info.version`.
- `deploy/test_version.py` green.
