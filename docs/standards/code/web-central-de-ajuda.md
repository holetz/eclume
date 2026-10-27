---
type: standard
title: Web help center
description: The eclume web help lives in the build itself — Markdown articles with a header in web/src/features/help/articles, six topics, page keys that link each screen to its articles, local accent-insensitive search, a per-page drawer and inline hints — written in pt-BR for the per-user product, with old-product terms refused by a test and the rule of reviewing a screen's articles when it changes.
resource: web/src/features/help/**, web/src/app/help.ts, web/src/app/HelpDrawer.tsx, web/src/app/HelpHint.tsx
tags: [code, web, ajuda, documentacao, acessibilidade]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#38, holetz/eclume#125, holetz/eclume#142
maintainer: holetz
---

# Web help center

User help is part of the web build: no server, no CDN and no database. The content is Markdown
files versioned alongside the screens they explain, and each screen declares which articles are
its own. The app's structure is in [frontend-web.md](frontend-web.md); the visuals
(`.help-drawer`, `.topic-grid`, `.hint`, `.popover`) come from the DS ([web-design-system.md](web-design-system.md)).

## Where the articles live

- One file per article in `web/src/features/help/articles/<slug>.md`; the slug is the file name
  and the address is `/ajuda/<slug>`.
- **A slug cited by another client is not renamed on its own.** The desktop app opens
  `primeira-gravacao`, `permissoes-de-microfone` and `pasta-sincronizada` from the help menu and
  from Configurações; renaming or deleting one of them also changes `desktop/ui/js` (the desktop's
  `ui_assets` test fails without the article). The `permissoes-de-microfone` article covers only the
  systems the release ships (Windows, Linux and Android).
- The frequently asked questions live in `web/src/features/help/perguntas.md`, one per `##`.
- `catalog.ts` reads everything through `import.meta.glob('./articles/*.md', { query: '?raw', eager: true })`.
  Only the center (`/ajuda`, `/ajuda/:slug`) and the drawer body import the catalog, and both are
  on-demand chunks: the articles do not enter the initial bundle.

## The header

```md
---
titulo: Como funcionam as sugestões por voz
topico: transcricao
paginas: [pessoas, pessoa, gravacao]
relacionados: [ligar-locutor-a-pessoa, esquecer-a-voz]
termos: [impressão de voz, biometria, LGPD, limiar]
ordem: 2
atualizado: 2026-09-27
---
```

- `frontmatter.ts` reads only `chave: valor` and `chave: [a, b]`, with no dependency, and throws
  with the file name when the header is invalid.
- `topico` is one of six: `comecar` (Primeiros passos), `processamento` (Processamento e falhas),
  `transcricao` (Transcrição e locutores), `resumos` (Resumos e chat), `organizar` (Campos, regras
  e tipos de agenda) and `conectar` (Assistentes, tokens e aparelhos). `ordem` orders within the
  topic.
- `paginas` are **page keys** (`pages.ts`): `biblioteca`, `gravacao`, `busca`, `agente` (formerly
  `perguntas`), `pessoas`,
  `pessoa`, `colecoes`, `campos`, `agendas`, `mcp`, `tokens`, `app-desktop`, `app-movel` and
  `ajuda`. A new key goes into `HELP_PAGES`, with the label for "Nesta página · <rótulo>".
- `termos` are synonyms the search weighs, but that the text need not repeat.
- The body uses `##` for sections (they become the article's "Nesta página" index), internal links
  starting with `/` and a `> **Título**` at the start of a quote to become `.alert alert-info`. Raw
  HTML is not rendered.

## Search, drawer and hint

- **Local search** (`search.ts`): NFD, no accents, lowercase and no punctuation; terms of 2+
  characters, all of which must match by word prefix. Weight per term: title 5, `termos` 4, `##`
  headings 3, body 1; ties by topic order. The returned excerpt has up to 160 characters around the
  first occurrence and the screen marks the term with `<mark>`.
- **Per-page drawer**: each screen calls `useHelpTopic(<chave>)`; the `?` (or the `PageHead` Ajuda
  button) opens the drawer, whose body loads on demand with the search (up to 6 results), the key's
  articles ("Nesta página · <rótulo>") and the shortcuts. Clicking a link navigates and keeps the
  drawer open.
- **Inline hint** (`HelpHint`): the `.hint` "?" with `aria-label="Sobre <assunto>"` that opens a
  `.popover` with the short text and "Ler o artigo →". It goes where the rule is not obvious on the
  screen (for example "Como identificar" in Campos personalizados and "Excluir gravações" in Conexão
  MCP), never as decoration.

## Writing

- pt-BR, second person ("você"), short sentences and button names as the screen shows them.
- The product is **per user**: each account sees only what is its own, with no sharing between
  accounts; accepting the notice at sign-up leaves to the person the duty of asking for the consent
  of whoever is recorded; there is no live transcription; whoever administers the server takes care
  of configuration and health, without seeing content.
- Old-product terms are refused by `catalog.test.ts`: organização, tenant, convite, termo de
  consentimento, consentimento de voz, "ao vivo", "compartilhado com" and template. The same test
  requires a valid header, internal links to routes that exist, `relacionados` that exist, three or
  more articles per topic and at least one article per page key.

## Review per screen

Whoever changes a screen reviews, in the same PR, the articles whose `paginas` has its key (`grep -l
'<chave>' web/src/features/help/articles/*.md`) and updates the `atualizado` of those that changed.
A new screen gets a key, `useHelpTopic` and at least one article.
