---
title: Sync your summaries to a folder
topic: conectar
pages: [app-desktop, colecoes]
related: [tags-and-collections, install-desktop-app, connect-mcp-assistant]
terms: [folder, sync, synchronization, Obsidian, vault, Markdown, JSONL, agent, AGENTS.md, Claude Code, collection, collections, subfolder, mirror]
order: 6
updated: 2026-10-08
---
The desktop app can keep a folder on your computer with the **summary** and the **transcript** of
each recording in your library. This way you read, search and reuse the content outside eclume, in a
notes editor or with an agent.

## Turn on syncing

In the desktop app, open **Settings**, **Folder** tab:

1. Choose the destination folder with **Choose folder…**. Use a folder just for this, not your
   personal folder.
2. Turn on **Sync summaries to a folder**.
3. Leave **Include transcripts** on if you want the `.jsonl` files, or turn it off to keep only the
   summaries. Changing this option redoes the folder in the next cycle.

The app syncs every minute and on startup. **Sync now** asks for a cycle right away and checks the
whole library, including what was deleted in eclume. The first time it copies everything and may
take a while in a large library.

## How the folder is organized

[Collections](/colecoes) become subfolders, and inside each there is one folder per month:

```text
Clients/
  2026-09/
    2026-09-18_1100_01928f3a.md
    2026-09-18_1100_01928f3a.jsonl
  2026-10/
    ...
Internal/
  ...
sem-colecao/
  ...
AGENTS.md
```

- A recording in more than one collection appears in each, with the same content.
- Recordings that are in no collection go in `sem-colecao` (no collection).
- The month folder is that of the **start of the recording**, in your computer's time.
- The file name is the date, the time and an 8-character **reference**. Sorting the files by name is
  sorting by date. The title is **not** in the name (long names error out on some systems): it is
  inside the file.
- The reference is the same one that shows, discreetly, right below the recording's title here in
  eclume ("ref. 01928f3a"). Hover over it to see the full identifier. Use it to find a recording's
  file on the computer, and vice versa.
- The `.md` is the current summary, with properties at the top (`recording_id`, `title`, `aliases`,
  `recorded_at`, `collections`, `agenda_type`, `summary_version`). The `.jsonl` is the transcript: the
  first line describes the recording and each following line is an utterance, with speaker, start,
  end and text.
- If the recording has markers with notes, the `.md` ends with the **Marker notes** section: one line
  per note, with the time in the audio (`- [00:12:30] check the number`). A marker without a note
  does not appear.
- If the transcript changed after the summary, the `.md` carries `summary_stale: true` in the
  properties and a warning banner at the top ("Summary of an earlier version of the transcript"). It
  is the same warning as on the recording page: use **Regenerate** in eclume and, in the next cycle,
  the file goes back to normal. Without the mirrored transcript, the app cannot compare and does not warn.
- Changed the collection in eclume? The files change folder in the next cycle. Whoever already used
  the folder before the split by month has the files reorganized on their own, without duplicating.

## Use it as an Obsidian vault

Open the folder as a **vault** in Obsidian. It reads the `.md` files, with the properties, and
ignores the `.jsonl`. Since the file name has no title, quick search (`Ctrl+O`) and `[[...]]` links
find the note by its title, which the app writes as an `alias`. That is why the transcripts, which
are long, stay out of the vault's search and graph, but sit beside the summary when you need them.

## Use it as an agent's working folder

At the folder's root the app keeps an `AGENTS.md` that explains to an agent, such as Claude Code,
what is there and how to read and search it: the structure, the properties, the JSONL format and
examples of searching with `rg` and `jq`. Just open the agent in the folder.

For the agent to query eclume directly, instead of files, see
[Connect an assistant through MCP](/ajuda/connect-mcp-assistant).

## What the app does and does not do with the files

- The folder is a **mirror**: eclume is the source. Editing a generated file does not change the
  summary on the server, and the edit is lost in the next cycle. To really edit, use
  [Edit a summary](/ajuda/edit-summary) in eclume, or work on a copy.
- Your own files in the folder are never touched: the app only handles what it created.
- Deleting a recording in eclume deletes its files in the folder, at the next check.
- Whoever has access to the folder reads the summaries and transcripts: keep it where only you have access.
