---
okf_version: "0.1"
---

# `docs/` — OKF knowledge bundle

eclume's canonical knowledge tree, an **Open Knowledge Format (OKF v0.1)** bundle. Each
**home** has a fixed name and a single purpose. This `index.md` is the bundle's front door (the
only listing with frontmatter, and only `okf_version`). Folder names and frontmatter keys are
canonical in kebab-case English; **the prose follows the repository's language (English)**.

## Homes

* [standards/](standards/index.md) — how **WE** do things (current contracts and conventions), by subject; a rule agreed but not proven lives here as `authority: background`
* [vision/](vision/index.md) — direction by area, with no deadline
* [concepts/](concepts/index.md) — generic knowledge we maintain; includes the [glossary](glossary.md)
* [how-to/](how-to/index.md) — recipes for any installation: self-hosting and developing without a GPU
* [project/](project/index.md) — this repository's manual: market references and the host runbook

## Boundaries

- `standards/` = "how **WE** do things (current)"; a rule agreed but not proven stays as `authority: background`.
- `concepts/` = "what we **understand**" (explanatory, not binding).
- The **task inbox** lives outside this bundle, in the specs workspace managed by Quenching (GitHub backend, `holetz/eclume`). Product direction is in [vision/](vision/index.md); epic `holetz/eclume#1` is the record of the first build.
- Still-empty homes — `catalog/`, `external/`, `tutorials/`, `explanation/` — are installed when the first doc arrives.

**Resolving a term.** Unfamiliar word, acronym or codename? Look it up first in the
[glossary](glossary.md): `grep -i '<term>' docs/glossary.md`.

The full contract (homes, types, conformance) lives in the `references/` of the `quenching` plugin; the
bundle is operated by the `quenching:knowledge:*` commands (`/quenching:knowledge:status` shows the
current state).
