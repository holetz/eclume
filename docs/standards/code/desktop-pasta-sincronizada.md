---
type: standard
title: Desktop app synced folder
description: The desktop app mirrors the user's library into a local folder — the current summary of each recording in Markdown with front matter and the transcript in JSONL, one subfolder per Collection, an AGENTS.md at the root and a manifest that only lets the app touch what it created — to serve as an Obsidian vault and as an agent's working folder; these are the layout, the formats, the incremental cycle, overwriting and what the server must offer.
resource: desktop/crates/mirror/**, desktop/src-tauri/src/mirror_sync.rs, desktop/src-tauri/src/config.rs, desktop/src-tauri/src/state.rs, desktop/ui/js/views/settings.js, desktop/crates/sync/src/protocol.rs
tags: [code, desktop, sync, markdown, jsonl, obsidian, agentes, collections]
timestamp: 2026-09-29
audience: both
authority: current
source: holetz/eclume#68
maintainer: holetz
---

# Desktop app synced folder

The desktop app keeps, if the person turns it on, a folder on the computer that mirrors **their
library** (not only what that computer recorded): the current summary of each recording as `.md`
and the transcript as `.jsonl`. The folder serves two uses at once: an **Obsidian vault** and **an
agent's working folder** (Claude Code, Codex etc.). The server is the source; the folder is a mirror.

The pure logic lives in the `eclume-mirror` crate (`desktop/crates/mirror`), with no Tauri or
network (the mobile app also compiles `desktop/crates`); the app (`desktop/src-tauri/src/mirror_sync.rs`)
only reads from the server and calls the crate. Configuration lives in `config.json` (`mirror`), in
the **Pasta** tab of Configurações. What the person reads is in the web's `pasta-sincronizada`
help article.

## Layout

```
<raiz>/
  AGENTS.md                                   ← gerado pelo app
  .eclume-sync.json                           ← manifesto (o Obsidian ignora dotfiles)
  <Collection>/
    AAAA-MM/                                  ← o mês do início da gravação (hora local)
      AAAA-MM-DD_HHMM_<id8>.md                ← resumo atual
      AAAA-MM-DD_HHMM_<id8>.jsonl             ← transcrição (se ligada)
  sem-colecao/                                ← gravações sem Collection (mesma divisão por mês)
```

- **Collections become subfolders.** The server has flat Collections (no hierarchy) and a
  recording can be in several: it is written **into each one** (identical copies).
- **One month per subfolder** (`AAAA-MM`, like note apps do: it keeps each folder at hundreds of
  files, not thousands, and the folders sort themselves). The month and the name use the
  **computer's local time** (`recorded_at` converted by the app), so they match what the person
  sees; the front matter's `recorded_at` stays in UTC.
- **Base name** = `AAAA-MM-DD_HHMM_<id8>`: a sortable date and time and the first 8 alphanumeric
  characters of the recording id (the **reference** eclume web shows under the title, with the
  full id in the tooltip). It has a fixed length (24 characters): **the title never goes into the
  path**, so no title, however long, exceeds any system's path limit. The id is `uuid4`, so two
  names only collide with equal date, time and 8 characters.
- **The title lives in the file**: the `title` and `aliases` front matter properties (Obsidian
  finds the note by its alias), and `title` in the JSONL meta.
- **Collection folder names** (`layout::slug`): characters forbidden on Windows
  (`\ / : * ? " < > |` and control characters) and those that break Obsidian links (`[ ] # ^`)
  become spaces; spaces collapse; trailing dots and spaces drop; Windows reserved names (`CON`,
  `NUL`, `COM1`…) get a `_`; limited to 50 characters. Capitals, accents and spaces stay. The
  maximum relative path stays around 90 characters.
- A recording with no summary but with a transcript writes only the `.jsonl`; with neither,
  nothing.
- **Layout change.** The manifest stores the layout version (`layout`); with another version (or
  without one, as in the manifests of the old design `<Collection>/AAAA-MM-DD <título> - <id8>`),
  the next cycle rereads everything and the manifest moves the files and deletes the old ones,
  without duplicating.

## Formats

**Summary (`.md`)**: YAML front matter and the server's Markdown.

```yaml
---
source: eclume
recording_id: "01928f3a-1c00-…"
title: "Alinhamento do orçamento"
aliases:
  - "Alinhamento do orçamento"        # o Obsidian acha a nota pelo título
recorded_at: "2026-09-18T14:00:05Z"
collections:
  - "Clientes"
agenda_type: "Reunião de equipe"     # omitido sem tipo de agenda
summary_version: 3
summary_stale: true                  # só quando o resumo é de uma revisão anterior da transcrição
transcript: "2026-09-18_1100_01928f3a.jsonl"   # só com transcrição
---
```

**Stale summary.** The app reads `transcript_revision` from the current summary (contract 2.25.0).
When it is lower than the `revision` of the mirrored transcript, the front matter gains
`summary_stale: true` and the body opens, right below it, with the callout `> [!warning] Resumo de uma versão anterior da
transcrição` and the line `A transcrição foi alterada depois deste resumo. Use Regenerar para refletir
as mudanças.` (the same text as the web notice). Without one of the two revisions (a server older
than 2.25.0, or a transcript that is not mirrored) there is no notice, and the property does not
exist.

With a marker that has a note, the `.md` ends with the `## Notas dos marcadores` section: one line
`- [HH:MM:SS] nota` per marker, in order of instant, the note flattened onto one line. With no
note at all, the section does not exist. The app reads `GET /recordings/{id}/markers`
(`recordings:read`) only for the recordings that have a summary to write; a failure becomes a
pending item, like the other reads.

**Transcript (`.jsonl`)**: one line per object. The first is `{"type":"meta", id, recording_id,
title, language, recorded_at, duration_ms, revision, speakers:[{id,label}]}`; the rest,
`{"type":"segment", speaker, speaker_id, start_ms, end_ms, text}`. Obsidian does not index
`.jsonl`, so the transcripts, which are long, **do not pollute the vault's search or graph**, and
an agent reads them with `rg`/`jq`.

**`AGENTS.md`**: regenerated on every cycle (the first line is an HTML generated-file marker)
with the structure, the properties, the JSONL format and search examples. The person's own
`AGENTS.md` (without the marker) is **never** overwritten.

## The cycle

Its own thread (`eclume-mirror`, every 60 s and on every configuration change), so a large
library does not delay the upload of recordings.

1. `GET /collections` (a single spelling per name, case-insensitive: "Clientes" and "clientes"
   are the same folder on Windows and macOS) and `GET /recordings?since=<cursor>`, read through
   the shared read (`sync::library_since`) that also serves the outcomes and the recent ones,
   instead of a read of its own every minute. The cursor is the highest
   `updated_at` read **minus 2 minutes** (the server's `now()` is the start of the transaction, so
   one committed after another with a higher `updated_at` cannot be skipped) and lives **in the
   manifest**: deleting or switching the folder redoes everything. On the first pass the listing is
   already the whole library.
2. For each recording with a transcript: `GET /recordings/{id}/summary` and, if turned on,
   `GET /transcripts?recording_id=`. A failure on one recording does not stop the others: it goes
   to the manifest's **pending** list and the **cursor advances all the same**; the next cycle
   rereads only the pending ones, **one by one by id** (`GET /recordings/{id}`), never through the
   listing or the whole library. Writing is idempotent.
   **Server without the transcripts scope** (403 `insufficient_scope`, a server older than
   contract 2.8.0 or a token that migration 018 has not reached yet): the first refusal holds for
   the whole cycle, the summaries are written, the cursor advances and the tab warns that the
   server needs updating. A recording that already had a `.jsonl` **stays as it is** (degrading
   means not updating, not deleting). The sweep fills in the missing transcripts once the scope
   arrives.
3. **Sweep** every 6 h and on "Sincronizar agora": it lists the whole library, brings what the
   manifest does not have yet and **deletes the recordings that left the server**. Only the sweep
   and the full pass (first time, layout change or a change of the transcripts option) delete whole
   recordings; the incremental cycle only moves or removes the files of a recording that changed
   (Collection or start) and never forgets a recording.
4. **The "Incluir as transcrições" option changed** (the manifest stores which one it had): the
   next cycle redoes everything, writing or removing the `.jsonl` files and the `transcript` link
   in the `.md` files.
5. It writes `AGENTS.md` (a failure on it is only logged) and saves the manifest **always**, even
   after an error: what was already written cannot go unrecorded.

For the cursor to see the changes, the server moves `recordings.updated_at` when: a summary
finishes, is edited or is deleted; the transcript is edited (speaker, segment, merge); the
Collection is renamed or deleted; a marker is created, has its note edited or is deleted
(`markers.touch_recording`); and on the field changes that already existed.

## Overwriting and safety

- **The server rules.** The file is rewritten when the content on disk differs (SHA-256 hash); a
  local edit to an app file is overwritten on the next cycle. With no change, nothing is written.
- **Only what the manifest lists is moved or deleted** (the recording's Collection or start
  changed, recording removed). The person's files in the folder, and folders that contain them,
  stay. A manifest path that escapes the root (`..`, absolute) is refused. An unreadable manifest
  starts over empty and **deletes nothing**.
- Writing is atomic (a temporary file with a dot, then a rename; if the rename fails, as on
  Windows with the file open, the temporary file is removed). The root cannot be the disk root
  or the home folder (a "Documents" Collection would write into `~/Documents`). Symbolic links
  inside the chosen folder are deliberately not followed; do **not** point the folder inside a
  directory that holds links out of it.

## What the server offers (contract 2.8.0)

- The device credential has `transcripts:read` (migration `018_dispositivo_le_transcricao`,
  which also extends the tokens already issued) besides `recordings:read` and `summaries:read`.
- A summary that finishes or is edited moves the `updated_at` of the recording **and** of the
  transcript (`summaries.touch_recording`), so `?since=` notices a new or redone summary.

## Tests

`cargo test -p eclume-mirror` (layout, formats, manifest, reconciliation, `AGENTS.md`),
`cargo test -p eclume-desktop -- mirror_sync` (cycles against a fake source: first pass,
incremental, sweep, partial failure) and `cargo test -p eclume-sync` (the client reads).
The tab and its explanatory text: `desktop/ui-tests/settings.spec.ts`; on the server,
`server/tests/test_devices.py` and `test_summaries.py`.
