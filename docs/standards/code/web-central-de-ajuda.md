---
type: standard
title: Web help center
description: The eclume web help lives in the build itself — Markdown articles in per-locale folders (web/src/features/help/articles/en and pt-BR, shared English slugs and header keys), six topics, page keys that link each screen to its articles, local accent-insensitive search, a per-page drawer and inline hints — in English and pt-BR for the per-user product, with a locale fallback to en, old-product terms and uncatalogued UI labels refused by a test, and the rule of reviewing a screen's articles when it changes.
resource: web/src/features/help/**, web/src/app/help.ts, web/src/app/HelpDrawer.tsx, web/src/app/HelpHint.tsx
tags: [code, web, ajuda, documentacao, acessibilidade]
timestamp: 2026-11-05
audience: both
authority: current
source: holetz/eclume#38, holetz/eclume#125, holetz/eclume#142, holetz/eclume#252
maintainer: holetz
---

# Web help center

User help is part of the web build: no server, no CDN and no database. The content is Markdown
files versioned alongside the screens they explain, and each screen declares which articles are
its own. The app's structure is in [frontend-web.md](frontend-web.md); the visuals
(`.help-drawer`, `.topic-grid`, `.hint`, `.popover`) come from the DS ([web-design-system.md](web-design-system.md)).

## Where the articles live

- One file per article and locale in `web/src/features/help/articles/<locale>/<slug>.md`, with
  `<locale>` one of `en` and `pt-BR`; the slug is the file name and the address is `/ajuda/<slug>`.
  **Slugs are English and identical in both locales**: a test requires the same ids, topics, page
  keys, order and related articles in each.
- **A slug cited by another client is not renamed on its own.** The desktop app opens
  `first-recording`, `microphone-permissions` and `synced-folder` from the help menu and from
  Settings; renaming or deleting one of them also changes `desktop/ui/js` (the desktop's `ui_assets`
  test reads `articles/en` and fails without the article). The `microphone-permissions` article
  covers only the systems the release ships (Windows, Linux and Android).
- The frequently asked questions live in `web/src/features/help/faq/<locale>.md`, one per `##`.
- `catalog.ts` reads everything through `import.meta.glob('./articles/*/*.md', { query: '?raw', eager: true })`
  and splits it per locale. `helpCatalog(locale)` returns the set of the active locale and falls
  back to `en`; `useHelpCatalog()` is the hook the screens use, so a locale switch re-renders them.
  Only the center (`/ajuda`, `/ajuda/:slug`) and the drawer body import the catalog, and both are
  on-demand chunks: the articles do not enter the initial bundle.
- The strings of the center itself, the six topic names and the page-key labels live in the `shell`
  catalog under `helpCenter`, in both locales.

## The header

```md
---
title: How voice suggestions work
topic: transcricao
pages: [pessoas, pessoa, gravacao]
related: [link-speaker-to-person, forget-a-voice]
terms: [voiceprint, biometrics, LGPD, threshold]
order: 2
updated: 2026-09-27
---
```

- `frontmatter.ts` reads only `key: value` and `key: [a, b]`, with no dependency, and throws with
  the file name when the header is invalid. The keys are English; `topic` and the `pages` entries
  are wire names (`comecar`, `pessoas`…) that stay as they are in both locales.
- `topic` is one of six: `comecar` (First steps), `processamento` (Processing and failures),
  `transcricao` (Transcription and speakers), `resumos` (Summaries and chat), `organizar` (Fields,
  rules and agenda types) and `conectar` (Assistants, tokens and devices). `order` orders within the
  topic.
- `pages` are **page keys** (`pages.ts`): `biblioteca`, `gravacao`, `busca`, `agente`, `pessoas`,
  `pessoa`, `colecoes`, `tags`, `automacao`, `campos`, `agendas`, `mcp`, `tokens`, `app-desktop`,
  `app-movel`, `conta`, `ambiente` and `ajuda`. A new key goes into `HELP_PAGES`, with its label in
  `shell:helpCenter.pages` in both locales.
- `terms` are synonyms the search weighs, but that the text need not repeat; write them in the
  article's language.
- The body uses `##` for sections (they become the article's "On this page" index), internal links
  starting with `/` and a `> **Title**` at the start of a quote to become `.alert alert-info`. Raw
  HTML is not rendered.

## Search, drawer and hint

- **Local search** (`search.ts`): NFD, no accents, lowercase and no punctuation; terms of 2+
  characters, all of which must match by word prefix. Weight per term: title 5, `termos` 4, `##`
  headings 3, body 1; ties by topic order. The returned excerpt has up to 160 characters around the
  first occurrence and the screen marks the term with `<mark>`.
- **Per-page drawer**: each screen calls `useHelpTopic(<key>)`; the `?` (or the `PageHead` Help
  button) opens the drawer, whose body loads on demand with the search (up to 6 results), the key's
  articles ("On this page · <label>") and the shortcuts. Clicking a link navigates and keeps the
  drawer open.
- **Inline hint** (`HelpHint`): the `.hint` "?" with `aria-label="About <subject>"` that opens a
  `.popover` with the short text and "Read the article →". It goes where the rule is not obvious on the
  screen (for example "How to identify" in Custom fields and "Delete recordings" in MCP connection), never as decoration.

## Writing

- Second person ("you" / "você"), short sentences and button names as the screen shows them **in
  that locale**: an English article cites the English catalog label, a pt-BR article the pt-BR one.
- The product is **per user**: each account sees only what is its own, with no sharing between
  accounts; accepting the notice at sign-up leaves to the person the duty of asking for the consent
  of whoever is recorded; there is no live transcription; whoever administers the server takes care
  of configuration and health, without seeing content.
- Names the server owns stay as it spells them, with a gloss in the English text: the title-pattern
  placeholders (`{assunto}`, `{data}`, `{tipo}`, `{chave}`) and the agenda types seeded for a new
  account (`Geral`, `Reunião de equipe`…).
- `catalog.test.ts` runs for each locale: a valid header, internal links to routes and articles
  that exist, `related` that exist, 44 articles, three or more per topic, at least one per page key,
  the old-product terms refused (organization, tenant, invitation, consent form, voice consent, live
  transcription, "shared with" and template, and their Portuguese forms), and **every bolded label
  an article cites must be a string of the same locale's catalogs**. Bold text that is not a web UI
  label (desktop and phone screens, the system, the agent screens until their catalog lands, server
  seeds, emphasis) is listed in the test's `OUTSIDE` table; a new entry there is a deliberate choice.

## Review per screen

Whoever changes a screen reviews, in the same PR, the articles whose `pages` has its key (`grep -l
'<key>' web/src/features/help/articles/*/*.md`), in **both** locales, and updates the `updated` of those
that changed. A new screen gets a key, `useHelpTopic` and at least one article in each locale.
