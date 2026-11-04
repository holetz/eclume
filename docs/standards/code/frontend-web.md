---
type: standard
title: Web app structure
description: The eclume web app (web/) talks to the API through a client generated from the contract, on the same origin and with a cookie session and double-submit CSRF; the admin panel is a separate app, with its own login, session and frame; it is organized into a shell with grouped navigation, the Ask item highlighted at the top and a help drawer, features (library timeline with the Import modal, recording centered on the summary, people, search, collections, organize, rules with the view of automatic processing, grouped my settings, help center, admin) and an upload engine without React; and it is tested with vitest over the contract fixtures and with a Playwright E2E against the Prism mock.
resource: web/src/**, web/e2e/**, web/playwright.config.ts, web/vite.config.ts, web/package.json
tags: [code, web, react, api, upload, testes]
timestamp: 2026-11-04
audience: both
authority: current
source: holetz/eclume#10, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#36, holetz/eclume#37, holetz/eclume#38, holetz/eclume#39, holetz/eclume#72, holetz/eclume#75, holetz/eclume#76, holetz/eclume#77, holetz/eclume#78, holetz/eclume#79, holetz/eclume#86, holetz/eclume#110, holetz/eclume#111, holetz/eclume#112, holetz/eclume#113, holetz/eclume#100, holetz/eclume#114, holetz/eclume#99, holetz/eclume#98, holetz/eclume#117, holetz/eclume#118, holetz/eclume#119, holetz/eclume#116, holetz/eclume#115, holetz/eclume#120, holetz/eclume#121, holetz/eclume#127, holetz/eclume#144, holetz/eclume#143, holetz/eclume#142, holetz/eclume#145, holetz/eclume#153, holetz/eclume#249
maintainer: holetz
---

# Web app structure

`web/` is a React + Vite + TS SPA, served statically and behind a login. The content comes from API
v1 ([contrato-v1.md](../api/contrato-v1.md)); media conversion comes from the library of
[formato-audio-upload.md](formato-audio-upload.md).

## API client: generated, never handwritten

- `npm run gen:api` generates `src/api/schema.gen.ts` from `contracts/openapi-v1.bundled.yaml`
  with `openapi-typescript`. The file is versioned, and CI runs `gen:api -- --check`: the contract
  changed, regenerate. **No API type is declared by hand**; derive from `Schemas['X']` or from
  `operations[...]`.
- Calls go through `api` (`src/api/client.ts`, `openapi-fetch`), typed by path.
  `unwrap()` returns the data or throws `ApiError` with the `Problem`; the UI decides by
  `problem.code` and shows `errorMessage()`, never the `title`.
- `quota_exceeded` (holetz/eclume#98) has a message per `quota`, with the problem's `limit` (bytes in
  GB/MB): file size, storage full, simultaneous uploads and requests to the agent in
  24 h. Import shows that message on the refused item, like the other upload errors.
- `openapi-typescript` declares `typescript ^5` as a peer; `package.json` overrides it with
  `overrides` to use the project's TS.

## Single origin, session and CSRF

- The app calls `/api/v1/...` relative to its own origin, with `credentials: 'same-origin'`. In
  production Caddy serves web and API on the same origin; in dev, `vite.config.ts` proxies
  `/api` to `ECLUME_API_URL` (default: the mock at `http://127.0.0.1:4010`). There is no CORS.
- The user session is the `eclume_session` cookie, opened by `POST /auth/login`. The admin panel's
  is another one, `eclume_admin_session` (it only travels to `/api/v1/admin`), opened by
  `POST /admin/auth/login`. `csrfMiddleware` copies into `X-CSRF-Token`, on every mutating
  method, the area's cookie: `eclume_admin_csrf` when the URL starts with `/api/v1/admin/`,
  `eclume_csrf` otherwise (`isAdminUrl`).
- User session state = `useMe()` (`GET /me`; 401 becomes `null`). `unauthorizedMiddleware`
  clears that session in the cache on every 401 outside login and **outside `/api/v1/admin/`** (the
  panel's 401 belongs to the admin session), and the `RequireSession` guard leads to `/entrar?volta=<rota>`; `volta`
  only accepts an internal path.
- **The session does not drop because of a refetch.** `RequireSession` and `RequireAdmin` only show "Tentar de
  novo" (Try again) with `isError` **and no cached data**: a refetch of `/me` (or `/admin/me`) that fails over
  the loaded session keeps the shell, the import queue, the summary draft and the chat. The session
  only drops on a 401.
- **Connection banner** (`ConnectionBanner`, at the top of `AppShell`): without network (`onlineManager`) or
  with `/me` failing over the cached session, an `.alert-warning` with `role="status"` says "Sem
  conexão com o servidor. O que está na tela pode estar desatualizado; tentando de novo…", rereads
  `/me` every 10 s, doubling on each failure up to 60 s, while the server does not answer, and disappears by itself. Queries and mutations already
  pause without network and resume when it returns (the default `networkMode`); the banner only gives the reason.
- **What belongs to one account does not cross into another** (`app/accountScope.ts`): the tab keeps the id of the
  last account (`eclume-conta` in `sessionStorage`, set by login, by sign-up and by the
  session that already came from the cookie). Signing in with another account removes the queries outside `['admin']`
  (except the session just read) and the `eclume-resumo-rascunho:*` drafts. A 401 with the session
  open removes the queries outside `['admin']` and clears `['me']`, without deleting drafts: the same
  account that comes back finds them again. `useLogout` uses the same removal.

## Generated Markdown and CSP

- **LLM-generated Markdown never loads an image.** The summary (`SummaryDoc`), the copy for pasting
  (`copy-summary.ts`), the Agent's answers (`AgentPage`) and the agenda type preview
  (`AgendaTypePreview`) pass to `react-markdown` the `components` of `src/app/markdown.tsx`
  (`SAFE_MARKDOWN`, or `safeMarkdown(próprios)` when the screen swaps other elements, which never
  override `img` nor `a`): `![alt](url)` becomes a text link (`alt`, or the URL without it) and every
  link opens in another tab with `rel="noopener noreferrer"`. A poisoned summary does not make the browser
  fetch an outside URL (tracking, `Referer`). Help, with its own content, stays out of this.
- **The CSP belongs to the SPA rules in the edge image** (`deploy/web.Caddyfile`, `eclume-edge`): `default-src 'self'`,
  `img-src 'self' data: blob:`, `media-src 'self' blob:`, `connect-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `frame-ancestors 'none'`,
  `base-uri 'none'` and `object-src 'none'`, with `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. The app complies: no inline script or style in `index.html`,
  no resource from another origin (fonts and icons come from the assets), the `/media` audio on the same
  origin and ffmpeg.wasm from the Vite assets. A new outside resource requires changing the CSP with it. The only
  exception is the API reference (`/referencia-api.html` and `/referencia-api/*`, Redoc HTML generated
  in the build): the same `script-src 'self'`, but `style-src 'self' 'unsafe-inline'`, because Redoc
  injects the CSS in `<style>`; the standard is in [contrato-v1.md](../api/contrato-v1.md). The edge
  Caddy repeats `nosniff`, `Referrer-Policy` and `frame-ancestors 'none'` (without overriding the web's
  CSP) for `/api`, `/media`, `/mcp` and `/downloads`.

## Folder structure

| Folder | What it holds |
|---|---|
| `src/api/` | generated client, `client.ts`, `problem.ts` |
| `src/app/` | shell, brand (`Brand.tsx`), navigation (`nav.ts`), routes (`routes.tsx`), `PageHead`, 404, help drawer, session, providers, theme, and the DS pieces `Dialog`, `ConfirmDialog`, `MenuButton`, `CopyValue`, `HelpHint` and `storage.ts` |
| `src/i18n/` | i18next setup (`index.ts`, `setLocale`, `activeLocale`), `LocaleSync`, and the typed catalogs `en/<ns>.ts` and `pt-BR/<ns>.ts`: [i18n.md](i18n.md#the-web-app) |
| `src/features/<área>/` | page, components, CSS Module and tests of each area |
| `src/upload/` | multipart upload engine, without React |
| `src/styles/` | `global.css` (entry), `fonts.css`, `eclume.css` (faithful copy of the DS) and `app.css` (product): [web-design-system.md](web-design-system.md) |
| `src/test/` | `fetch` double, typed fixtures and `renderApp` |
| `src/lib/media-convert/` | conversion library, self-contained |
| `src/shared/` | what more than one feature uses and has no domain owner: `format.ts` (recording state and step, dates, times, durations, sizes and the audio clock) and the DS `Switch` |

- **Boundaries between features** (`src/test/boundaries.test.ts`, a test of the suite): the import
  graph between `src/features/*` (production code, without tests) has no cycle; only the
  admin itself and `app/routes.tsx` import `features/admin/` (`eslint.config.js` forbids the same with
  `no-restricted-imports`); and `src/shared/` imports neither from `features/` nor from `app/`. A piece with
  an owner lives in its owner (`PersonCombobox`, with its CSS, in `features/people/`); importing another
  feature's `queries.ts` is still allowed as long as it does not close a cycle. No barrel: whoever
  uses it imports from the file that defines it.
- **UI text goes through `t()`.** A new visible string (JSX text, `aria-label`, `title`,
  `placeholder`, a `label` or `hint` prop) is a key in the area's namespace, written in both
  `en/<ns>.ts` and `pt-BR/<ns>.ts`, read with `useTranslation('<ns>')` in a component or `i18n.t` in
  a module. Dates and numbers use `Intl` with `activeLocale()`. An area in `COVERED` of
  `src/test/literalStrings.test.ts` fails the suite on a literal; the rules are in
  [i18n.md](i18n.md#the-web-app).

- **Routes in pt-BR** (`/entrar`, `/cadastro`, `/redefinir-senha`, `/parear`, `/gravacoes/:id`, `/pessoas`,
  `/pessoas/:id`, `/busca`, `/agente`, `/agente/:sessionId`, `/agente/conversas`, `/agente/habilidades`, `/colecoes`, `/config/campos`, `/config/agendas`, `/config/mcp`,
  `/config/ambiente`, `/tokens`, `/app-desktop`, `/app-movel`, `/ajuda`, `/ajuda/:slug`, `/admin/entrar`, `/admin/*`),
  none starting with `/mcp` (the MCP server's address); `/importar` redirects to
  `/?importar=1` (the modal) and `/perguntas`, the Agent's old name, to `/agente`. The parameters are pt-BR too:
  - library (`/`): `visao=semana|mes|lista`, `data=AAAA-MM-DD` (any day of the period),
    `tipo=reuniao|nota`, `situacao=pronta|processando|falhou`, `tag`, `pessoa`, `colecao`,
    `campo=<field_id>:<valor>` (all repeatable) and `importar=1`;
  - recording: `t=<ms>`;
  - search: `q`, `pessoa`, `periodo=7d|30d|ano`, `de`, `ate`, `tag`, `colecao` and `campo`
    (repeatable);
  - person: `aba=gravacoes|falas|amostras`; Custom fields: `campo`; Agenda types: `tipo`.
  The library shows only the user's recordings: there is no Mine/Shared filter.
- **On-demand routes.** `routes.tsx` loads through `React.lazy` + `Suspense` every area besides the
  library and the login, each in its own chunk. The WebCodecs chunk (Mediabunny, ~560 KB) only
  loads on the import conversion, and the Vite large-chunk warning that still shows up is its.
- **Initial JS budget** (`npm run budget`, after the build, in the `web` pillar):
  `scripts/bundle-budget.mjs` sums the `<script type="module">` and the `modulepreload` of
  `dist/index.html` (raw and gzip level 9) and fails above `bundle-budget.json`
  (`inicial_gzip_kb`). Measured on 2026-10-05: 29 files, 466 KB (155.9 KB gzip), ceiling of 158 KB
  gzip; it went up from 155 KB with the integration of specs holetz/eclume#141 to #145 (the library's "Precisam de
  você" (Need you) strip, the Speakers step in the processing notice and the Agent group in the menu, all
  in the shell or in the library, which load up front). Changing the ceiling is editing the JSON in the same commit as the
  change, with the reason.
- **Data router.** `routes.tsx` exports the tree as `routes: RouteObject[]`; `App.tsx` mounts
  `createBrowserRouter(routes)` once, outside the component, with the `RouterProvider` of
  `react-router/dom` inside `AppProviders`, and the tests' `renderApp` mounts the same tree in a
  `createMemoryRouter`. Screens fetch data through React Query: no loaders, actions nor the router's
  `lazy`.
- **Error per route, no blank screen.** There are two `errorElement`s: `RootError` at the root (whole
  page, for login, sign-up, pairing and `/admin/*`) and `RouteError` in a pathless route child
  of `RequireSession`, which shows up in the shell's `Outlet` with the bar, the header and the import
  queue still standing; a location change resets the boundary, so the bar gets out of the error. A
  chunk failure (the message of the dynamic `import()` of Chromium, Firefox or WebKit, or Vite's
  preload) becomes "O eclume foi atualizado" (eclume was updated); a common exception, "Algo deu errado nesta tela" (Something went wrong on this screen). Both have
  "Recarregar" (Reload), never show a stack and log to `console.error`.
- **Single reload for an old chunk** (`app/chunkReload.ts`, registered in `main.tsx`): on
  `vite:preloadError`, if the last chunk reload (stamp `eclume-recarga-chunk` in
  `sessionStorage`) is more than 60 s old, it writes the stamp, cancels the event and reloads; otherwise the error
  goes on to `RouteError`. The time window, and not an eternal flag, lets a second deploy
  in the same tab reload again. The edge static server (`eclume-edge`) answers `404` without
  `immutable` for a missing `/assets/*`, so `import()` fails fast and with a reason.
- **Leave guard** (`app/useLeaveGuard.tsx`): with unsaved changes, closing or reloading the
  tab fires the browser's warning (`beforeunload`), and going to another app route asks for confirmation
  through `useBlocker`, only when the `pathname` changes (the recording's `?t=` and the selection in the URL go through);
  it returns the dialog with "Continuar editando" (Keep editing) and "Descartar" (Discard). The summary editing and the
  selection in Custom fields and Agenda types use the guard; `ImportProvider` keeps only
  `beforeunload`, because it lives in the shell and does not unmount on internal navigation.
- **Retry the transcription.** Every `failed` recording shows "Tentar de novo" (Try again)
  (`RetryTranscription`, `POST .../retranscribe`), without comparing with `recording.owner` (obsolete: the
  account only sees what is its own; a 403/404 shows up through `errorMessage`), with the transient failure
  (`error.retryable`) stated as such; the admin's Health has the same button per recent failure, through the admin retry.
- **Transcription language.** The list of Whisper languages lives in `src/lib/languages.ts` (used
  by the admin and by the user screens, without crossing features) and the selector in
  `shared/LanguageSelect.tsx`; the default always shows named by the actual language ("Padrão do
  servidor: Português", "Padrão da conta: Inglês"), and "Detectar automaticamente" only for `auto`.
  The account has **Idioma da transcrição** (Transcription language) (`GET`/`PATCH /me/transcription`, saves immediately; empty is the
  server default). Import has the **Idioma** (Language) column per file, starting from the account default
  and sent only at upload creation. The recording shows the language in the kicker and, in `RecordingHeader`,
  **Transcrever de novo em…** (Transcribe again in…) (`RetranscribeAction`, in `RetryTranscription.tsx`) for a ready
  or failed recording, with the language dialog and the confirmation of what changes (new revision, manual
  corrections lost, speaker people back, fields, type and summary redone); the 409 becomes "Já há
  uma transcrição em andamento.". All of this lives in on-demand routes and in the modal: the upload engine
  of the initial bundle only gained the `language` field.
- **Agent** (`src/features/agent/`, holetz/eclume#142): `agent.ts` has the hooks over
  `/agent/sessions`; `AgentPage` (`/agente/:sessionId?`, a single route, so the first question
  opens the conversation without remounting the screen) shows the recent conversations at the side (up to 20, with New
  conversation and All conversations), the conversation and the composer with **Anexar** (Attach) (`.txt,.md,.csv,.pdf,.docx`,
  up to 5 per question and 10 MB each, checked before sending) and the attachments of the next question, which
  come off with the ×. With no conversation in the route, the first question or the first attachment creates the conversation,
  seeds its cache empty and swaps the route (`replace`). Each answer polls its own message
  every 2 s until `done` or `failed`; the conversation has a `staleTime` of 1 min, because the screen's mutations
  already update the cache and rereading the conversation in the middle of a question would erase the sent question. The
  generated files and the attachments are `download` links to `GET /agent/files/{id}/content` (same
  origin, cookie session). `ConversationsPage` (`/agente/conversas`) lists all of them by page, with
  Rename (dialog) and Delete (confirmation).
- **Agent skills and actions** (holetz/eclume#145, `features/agent/skills.ts`,
  `SkillsPage.tsx`, `ActionCard.tsx`): `SkillsPage` (`/agente/habilidades`) lists the skills,
  creates and edits them in a dialog (name normalized without a slash and in lowercase, description, instructions and, with
  "Limitar as ferramentas" (Limit the tools), the allowed ones from the `GET /agent/tools` catalog), turns them on, off and deletes them
  with confirmation. In the Agent's composer, the "Habilidade" (Skill) selector lists the enabled ones and sends
  `skill`; a message that starts with `/` goes as it is, because the server reads the prefix. The question
  shows the `/nome` chip. Each proposal of the answer (`AgentMessage.actions`) becomes an `ActionCard`
  (`section` "Ação proposta"): the summary, the state, the first 10 targets with a link (and "e mais N") and
  Confirm/Discard while `proposed`; once confirmed, it polls `GET /agent/actions/{id}` every 2 s
  until it finishes and shows the result per target.
- **Grouped navigation in a single list** (`src/app/nav.ts`): each item has `section` (`main` or
  `header`), `enabled` and, optionally, `matches` (prefixes that also light the item up: the Library
  stays marked on `/gravacoes/`) and `excludes` (prefixes under the item's route that belong to another and do not
  light it up); the common item has `group`, and `navGroups()` returns the two sections.
  **Agent** (`/agente`, holetz/eclume#142; formerly Ask, at `/perguntas`) is the only **featured** item (`featured`, with
  `icon` and no group): it is the first of the list and of the sidebar, `navGroups()` leaves it out and
  `featuredItem()` hands it to `AppShell`, which draws it before the groups as the DS `.btn-primary`
  at full width, with the `MessageSquareText` icon (`aria-hidden`) and `aria-current="page"` on
  `/agente` and in a conversation (`/agente/:sessionId`), but not on `/agente/conversas` nor on `/agente/habilidades` (`excludes`), where it stays in the "pressed" tone (`--color-accent-700`). While the account has no
  recording (the same `GET /recordings` query with `limit=1` as the library, key
  `['recordings', 'any']`), it loses the highlight, not the place: it becomes `.btn-secondary`, still first and
  accessible. The main section, below it, has the **Agente** group (Conversas, at `/agente/conversas`, and
  Habilidades, at `/agente/habilidades`), Gravações (Biblioteca, Busca; importing is the library's
  modal), Organizar, with the account's data (Pessoas, Coleções, Tags), and Regras, with what acts
  by itself after each recording (Processamento automático, Tipos de agenda, Campos
  personalizados); the routes do not change with the group. `header` goes to the header menus:
  Minhas configurações and Ajuda (Central de ajuda). In the gear, each item has its part
  (`part`), in the order **Conta e privacidade** (Conta), **Aparelhos** (App desktop, App móvel),
  **Integrações** (Conexão MCP, Tokens de acesso) and **Ambiente**; `AppShell` opens each part with
  a `{ heading }` of `MenuButton`, a `role="separator"` with `aria-label` and the text in
  `.menu-heading` (`app.css`), which the keyboard does not focus. Nested submenus are not used, for the
  keyboard and touch cost. A new area goes in disabled, with the route of the v6 screen
  map, and enabling it is changing `enabled` and registering the route. There is a single
  `<nav aria-label="Principal">`; each group is a `role="group"` labelled by its title, and the featured item
  stays outside them. There is no "Painel admin" item: the user account has no role, and the panel opens
  at the address `/admin/entrar`, with its own account.
- **Shell header** (`ShellFrame` with `account`): a 3.25rem strip (`--shell-header`),
  fixed at the top at any width, with the brand on the left and the account on the right: name and e-mail, the
  **Ajuda** menu ("Ajuda desta página", which opens the drawer, and "Central de ajuda"), the
  **Configurações** menu (Minhas configurações) and, after a 2px bar, **Sair**. Choosing an
  item navigates without touching the sidebar, which has only the main navigation. Below 56rem, the
  name and the e-mail disappear and the Menu button opens the sidebar on top. Screens that stick elements to the
  top (the library filters, the recording chat) use `top: var(--shell-header)`.
- **Page header** is `PageHead` (the DS `.page-head`: optional kicker, `h1`, actions and, in the
  shell, the Help button); it also sets the tab title (`usePageTitle`), with the outcome watcher's
  counter in front when there is one. An unknown route shows
  `NotFoundPage` inside the shell, with the link back to the library.
- **Help drawer** (`help.ts`, `HelpProvider`, `HelpDrawer`): `HelpProvider`, mounted in
  `AppShell`, opens the `.help-drawer` with `?` (without Ctrl, Meta or Alt, outside `input`, `textarea`,
  `select` and `contenteditable`) or through the `PageHead` Help button, and closes with Esc, returning
  focus to whoever opened it. The page declares its help page key with `useHelpTopic(chave)`, and the body of the
  drawer (loaded on demand) shows the search, the articles of that key and the shortcuts, with the link
  to the center. Articles, keys, search and inline hints:
  [web-central-de-ajuda.md](web-central-de-ajuda.md).
- **TanStack Query keys per area**, with a fixed prefix (`['people', ...]`, `['collections']`,
  `['tags']`, `['recordings', ...]`, `['admin', ...]`): a mutation that changes counts or names
  seen on other screens invalidates the whole prefix, besides writing into the cache what the response
  returned.
- **Administration** (`/admin/*`, `src/features/admin/`) is a **separate app inside the web**, outside
  `RequireSession` and `AppShell`; `/admin/entrar` and `/admin/*` load the panel's chunk on demand,
  and nothing of it goes into the user's initial bundle.
  - **Own session.** `adminSession.ts` has `useAdminMe()` (`GET /admin/me`, key
    `['admin', 'me']`, 401 → `null`), `useAdminLogin()` and `useAdminLogout()` (which clears the whole
    `['admin']` prefix). The guard is `RequireAdmin`: without an admin session, it goes to
    `/admin/entrar?volta=<rota>`; `volta` only applies inside `/admin/`. A 401 on
    `/api/v1/admin/` in the middle of use arrives through `client.ts`'s `onAdminUnauthorized` and returns to
    login. The panel never reads `useMe`, and the user app never reads the admin key. Hiding a link
    is not access control: the boundary is the cookie with path `/api/v1/admin`.
  - **Sign in as admin** (`/admin/entrar`) uses `AuthLayout` in the `admin` variant (the DS `.auth-admin`,
    brand field in ink), without sign-up nor "esqueci a senha": the admin account and password
    live in the CLI (`eclume-server admin create` and `admin set-password`).
  - **Frame** `AdminShell`, over the `ShellFrame` that also serves `AppShell` (fixed sidebar
    and compact menu below 56rem; without `account`, without the app header): brand, "Admin" badge, the "Plataforma" group and, in the
    footer, the admin's name and e-mail with "Sair". The bar comes from `ADMIN_SECTIONS`
    (`sections.ts`), in the order Usuários (`/admin/usuarios`), Pré-processamento de áudio
    (`/admin/audio`), Transcrição (`/admin/transcricao`), Locutores (`/admin/locutores`), Agentes
    (`/admin/agentes`), Tipos de agenda padrão (`/admin/tipos-de-agenda`) and Saúde
    (`/admin/saude`). `/admin` goes to Usuários; the old routes redirect with `replace`:
    `/admin/voz` and `/admin/segredos` → Locutores, `/admin/templates` → Tipos de agenda padrão. An unknown
    route shows "Página não encontrada" inside the panel.
  - **Saving the settings** stays disabled without a change, and each screen sends only its blocks
    in `PATCH /admin/settings` (merge per block), so one screen does not overwrite another.
  - **Write-only secrets**, in `SecretField` (stored, Substituir, Apagar with confirmation; the
    screen never shows part of the value), each next to what uses it: the Hugging Face token in
    Locutores, the shared Anthropic key and each provider's token in Agentes. There is no
    Segredos screen.
  - **Turning voice identification off asks for confirmation** (`ConfirmDialog`) before the `PATCH`,
    because the server deletes the platform's voiceprints at that moment.
  - **Notice of data leaving the server** (`ExternalDataNotice`, `.alert-warning` with `role="note"`):
    in Agentes (agent purposes) and in Transcrição (the remote engine), read from `GET /privacy`,
    it says what leaves and to whom and that users see this in Conta › Privacidade e dados and at
    sign-up. It rereads when the settings change (`usePrivacy(revision)`); with no external destination, nothing
    shows.
  - **Health rereads every 15 s** (`HEALTH_REFRESH_MS`, aligned with the worker heartbeat), only with the
    tab visible (`refetchIntervalInBackground: false`), and keeps the last data on an error.
  - **No panel screen shows user content**: no recording title, no file
    name, no link to `/gravacoes`. Usuários shows name, e-mail, sign-up, recording count
    and state; Health's failures show step and code.
  - **Generate password link** (Usuários, only on active accounts): the dialog asks to confirm who is asking,
    `POST /admin/users/{id}/password-reset` and, on the response, shows the link a single time with
    `CopyValue` and the guidance to deliver it out of band; closing the dialog discards the link.

  The server rules are in [server-admin.md](server-admin.md).
- **Public routes:** `/entrar`, `/cadastro`, `/redefinir-senha`, `/parear` and `/admin/entrar`. Create account (`SignupPage`) reads
  from `GET /auth/signup` whether sign-up is open and the notice in force, asks for name, e-mail, a password of
  12+ (`MIN_PASSWORD`, the contract's `minLength`) and the mandatory acceptance of the notice, and sends the
  accepted `notice_version`. **Criar conta** stays always enabled: submitting with something missing does not call the API,
  shows in the `role=alert` what is missing, in the form's order ("Para criar a conta, falta o nome, o
  e-mail, a senha com 12 caracteres e o aceite do aviso."), focuses the first pending field and links the
  summary to the button through `aria-describedby`; the list follows the filling in; the response opens the session, like login. `email_taken` becomes "Já existe
  uma conta com este e-mail."; closed sign-up (`open: false` or `signup_closed`) shows the notice
  in place of the form. Before the acceptance, when the summaries or the chat leave the server
  (`GET /privacy`, `location: external`), a line says which and to whom ("Neste servidor, os
  resumos e o chat são feitos fora dele, por Anthropic…"); with no external destination, nothing shows. The
  sign-in title (`AuthLayout`, `user` variant) is "Cada palavra, guardada no seu servidor.":
  the audio and the transcript stay stored in it, without promising that nothing leaves (holetz/eclume#116; the
  final form comes out of Claude Design).
- **Forgotten password:** the sign-in says "Esqueceu a senha? Peça um link a quem administra o
  servidor." (the server sends no e-mail). `ResetPasswordPage` (`/redefinir-senha#<segredo>`, outside
  `RequireSession`) reads the secret from the fragment on mount, before any redirect, and
  sends it in the body of `POST /auth/password-reset/check` (shows the account's e-mail) and of
  `POST /auth/password-reset` (new password twice, 12+). Without a secret or with
  `invalid_reset_link`, it shows "Este link venceu ou já foi usado. Peça outro a quem administra o
  servidor." in place of the form. Once reset, it rereads the session and leads to `/entrar` with the notice
  "Senha redefinida. Entre com a nova." through `state`, like the deleted account.
- **Acceptance of the notice in force:** with `notice_required: true` in `/me`, `RequireSession` shows
  `NoticePage` (in `.auth`) in place of the shell, until `POST /me/notice` with the version read from
  `GET /auth/signup`.
- **Server state with TanStack Query.** Waiting polling is declarative and has a single rhythm
  (`app/polling.ts`, `pollWhile(estáEsperando, inicial)`): the initial interval (2–3 s) in the
  first 2 min of waiting, then doubling every minute up to 30 s, and nothing with the query in
  `error`; coming back to the tab or the network coming back restart from the initial one. It applies to recording, summary,
  recording chat, base chat, preview and link code. Three reads have their own
  rhythm (holetz/eclume#153), all with exponential backoff (`backoffDelay`, `app/polling.ts`):
  the **library** (period and list) keeps `pollDelay` (3 s at the start, up to 30 s), but with a
  recording in progress it reads only `GET /recordings?since=` (the cache's greatest `updated_at` minus
  `SINCE_MARGIN_MS`, 60 s, with the same `from`/`to`/filters) and merges by id into the cache with
  `setQueryData` — in the period the new ones also come in, in the list only those already there; the full
  reread is left for focus, the network coming back and every `FULL_EVERY` (20) incremental reads
  (which catches the deleted recording); the **admin Health** starts from `HEALTH_REFRESH_MS` (15 s) and doubles on
  each read without change up to `HEALTH_MAX_REFRESH_MS` (60 s), comparing the data without clock,
  latency and GPU use (`backoffWhileUnchanged`), restarting on a change, on coming back to the tab
  (which also rereads right away) or to the network; the **connection banner** tries `/me` every `RETRY_MS` (10 s)
  doubling on each failure up to `RETRY_MAX_MS` (60 s). The global default is `refetchOnWindowFocus: false`; the
  recordings (period, list, recording), the summary state and the chat history turn rereading
  on focus on, so a recording from the desktop or the phone shows up without reloading. Forms
  (Fields, Agenda types, Account) are not reread under whoever is editing. Mutations write into the cache what the response
  returns, without redoing the read.
- **A `.tsx` file exports only components** (react-refresh rule): hooks, constants and
  pure functions live in a `.ts` beside it. **Never with the same name in a different case**
  (`Pipeline.tsx` and `pipeline.ts`): on Windows the file system does not distinguish case, and Vite
  resolves `./Pipeline` to `pipeline.ts`; the pure module gets another name (`steps.ts`).
- **Shared DS pieces** in `src/app/`: `Dialog` (`.dialog-backdrop` in a portal, focus on the
  first control, Tab trapped, Esc and a click on the backdrop close it, scroll locked, focus returned;
  `kicker` puts the header with Close; the text of a confirmation goes in `message`, in
  `.dialog-body`, and a form, table or alert goes in `children` with `plain`, outside the muted style;
  with a dialog open, the help drawer neither opens nor closes by shortcut),
  `ConfirmDialog` (Cancel first, confirmation in `btn-danger`, busy during the mutation),
  `MenuButton` (`.menu` with the ARIA menu keyboard: arrows, Home/End, Enter/Space, Esc, click
  outside; the focused item carries `data-active`), `CopyValue` (`.code-block` with Copy and the notice in
  `role=status`; `size="lg"` for the link code) and `HelpHint` (the inline `?` with the
  popover and the link to the article; Esc closes only it).

## Visuals and accessibility

- The visual base is the eclume Design System ([web-design-system.md](web-design-system.md)):
  tokens and classes of `eclume.css`, Archivo and IBM Plex Mono fonts served by the build, Lucide
  icons and theme by `data-theme` on `<html>` ("Do sistema" resolves `prefers-color-scheme`; the
  explicit choice stays in `localStorage`). A new color goes in as a token in the DS. The Ambiente screen
  adds `data-density="compact"` (the `--space-3` to `--space-8` scale tightened in `app.css`) and
  `data-motion="reduce"` (the same rules as `prefers-reduced-motion`), applied at boot by
  `applyEnvironment()`.
- The access screens use `AuthLayout` (the DS `.auth`: brand field and form aligned to the
  left); the rest lives in `AppShell` (`.shell`, `.sidebar`, `.main`), with the top bar and the
  compact menu below 56rem.
- CSS Modules per component, only with what the DS lacks. No CSS framework and no external
  font.
- Every action reachable by keyboard, visible focus, skip link, labels on every field,
  `aria-live` on progress and confirmations. State never by color alone: the badge has text.
- **Shared state vocabulary** (`src/lib/vocabulario.js`, a pure ES module with
  `vocabulario.d.ts`): the pt-BR names of the device states, of the recording states on the
  server ("Na fila" only for the wait for transcription; "Cancelada" for the `failed` recording with a
  step skipped by `cancelled`; "Aguardando locutores", in a warning tone, for the `speakers` step in
  `waiting`), of the seven steps in the order of `STEPS` (the `waiting` state is "aguardando você") and the
  text of each reason code (`MOTIVOS`). It is the single source: the desktop and the phone have byte-for-byte copies, checked by
  a test in each client, and `vocabulario.test.ts` fails when the server writes a reason code
  without text. No screen writes these labels by hand.
- **Reason in visible text, never only in `title`.** A skipped or failed step, a row that
  failed in Import or in the desktop queue show the reason as text on the screen; `title` may repeat it,
  never be its only carrier.
- An unknown enum in the response shows raw, without breaking the screen (the contract only grows).

## Library timeline

The home screen (`/`, `src/features/library/`) is a calendar (frame "Library · week", variant A):

- **Three views in the `.seg`**: Week (`.cal-week`, default), Month (`.cal-month`, up to three `.cal-dot`
  per day and "+N"; the day number opens its week) and List (`.day-group` with `.rec-row`, from the most
  recent, "Carregar mais"). Below 56rem, without `visao` in the URL, it opens on the List, and the week scrolls
  sideways inside its own container (`min-width: 720px`).
- **Position by time and duration** (`calendar.ts`, local browser dates): the week runs from
  Monday 00:00 to the following Monday; each recording gets `--s` (local start time) and `--d`
  (duration in hours, 0.1 for a note or a null duration, cut at midnight). The grid shows the whole
  day (0–24, with a label also at 24:00) and scrolls inside, with the height left in the window and
  the day header fixed. Working hours (`readWorkHours()`, 8–18 or the one from the Ambiente screen) have a surface background and labels
  in the main ink, and the week always opens with the zoom framing them; the rest of the day is a
  pan or a zoom out away. Overlapping recordings on the same day split the column
  into lanes (`lanes()`, greedy by start), which the DS does not handle.
- **Week zoom**: the corner buttons over the hours and Ctrl + wheel over the grid change
  `--cal-hour` in steps of 1.25×, keeping the hour under the cursor still (or in the middle, through the buttons).
  The minimum is the whole day in the grid height, the maximum 480px per hour. In the month, the weeks split
  the screen height equally (minimum of 96px per cell).
- **State in words** (`recordingState()`, from `status` and the `pipeline`): failed (danger
  rule), in progress with the current step ("Resumindo", "Transcrevendo", "Na fila"...) or ready
  (with "Sem resumo" when the summary step failed). A voice note has the dotted rule;
  markers show as `.marker-count`. The event's `aria-label` says everything:
  "Reunião de equipe, 09:00, 58 min, Resumindo, 3 marcadores".
- **Query** (`queries.ts`): the period goes in `GET /recordings` with `from`, `to`,
  `sort=recorded_asc` and `limit=200`, following the cursor up to 5 pages ("Mostrando as primeiras 1000
  gravações deste período"); the List uses `sort=recorded_desc` and `limit=50`. Both reread every
  3 s while some recording is in progress, reading only what changed (`?since=`, see
  "Server state with TanStack Query").
- **Filter panel** on the right (`.with-filters` and `.filters`, collapsible down to 48px): Type,
  Precisam de você ("Aguardando locutores", `precisa=locutores` in the URL, which becomes
  `awaiting=speakers`), Status, Tags, People (the inline `PersonCombobox`), Participants (company, department and person
  tag, with the values of `GET /people/facets`; `empresa`, `area` and `tag-pessoa` in the URL, which
  become `person_company`, `person_department` and `person_tag`, and apply to one same person),
  Collections (with "Gerenciar coleções") and one group per user-defined field (choice as `.check`, text and list as "Qualquer valor",
  applied on Enter or on leaving). The filters go in the URL (see the routes) and become the repeatable
  filters of `GET /recordings`; `STATUS_GROUPS` maps Status to the `status` enum (Pronta =
  `transcribed`, Processando = `uploading`/`queued`/`processing`, Falhou = `failed`). A group with
  everything checked does not send the parameter, and the last checked one cannot be unchecked. Below 56rem, the panel is a
  `Dialog` opened by "Filtros (N)".
- **"Precisam de você" notice** (holetz/eclume#144): with `GET /me/speaker-naming` reporting
  `waiting_count > 0`, an `alert-warning` strip above the bar counts the recordings waiting for
  you to name the speakers; "Ver" turns the filter on in the list. It disappears with the filter already on.
- **Persistence** (`src/app/storage.ts`, `localStorage` with `try/catch`): the panel remembers whether it is
  collapsed (`eclume-biblioteca-filtros-recolhidos`) and the library, the last query string without
  `importar` (`eclume-biblioteca-ultima:<user_id>`, per account, because it holds person, tag,
  collection and field ids; the old global key goes away on the first read). The other preferences
  (density, motion, columns, working hours, collapsed panel) are per device. "Limpar filtros"
  removes everything except `visao` and `data`.
- **Restoration only once**: when `/` opens without parameters, the page goes back to the last stored
  library (or opens on the view of the Ambiente screen) through a `replace`, and the `restoring` flag drops as soon as
  the restored URL arrives. After that, checking and unchecking filters, switching the view and walking through the
  dates are just navigation: `useSearchParams`'s `setParams` changes identity on every change of the
  URL, so a restoration without that lock runs again on every filter and undoes it (with the "última"
  opening it even alternates with writing the stored one, in a loop). The flag drops in the render itself, and
  not in an effect, because the lint (`react-hooks/set-state-in-effect`) forbids a synchronous `setState` in an
  effect. Outside restoration, the stored one follows the URL, and an empty URL **deletes** it: removing the
  last filter does not resurrect it on the next visit.
- **States**: loading (grid with `aria-busy` and "Carregando gravações…"), error with "Tentar de
  novo", "Nada gravado neste período." and, in an account without any recording (`GET /recordings` with
  `limit=1`), the "Nenhuma gravação ainda" card, which teaches the real paths: importing, the desktop
  app, the phone app (`/app-movel`) and the agenda type that gives title and summary. The
  `alert-info` strip "Enviando 1 de 3 arquivos · Abrir" follows the import queue.
- **First steps** (`FirstSteps`): a card at the top of the library while there is a pending step, with
  three derived steps, without a new contract: (1) bring the first recording (the account has a recording,
  `useHasAnyRecording`, in `library/anyRecording.ts`, its own module so the shell does not pull the library queries into the initial JS), with import, desktop app and phone app; (2) check the agenda types
  (opening `/config/agendas` in this browser writes `eclume-tipos-de-agenda-visto`); (3) link a
  speaker to a person (the account has a person, `GET /people` with `limit=1`, `useHasAnyPerson`). Each
  step done gets the check and "(feito)" for screen readers; with the three done the card disappears
  by itself, and **Dispensar** writes `eclume-primeiros-passos-dispensado`. Both keys belong to this
  browser, like the Ambiente preferences, and "Restaurar os padrões" deletes them.

## Import: modal and queue

- **Import is a library modal** (`ImportDialog`, variant A): `/?importar=1` opens it, and the
  old route `/importar` redirects there. The modal (and the converter it pulls) loads on
  demand. It has the `.dropzone` and the `.table` with File (name and size), **Início da gravação**
  (`datetime-local` with the origin below: "Dos metadados do arquivo", "Sem data no arquivo · usando
  a data de modificação, confira" in the warning tone, or "Editada por você"), Duration, Status and
  remove/cancel. "Enviar N arquivos" stays disabled while there is a read or an empty date.
- **The date comes from the metadata, read before the conversion** (`readRecordedAt`,
  [formato-audio-upload.md](formato-audio-upload.md)). The upload sends `recorded_at` and
  `recorded_at_source` (`file_metadata` without editing; `user` when edited or coming from the fallback) and
  does not send `title`.
- **The queue lives in the shell** (`ImportProvider` wrapping the `ShellFrame` of `AppShell`, `useImportQueue`, `importContext.ts`):
  closing the modal or navigating does not lose the upload. The files are converted and uploaded **one at a
  time**; cancelling aborts and deletes the upload; "Tentar de novo" resumes through `uploadId` or reconverts.
  The queue keeps the items in a ref, the source of truth of the upload loop, and the state only mirrors the ref
  (the loop does not wait for React to render). While there is a conversion or an upload, `beforeunload` warns,
  and "Sair" asks for confirmation ("O envio em andamento será interrompido.").
  Once an upload finishes, the library is reread (`['recordings']`).

## Recording page

`/gravacoes/:id` is centered on the summary (frames "Recording", "transcript with markers" and "editing the
summary", variants A), at full width with the chat in a 340px column (below 72rem the chat
moves down; below 56rem, the fields too):

- **Header** (`RecordingHeader`): "← Biblioteca" goes back to the URL the person came from
  (`location.state.from`, set by the calendar, list and search links); the kicker states
  date, time and duration ("· data do envio" when `recorded_at_source` is `upload`); **Exportar** is
  a `MenuButton` (TXT, SRT, MD — disabled without a summary — and DOCX) that downloads through the API client
  (`parseAs: 'blob'`, name from `Content-Disposition`) and shows the `Problem` in an alert; a 401 on
  export ends the session like any other call; **Excluir** asks for confirmation, removes the recording from the cache, rereads the library and
  goes back with "Gravação excluída.".
- **Pipeline** (`Pipeline.tsx`, labels in `steps.ts` through the vocabulary): the seven steps in the
  `ol.pipeline`, each with its state in words when it is not completed ("Resumo · pulada"), the
  "Motivos das etapas" list under the bar with the reason of each skipped, waiting or failed step, the worker's progress with the
  transcription in progress and `RetryTranscription` on a failure. The recording rereads at the rhythm of
  `pollWhile` (3 s at the start) while it is in progress or awaiting speakers, and a fields, type or summary step that finishes rereads fields and summary.
- **Awaiting speakers** (`AwaitingSpeakers.tsx`, holetz/eclume#144): with the `speakers` step in
  `waiting`, `Pipeline` shows an `alert-warning` (`role="status"`) that leads to `#locutores` and
  offers **Seguir sem nomear** (`ConfirmDialog`, `POST /recordings/{id}/continue`). Linking or
  merging a speaker in the panel changes the cached transcript; the notice notices the change of the links and rereads
  the recording, which the server already released if the last one got a person. The notice stays in `Pipeline`, not in
  the `children` of `SpeakersDisclosure`: stopped and waiting, `RecordingPage` opens the Speakers block
  by itself, and a `hashchange` to `#locutores` reopens it if the person collapsed it.
- **The waiting line** (holetz/eclume#117): with the recording `queued`, `Pipeline` shows in
  `role="status"` the sentence from `fraseDaEspera(job.queue)` of the shared vocabulary — position and
  estimated start ("3ª na fila · começa em cerca de 12 min (estimativa)"), the account's own recordings
  ahead, the time at which the minutes window frees up or "O processador está fora do ar desde
  14:02; sua gravação está guardada e entra quando ele voltar". Without `queue` (an earlier server),
  "Aguardando a vez na fila de transcrição.". The forecast is always labelled as an estimate; the
  library card keeps "Na fila". The texts are provisional until the visual reference of
  holetz/eclume#117 (task 1.1).
- **Shared playback** (`PlaybackProvider`, `playback.ts`): a single `<audio>` links the
  compact player (play, track with `range` for the keyboard, one `.player-tick` per marker, the
  speed 1×–2×), the `.marker-bar` (a chip per marker, which plays from there, and "Marcado no
  <dispositivo>" when there is only one) and the segments. The `src` is `/recordings/{id}/audio`, which answers 302
  to a 1 h signed URL: on the `<audio>`'s `error`, the provider swaps the `src`
  (`?renovacao=<n>`, so as not to reuse the 302), goes back to the same instant and speed on
  `loadedmetadata` and resumes playing if it was playing, once by itself (again after playing resumes);
  the second failure exposes `error` in the context and the player shows "O áudio não carregou" with "Tentar de
  novo", with play disabled. An error before the first load in a browser whose
  `canPlayType('audio/ogg; codecs=opus')` is empty becomes the notice that it does not play Ogg Opus.
  **The instant does not go through the context**: it stays in a store (`PlaybackClock`, written on `timeupdate`
  and on `seek`), read by `usePlaybackTime()` (the player) or by `usePlaybackSelect(seletor)`, which only
  renders when the selected primitive value changes (the active segment). The context carries duration,
  playing, speed, error and commands, and only changes when one of them changes: the `.marker-bar` and whoever only
  commands do not render per tick. **The player stays fixed** (`position: sticky` below
  `--shell-header`, over `--color-bg`, without the `.marker-bar`): pausing is one click away at any
  point of the page, including while reading the summary (holetz/eclume#143).
- **Speakers** (`SpeakersDisclosure`, its own `details.disclosure`, closed, between the `.marker-bar`
  and the transcript): collapsed, the summary shows each speaker inline, horizontally, in the `.speaker`
  of its color; open, `SpeakersPanel` (region "Locutores", `id="locutores"`) brings one card per
  speaker in a grid (`repeat(auto-fill, minmax(15rem, 1fr))`, `--color-surface` background) with
  rename, link person, voice suggestions and, below the grid, merge. Being open is state of
  `RecordingPage`, and the component's `children` is the place for a notice about the speakers, before the
  cards. The speakers do not show inside the transcript nor in the fields panel.
- **Collapsed transcript** (`TranscriptDisclosure`, closed `details.disclosure`): the summary states
  speakers, segments and markers; open, it has "Acompanhar o áudio" and the segments in the DS `.segment`, with the `.segment-marker` before the
  first segment that starts at the marker (`placeMarkers`), edit the note (up to 500) and delete the
  marker. The segments only render with it open. With `?t=<ms>`, it opens by itself, positions the audio
  without playing and, **once**, brings the list into the window (`scrollIntoView` with `block: 'nearest'` on the
  container, never on the segment) and centers on it the segment of the instant, regardless of following.
  - **Own scroll area** (holetz/eclume#143): the segment list (`role="list"` "Falas") is the
    container that scrolls, lower than the window (`max-height: min(28rem, 55vh)`, `overflow-y:
    auto`, `overscroll-behavior: contain`). `?t=` and following scroll only it, through the `scrollTop`
    of `scrollTopFor` (`scroll.ts`: `nearest` with a 16 px margin, or `center`) applied with
    `scrollTo`; `scrollIntoView` on a segment is forbidden, because it scrolls every ancestor, the window
    included, and took the player off the screen. The list needs no `tabIndex`: the segments' buttons
    make it reachable by keyboard.
  - **Long transcript.** Each segment is a memoized `SegmentRow` with stable props (speaker name and color
    and markers by index come out of `useMemo` maps per transcript; `active` and
    `editing` booleans; `seek` and `setEditingId` as callbacks), and the active segment comes from
    `usePlaybackSelect` with `findSegmentAt` (binary search): a tick without a change renders zero
    segments and a change renders two. The segment item has `content-visibility: auto` with
    `contain-intrinsic-size: auto 5.5rem` in the CSS Module: off screen it is not painted, but it stays in the
    DOM, also inside the scroll area. Virtualization was discarded: the browser's Ctrl+F and
    the screen reader need the segments in the DOM.
  - **"Acompanhar o áudio"** (on by default) scrolls the list internally on every segment change, with
    `smooth`, whether it is in the window or not: the page never moves, and whoever comes back to the list finds it on the
    right segment. Off, nothing scrolls.
  - **The measurement is a contract**: `TranscriptDisclosure.test.tsx` counts renders over 3,000 segments (0 per
    tick without a change, 2 on a change, the `.marker-bar` none), and `TranscriptDisclosure.browser.test.tsx`
    (`npm run test:browser`, on the host) measures the commit through `React.Profiler`: median of 20
    ticks below 8 ms without a change and 16 ms with a change. `TranscriptDisclosure.test.tsx` also
    proves that `?t=` and following call `scrollTo` on the list and never `scrollIntoView` on a segment,
    and the E2E proves, with 3,000 segments and the audio advancing, that `scrollY` stays still and pausing works in the window.
- **Summary document** (`SummaryDoc`, `summary.ts`): the `SummaryState` (current, generated
  reference and generation in progress, reread at the rhythm of `pollWhile` while pending) with the `.doc-bar` (type,
  origin and version; Copy with title, Edit, Compare with the generated one, Regenerate, Change type and
  Delete summary; the type badge is the summary's snapshot and only becomes a link, "ajustar o modelo deste
  tipo" to `/config/agendas?tipo=`, if the type still exists in `GET /agenda-types`) and the Markdown through `react-markdown`, without raw HTML. Without an agenda type, generating asks for
  one ("Escolha um tipo de agenda para gerar o resumo."). Without a summary agent (step `skipped` with
  `no_provider`), it says "Sem resumo: nenhum agente configurado; fale com quem administra." and swaps the
  primary "Gerar resumo" for a secondary "Tentar de novo"; the `provider_id` 422 becomes the same
  sentence, never raw.
  **Regenerate** generates another version through the recording's type (`POST /transcripts/{id}/summaries` without
  `agenda_type_id`) and always confirms first, because the new version becomes the current one and a manual
  edit stops being the one shown, although it stays stored; it stays disabled while a generation is in
  progress and, without a type, opens the change-type dialog. **Copy with title** puts on the
  clipboard `text/html` and `text/plain` (`copy-summary.ts`, the same `react-markdown`, loaded
  on demand): the recording's title and the section titles come out in bold, without `#`, because Teams does not
  keep the heading style on paste; without `ClipboardItem` it falls back to the text without the headings' hashes.
  The `ClipboardItem` is born still within the click, with the content as a `Blob` promise, because Safari
  refuses a clipboard write started after an `await`.
- **Editing** (`SummaryEditor`): the Markdown in a `textarea` in the `.doc` typography, saved with
  `base_version` = the opened version. The 409 `summary_changed` keeps the draft and offers "Ver a
  versão N" (the comparison of the draft with the new one) and "Salvar sobre a versão N". "Voltar à gerada"
  asks for confirmation. The draft survives a tab reload (`summaryDraft.ts`): it stays in
  `sessionStorage` in `eclume-resumo-rascunho:<recording_id>`, with the `base_version`, written ~500 ms
  after the last keystroke; on reopening the editor, it comes back directly if the base is the opened version and with the
  conflict notice if the base fell behind. Saving, discarding (through Cancel or the leave
  guard) and going back to the generated one delete the stored draft. Leaving the recording with a draft asks
  "Descartar a edição?" (the leave guard). **Compare** is a client-side line diff (`summary-diff.ts`, LCS), with
  `<del>`/`<ins>` and the −/+ sign for whoever does not see color.
- **Fields** (`FieldsPanel`, `fields.ts`, component "Filled fields" variant A): title and tags
  first, then the user's fields, with the origin badge (Automático dashed, Editado
  solid, accepted without a badge), Accept, Accept all and Edit by type (text up to 300, list by
  comma, choice with "Nenhum"); the agenda type with Change; the collections (with "Nova coleção…");
  and, when there are any, the "Dados anteriores" of the old `metadata`, read-only (the speakers stay in their
  block, above the transcript). Each field has **Editar a regra**, which leads
  to the rule's owner: the custom field to `/config/campos?campo=`, the title to the recording's type
  (`/config/agendas?tipo=`) and the tags to `/tags`.
- **"Ajustar o resumo" chat** (`ChatPanel`, `chat.ts`): the history in `role=log`, with one
  `.msg-note` per agent read ("Leu a transcrição, 00:03:20–00:04:20", "Buscou “orçamento”
  na transcrição · 3 trechos"); sending receives the 202 with the two messages, and the answer is
  polled at the rhythm of `pollWhile` (2 s at the start) until `done` or `failed`. The composer waits with an open request (and on the
  409 `chat_busy`) and without a current summary. After the last adjustment that changed the summary (`done` with
  `summary_id`), with the recording in a type, the panel offers **Levar este pedido para as instruções do
  tipo**: it opens `/config/agendas?tipo=` with the request in the navigation `state`
  (`InstructionsRequestState`, in `organize/queries.ts` so the feature graph stays without a cycle), and `AgendaTypeEditor` appends it to the end of the draft of the
  summary instructions, with a `role=status` explaining, without saving; the dirty draft stays under
  "Descartar alterações?" and the leave guard.

## People, search and collections

- **Opening the recording at an instant** is the link `/gravacoes/:id?t=<ms>`: the page opens the transcript,
  highlights the segment at that instant, scrolls to it and positions the audio (without playing, per the
  autoplay policy). Search and the person page generate the link with `recordingAt()`.
- **Search** (`/busca`, frame "Search"): the terms bar and a second `.toolbar` with the chips
  (`FilterChip`: `tag-neutral`, or `tag-accent` when active, with "Rótulo: valor" and a popover in the style of
  `.menu`) for Period (any, last 7 or 30 days, this year, range), Person, Tag, Collection and
  one per user-defined field; "Limpar" removes everything except the terms. The hits come out grouped by
  recording (`group.ts`): only consecutive ones from the same transcript are joined, so the ranking stays
  as it came; the total says "7 trechos em 3 gravações" (with "ou mais" when there is another page).
- **Search `highlight` never becomes `innerHTML`.** `parseHighlight()` splits the text into marked
  and unmarked pieces, undoes the escaping and React renders plain text inside `<mark>`.
- **Search dates** are local days: `de` becomes the start of the day and `ate` the start of the following day
  (`to` is exclusive in the contract); the quick period becomes only `from`, at local midnight.
- **Linking a speaker to a person** uses `PersonCombobox`: an ARIA 1.2 combobox with a popup list (arrows,
  Enter, Esc, `aria-activedescendant`), directory search by prefix and the option "Cadastrar
  “nome”" when nobody has that name. Without `onCancel`, the combobox stays inline (library and search
  filters): without autofocus, a text-only list and no creation. Each pending voice
  suggestion shows as "Parece ser <pessoa> — NN%", with Accept and Decline; it is never applied
  by itself.
- **People** (`/pessoas`) is the DS `table.table` with search in `?q=`, inline creation in the
  first row (name and company, with the companies in use in a `datalist`; Enter submits, and the error
  shows in the row) and the columns the user chooses in the **Colunas** button (a popover with one
  `.check` per column: company, department, role, tags, e-mail, phone, recordings, voice samples and
  last recording). The name is fixed; the default hides e-mail, phone, role and last recording, and the
  choice stays in `eclume-pessoas-colunas` (`features/people/columns.ts`). The **person**
  (`/pessoas/:id`) shows role · department · company, the person tags and the contacts, has Edit (the
  whole record; company and department suggest the values of `GET /people/facets`) and Delete in a
  `Dialog`, three `.stat` (recordings, speaking time, voice samples) and the tabs Recordings, Segments and Voice samples, with the chosen one in `?aba=`.
- **Voice** ([identificacao-por-voz.md](identificacao-por-voz.md)): the Voice samples tab lists the
  samples and has "Esquecer a voz", with confirmation; there is no per-person consent, which the acceptance
  of the notice at sign-up replaces. The admin turns identification on and adjusts the threshold in Locutores
  (`/admin/locutores`).
- **Custom fields** (`/config/campos`) and **Agenda types** (`/config/agendas`) use the DS `.split`:
  a list on the left (selection in `?campo=`/`?tipo=`, `novo` for the draft) and a panel on the
  right. Switching items with changes asks "Descartar alterações?", and so does leaving the route (the
  leave guard, with the browser's warning on closing the tab). Custom
  fields does not list the built-in title (the title comes from the agenda type) and shows the tags
  as built-in (fixed type, no delete); the list's "Automático" `.switch` saves immediately. In Agenda
  types, the fallback type (`fallback`) stays at the top with the "Padrão" `.badge`, without Delete and without
  "Como identificar"; every type has "Como escrever o assunto" (`title_instructions`), and the
  preview sends the edited type's `agenda_type_id` and says when the fallback type would apply.
- **Preview by polling the job** (`organize/usePreview.ts`): "Testar numa gravação"
  (`POST /fields/preview`, without `recording_ids`: the last 3 transcribed) and "Pré-visualizar numa
  gravação" (`POST /agenda-types/preview`) return 202 with the job, and the screen polls
  `GET /previews/{id}` at the rhythm of `pollWhile` (2 s at the start) until `done` or `failed`; 404 becomes expired, and a new request
  discards the previous one. Nothing is saved, and the type preview disappears when the draft changes.
- **Collections coexist with tags**: the collection groups recordings; the tag marks subjects. It shows in the
  recording's fields panel, in the library filter (`colecao`) and in a search chip, and
  `/colecoes` lives in Organizar, as decided in holetz/eclume#38.
- **Auto collections** (`/colecoes`): the collection dialog has "Quando incluir" (the rule, with the
  `HelpHint` and a `<details>` "Exemplos de regras", each with "Usar", which copies into the field) and the
  `.switch` "Incluir automaticamente depois da transcrição"; the row shows the `.badge`
  "Automática" when there is a rule and the switch is on. "Mesclar em…" (with two or more collections)
  opens a `Dialog` with the `<select>` of the receiving collection and sends `POST /collections/{id}/merge`.
- **Empty states that teach the real path**, in the tone of the Tags empty state: Collections says that recordings
  come in through the recording page or by themselves through the rule in "Quando incluir"; People, that people
  are born when linking a speaker in the transcript or are created in the creation row; Custom
  fields gives an example field with its rule ("Cliente", "A empresa cliente citada na
  reunião; vazio se nenhuma for citada").
- **Tags** (`/tags`, in Organizar after Collections): the settings card saves immediately the
  automatic `.switch`, the mode (`.seg`: "Só as tags cadastradas" or "O agente pode criar tags")
  and the limit of new tags per recording, and the general rule with Save (`PATCH /me/tag-assignment`); the
  list shows the description, the count, "Ver gravações" (`/?tag=`) and the `.badge` "Criada pelo
  agente", with New tag, Edit (409 `tag_exists` suggests merging), "Mesclar em…" and Delete in a
  `Dialog`. "Campos personalizados" lists only the user's fields: the title comes from the agenda types
  and the tags, from this screen.
- **Automatic processing** (`/config/automacao`, `automation/AutomationPage.tsx`, its own folder so as not to create a cycle between `people` and `organize`, help key
  `automacao`, first item of Regras): the overview, in the pipeline order of
  [processamento-automatico.md](processamento-automatico.md), of what happens by itself after
  each recording, in an `<ol class="list">` of `.list-row`: preprocessing and transcription (of the
  platform, without a link), speakers by voice (`/me/voice-assignment`, "Voz: liga sozinho a partir
  de 75%"), speaker naming (`/me/speaker-naming`, the only row with the switch on the screen
  itself: the `Switch` "Exigir a marcação dos locutores", and the state "Não exigida", "Exigida" or
  "Exigida · N gravações esperando você"), agenda type (`/agenda-types`), custom fields (`/fields`, only the user's
  with `auto_fill`), tags (`/me/tag-assignment`, "Tags: só as cadastradas (N)"), collections with a
  rule (`/collections` with `auto_assign`) and summary (types with `summary_instructions`). Each step
  shows its state and a "Configurar" link (labelled by the destination screen); the page only reads, and the
  switches stay in `TagAssignmentCard`, in `AutoAssignCard` and in the collection's rule. The failure of
  a query shows only in its step. Fields, Tags, People and Collections point to it in their
  opening text, and Custom fields and Agenda types use the "Regras" kicker.

## My settings

- **Account** (`/config/conta`, the first item of the gear): the name and the e-mail, the "Trocar a
  senha" panel (current, new and repeat; a different repeat and a short password do not submit, and a wrong current
  password shows in the field; the `.check` "Encerrar também aparelhos e tokens", checked by
  default, sends `revoke_tokens`) and the "Excluir a conta" danger zone, with the `.alert-error` of what
  is deleted and a `Dialog` that only enables "Excluir minha conta" with the password and the `.check` "Entendo
  que tudo será apagado para sempre". Once deleted, the app clears the cache and goes back to `/entrar` with the notice
  in `state`, which the sign-in screen shows. Between the data and the password, the **Privacidade e
  dados** panel lists, generated from `GET /privacy` (`app/privacy.ts`, `usePrivacy`, without an infinite
  `staleTime`), where the audio and the transcript are kept and the destination of each purpose ("Neste servidor",
  "Na rede local", "Fora do servidor: <quem>", "Desligado: nada é enviado"), and, from
  `/me/voice-assignment`, how many people have a voiceprint and how many samples the account keeps.
  With voice turned on in the platform, the "Guardar amostras de voz desta conta" switch; turning it off asks for
  confirmation (`ConfirmDialog`, "Apagar e deixar de guardar") before the `PATCH keep_samples: false`.
- **Ambiente** (`/config/ambiente`, `features/environment/`, help key `ambiente`) keeps this
  browser's preferences in `localStorage` (`app/preferences.ts`), without account or server:
  theme (`theme.ts`), density (comfortable or compact), motion (follow the system or reduce),
  working hours (start and end on the hour, default 8–18, with the end always after the start), the
  view the library opens on without parameters (last used, week, month or list) and the list of
  keyboard shortcuts, and the browser notification (below). "Restaurar os padrões" deletes everything and returns the
  theme to the system's. Each default value deletes its own key instead of writing it.
- **Outcome watcher** (`app/processingWatch.ts`, holetz/eclume#118, rhythm in
  holetz/eclume#153): mounted in `AppShell` (only with a session), it reads every 30 s (`WATCH_MS`)
  `GET /recordings?since=` (every page) — **only with the tab visible and in one tab at a time**: the visible
  tab requests the `eclume-processing-watch` lock (Web Locks, `WATCH_LOCK`) and holds it until it hides or
  closes, when it passes to the next visible tab; without `navigator.locks`, each visible tab reads its
  own. On reappearing, the tab reads right away and the watermark recovers what finished while it was
  hidden (the notice arrives on coming back, not during). It applies the
  outcome rule and the watermark of the desktop
  ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md#processing-end-notice)), with
  the same test cases: summary ready, summary that failed, ready without a summary (reason through the
  vocabulary's `motivo()`), transcription that failed and, since 2.22.0, "Precisa de você" (step
  `speakers` in `waiting`, instant = the wait's `finished_at`); cancelling and `summary_deleted` do not notify. The
  mark lives in the tab's memory and starts at mount: refreshing or reopening the browser does not fire an
  old notice. With the tab hidden, each outcome adds to the title ("(2) Biblioteca · eclume",
  `setTitleCount`), reset on `visibilitychange` back. A network or session error just waits for the
  next round.
- **Browser notification, optional**: the system notification (`new Notification(título, { body,
  tag: id })`; the `tag` prevents several tabs from stacking the same notice; the click focuses the tab and opens
  `/gravacoes/<id>`) only goes out with the `eclume-aviso-navegador` key on **and** the permission granted
  (`notifyOutcomesOn()`). Permission is only asked in a gesture — the "Avisar no navegador…" switch in
  Ambiente or "Avisar quando ficar pronta" on the uploaded row of Import (`enableNotifyOutcomes()`),
  never on load; denied, the switch stays off and the screen says where to allow it; without the API (http),
  the switch stays disabled and the offer disappears. No Web Push nor service worker: with every tab
  closed, there is no notice (whoever wants one uses the desktop).

- **Scope groups** (`tokens/scopes.ts`) are the main choice of a token: Buscar e ler
  gravações (`recordings:read`, `transcripts:read`), Ler e editar resumos (`summaries:*`), Editar
  campos e tags (`recordings:write`) and Excluir gravações (`recordings:delete`). The loose scopes
  stay in "Escopos individuais" (with the lumea combination). The table shows the short summary
  (`ler, resumos, campos`, "+N" for the loose ones) and marks `kind: device` tokens with "Aparelho ·
  <plataforma>". Validity: 30 days, 90 days or never. The secret shows once, in
  `CopyValue`.
- **MCP Connection** (`/config/mcp`) copies the `mcp_url` from the descriptor (`GET /server`, `staleTime:
  Infinity`) and creates the assistant's token with `TokenForm`: "Claude Desktop", the first three
  groups, without "Excluir gravações" and 90 days; once created, it shows the secret and the command
  `claude mcp add --transport http eclume <mcp_url> --header "Authorization: Bearer <segredo>"`.
- **Link code** (`connect/pairing.ts`): each page generates its own (App desktop by a button, App
  móvel on open), because a new code voids the previous one. The countdown anchors on
  `expires_at` minus the response's `Date` header, measured by `performance.now()`, and does not depend on the
  computer's clock. The state is polled at the rhythm of `pollWhile` (3 s at the start) while `pending` and the countdown has not
  reached zero; `used` updates the token lists and shows "Pareado: <aparelho>". The screen reader only
  hears "Falta 1 minuto" and "Código vencido".
- **QR generated in the browser** (`connect/qr.ts`, `QrCode.tsx`): the matrix of the `qrcode` package
  (correction M, loaded only with the QR) becomes its own `<svg>`, with one `<path>` per row, a quiet
  zone of 4 modules and black on white in both themes. The content is the contract's `pair_url`.
  `/parear` is the public page where whoever reads the QR with the ordinary camera lands: it explains that the
  code is for the app and does not call the API.
- **Installers** (`web/src/features/desktop/installers.ts`): App desktop reads `/downloads/instaladores.json`
  (same origin, outside `/api`), validates `versao` and `instaladores[]`
  ([desktop-distribuicao.md](desktop-distribuicao.md)) and shows the `recomendado` of each system,
  with the current system first; without a manifest or with an invalid one, the cards say the
  installers have not been published yet.
- **Linked devices** (`connect/DevicesList.tsx`) come from `GET /tokens?kind=device`, filtered
  by the page's platform; Desvincular revokes the credential (`DELETE /tokens/{id}`).

## Upload: `src/upload/multipart.ts`

`runUpload(file, options)` follows the contract:

1. `POST /uploads` with `sha256` (from the conversion), `size_bytes`, `content_type`
   `audio/ogg; codecs=opus`, `source: upload` and, from import, `recorded_at` and
   `recorded_at_source` (without `title`). A 200 `deduplicated` ends with the existing
   recording, without transferring anything.
2. Number of parts = `ceil(tamanho / part_size)`, computed from the file. Parts without a URL get a
   URL through `POST part-urls`. Three parallel `PUT`s to the opaque `url`, with the received `headers`,
   keeping the `ETag` (the storage must expose it through CORS if it is on another origin).
3. Network failure, 408, 429 and 5xx: a new attempt with a wait (3 in total). 403: asks for a new URL
   for the part and resends. A failure of one part aborts the others.
4. Resuming = calling again with `uploadId`: `GET /uploads/{id}` and only the parts outside
   `parts_received`. An `expired`/`aborted` upload on the server requires starting over.
5. `POST complete` with the parts in order. Cancelling = aborting the signal and `cancelUpload()`
   (`DELETE /uploads/{id}`).

Resuming holds while the page is open: the converted Opus (~15 MB/h) stays in memory.
After a reload, the import starts over from the conversion.

## How it is tested

- **Unit tests** (`npm test`, vitest + jsdom + Testing Library): `mockFetch()` replaces `fetch`
  with routes `"MÉTODO /caminho/:param"`, answering with the fixtures of `contracts/fixtures/`
  (`src/test/fixtures.ts`, typed by the schema). `renderApp(rota)` mounts the whole app on a
  route, with the same `routes` tree in a `createMemoryRouter` (`useBlocker` only works inside
  a data router). The upload engine runs in the `node` environment (jsdom's `Blob` does not work as a body for
  Node's `fetch`).
- **Without depending on load time nor on the real clock.** Each on-demand page of `routes.tsx`
  has `preload()` in the route's `handle`, and `preloadRoute(...caminhos)` (`src/test/render.tsx`)
  loads the chunks of the routes the file mounts: every test file that mounts a lazy route
  calls it in `beforeAll`, where `hookTimeout` applies, and not in the time of the first `findBy`. A test that
  depends on a date fixes the clock only where it matters (`vi.useFakeTimers({ toFake: ['Date',
  'performance'] })` with `vi.setSystemTime`, like the App móvel validity), with real
  timers for React Query and Testing Library. The suite passes three times in a row on the workstation and on the
  host.
- **Fixed time zone**: the unit tests run in `America/Sao_Paulo` (`process.env.TZ` in `vite.config.ts`)
  and Playwright too (`timezoneId`), the fixtures' time zone; the library positions by local time.
- **E2E** (`npm run test:e2e`, Playwright): the `webServer` brings up Vite dev with the proxy pointing
  to the mock. The scenarios walk through the library in the week of 2026-09-21 (the first example of
  `GET /recordings`), in the month and in the list, with the filter checked in the request (the mock does not filter);
  the Import modal with the `audio.m4a` of `npm run fixtures` (date from the metadata, real conversion and
  upload); the recording (pipeline, markers, transcript, editing, chat, export and delete); and
  search with the field chip, the recording at the second of the excerpt, people, collections and PAT; and
  `e2e/organizar-config.spec.ts` walks through Fields, Agenda types, MCP Connection, Tokens, App
  desktop, App móvel, the help center and the drawer (the mock only has the "used" example of the link code
  state and a fixed `expires_at`: the test rewrites both when it needs the code
  pending). The admin panel has its own `e2e/admin.spec.ts`: it enters through `/admin/entrar`, walks through
  the seven screens, saves on each one and checks the redirects. Prism emits no cookies nor
  keeps state, so the test puts the session cookies in the login response (the admin one with
  `Path=/api/v1/admin`), answers `PATCH /admin/settings` with the `GET` example (the mock generates
  meaningless values, which would spoil the cache), requests the upload with `Prefer: code=201` and forwards the part `PUT` (absolute
  URL of the fixtures at `127.0.0.1:4010`) with credentials and CORS, and answers the chat message
  query with the requested id. `ECLUME_MOCK_URL` points to another port when 4010 is
  taken (on the shared host, a mock of its own: `ECLUME_MOCK_PORT=4037 docker compose -p
  eclume-mock-<spec> -f deploy/docker-compose.mock.yml up -d`, with its own `E2E_PORT`); `E2E_SCREENSHOTS=1` saves light and dark screens in
  `test-results/screens/`; `E2E_CHANNEL=chrome` uses the installed Google Chrome
  (`msedge` on the Windows station, which has no Chrome). The `navTo()` helper
  uses the sidebar or, for settings and help, the header menus. `e2e/visual.spec.ts`,
  `e2e/visual-organizar.spec.ts` and `e2e/admin-visual.spec.ts` are the visual check against the DS
  ([web-design-system.md](web-design-system.md)); with `ECLUME_DS_DIR`, they also save the frames
  of `examples/*.html` for the side-by-side comparison.
- **Three engines.** The E2E runs everything in Chromium and, in Playwright's WebKit and Firefox, only the
  smoke (`@smoke` in the title, with one retry): sign-up, login, library, recording with
  copying the summary and the player (the report notes each engine's Ogg Opus `canPlayType`) and a
  small import with a WAV generated in the test, without a proprietary codec. The browser tests
  (`npm run test:browser`: the conversion, the metadata date and the long transcript) run in
  Google Chrome, Firefox and WebKit; the conversion follows each engine's path (WebCodecs
  when it decodes the track and encodes Opus, the ffmpeg.wasm fallback when not), and what depends only
  on WebCodecs is skipped with the reason (WebKit hangs decoding Vorbis).
- CI runs the unit tests, the build and the budget in the `web` job and the E2E, together with the browser
  tests, in the `web-browser` job.
- **E2E against the real backend** (`npm run test:e2e:real`, `playwright.real.config.ts`,
  `e2e-real/`): nothing simulated — login with the server's cookies, import with conversion in the
  browser and upload through the signed part URLs, transcription by the worker and the automatic summary
  by `claude -p`. It runs on the GPU host through `bash deploy/e2e-real.sh` (from the workstation:
  `remote-run . 'bash deploy/e2e-real.sh'`), which brings up its own ephemeral stack
  (`deploy/docker-compose.e2e.yml`, project `eclume-e2e`, Caddy on `127.0.0.1:18443`, data in
  tmpfs, worker on the CPU engine without a GPU), creates the throwaway admin through `eclume-server admin create`
  and the user through sign-up (`POST /auth/signup`), runs the scenario and
  always exits with `down -v` and the `:e2e` images deleted. It never touches production. It takes ~1 min beyond
  the build; it stays out of CI (it needs the daemon, Chrome and the host's Claude login).
