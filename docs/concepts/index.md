# `concepts/` — generic knowledge we maintain

The team's **cross-cutting understanding** — domain concepts (transcription, diarization, voice
fingerprint), mental models and lessons that inform the work without being a contract. Every doc
has `type: concept`.

**Boundary:**

- vs. [standards/](../standards/index.md) — if it binds how code is written, it is a standard; here
  is what we **understand** (explanatory, not binding).
- vs. **external/** — facts about an asset **we consume** (WhisperX, pyannote, Tauri) go to
  `external/` once that home is installed; the generic understanding stays here.
- vs. [vision/](../vision/index.md) — vision is future **direction**; here is present understanding.

## Subjects

* [arquitetura/](arquitetura/index.md) — how eclume is put together: components, queues, the path of a recording, trust boundaries and what can leave the server

## Fixed doc

* [Glossary](../glossary.md) — the A–Z lookup of the repository's terms. **Resolve any unfamiliar
  term here first** (`grep -i '<term>' docs/glossary.md`).
