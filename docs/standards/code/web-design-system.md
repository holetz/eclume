---
type: standard
title: eclume Design System on the web
description: The eclume web uses the eclume Design System (versioned in design-system/) as its single visual base — eclume.css generated from styles.css by sync.py, app.css with only what the DS lacks, the Archivo and IBM Plex Mono fonts served by the build, Lucide icons with square caps and a dark theme through data-theme — and this is the flow of a visual change, the map of the old tokens and the product classes.
resource: web/src/styles/**, web/src/main.tsx, web/src/app/theme.ts, web/src/app/Brand.tsx, web/public/favicon.svg, web/index.html, web/src/**/*.module.css
tags: [code, web, design-system, css, tema, acessibilidade]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#36, holetz/eclume#122, holetz/eclume#130
maintainer: holetz
---

# eclume Design System on the web

The **eclume Design System** lives versioned in `design-system/`, at the root of the monorepo:
`styles.css` with tokens and classes (the single source of the interface), `foundations/`,
`components/`, `examples/` (the screens of the v6 map), `templates/`, `assets/`,
`theme.html`/`theme.json`, `readme.md`, `github.md` and `_ds_manifest.json`, as they came from the
Claude Design export. It is written in English; the product stays in pt-BR, with the routes of
[frontend-web.md](frontend-web.md). The web does not invent visuals: it takes color, font, spacing,
radius and shadow from the DS tokens and builds the screens with its classes.

## CSS layers

`web/src/styles/global.css` is only the entry point, imported by `main.tsx` **before** the `App`.
`eclume.css` goes into the `ds` cascade layer (`@import './eclume.css' layer(ds)`), and the rest
(`app.css` and the CSS Modules) stays unlayered, so it beats the DS at any specificity and in any
chunk order. Bundle order is not enough: Vite puts the CSS of a shared chunk (the
`RequireSession` one, with the shell frame) **before** the entry's CSS, and the shell's compact menu
stopped applying in the production build:

| File | What it holds | Who edits it |
|---|---|---|
| `fonts.css` | `@fontsource/archivo` 400, 500, 600, 700 and 800 and `@fontsource/ibm-plex-mono` 400 and 500 | whoever changes the weights used |
| `eclume.css` | generated from `design-system/styles.css`, minus the Google Fonts `@import` | nobody: only `sync.py` |
| `app.css` | the product layer, only what the DS does not define | the web specs |

- **`eclume.css` is not edited.** A product adjustment goes in `app.css` or in the screen's CSS
  Module. The fixed header (no date) records the origin. The DS mobile layer (`.phone`, `.m-*`)
  comes along, inert: the faithful copy is worth more than the pruning.
- **A visual change** changes `design-system/` — by hand or through the Claude Design export, which
  remains where design happens, reviewed as a diff over the folder — and regenerates the three
  copies (`web/src/styles/eclume.css`, `desktop/ui/eclume.css`, `mobile/ui/src/styles/eclume.css`),
  in the same commit as the source:

  ```bash
  uv run python design-system/sync.py          # escreve as três cópias
  uv run python design-system/sync.py --check  # só confere (roda no uv run pytest)
  ```

  `design-system/test_sync.py` fails when a copy diverges from the source; the desktop's
  `ui_assets` and the phone's `copy.test.ts` check the copies against the web's. Then `npm --prefix
  web run build` and the visual verification screenshots (below) show what changed. A new DS class
  is available with nothing else; a renamed class breaks the screen that used it, and the E2E
  catches it.
- **No CDN.** The server is self-hosted: Vite copies the `@fontsource` `.woff2` files to
  `dist/assets` with a hash and Caddy serves them from the same origin. `@fontsource` declares the
  `"Archivo"` and `"IBM Plex Mono"` families, the same names as `--font-heading`, `--font-body` and
  `--font-mono`; that is why the variable package (`"Archivo Variable"`) does not fit. Weight 600 is
  included because the DS uses it in `.kicker`, `.badge`, `.nav-group-title` and 11 other rules.

## Product classes (`app.css`)

- `:root{color-scheme:light}` (the DS dark theme already declares its own).
- `.main{max-width:none}`: the content uses the full width beside the bar, without the DS
  `--content-width`; running text keeps its own measure (`68ch`). `.bleed` screens also remove the
  `.main` padding.
- `.field` as a grid, `.field-hint` (the field's help text, 12px, `--color-text-muted`, with 4px
  above inside `.field`) and `.field-label` (the DS 12px label for `<legend>` and labels that are not
  a `<label>` child of `.field`). In the DS, `.hint` is the 18px `?` button.
- `.input[aria-invalid='true']` with the border in `--color-danger`.
- `.visually-hidden` and `.skip-link`, on the DS tokens.
- `svg.lucide{stroke-linecap:square;stroke-linejoin:miter}`.
- `.page-head-actions` (the `.page-head` actions), `.help-section` (kicker over the list in the help
  drawer) and the adjustment of the `.help-drawer` rows without the `.help-search`.
- `.auth-tagline` and `.auth-note` (the brand field line and the footer of the sign-in form) and the
  `.auth` in one column below 56rem.
- The global `prefers-reduced-motion`.

## Old classes and old tokens

The web's global classes from before the DS were replaced as follows, and do not come back:

| Before | Now |
|---|---|
| `btn` with no variant | `btn btn-secondary` (in the DS, plain `.btn` is transparent and borderless) |
| `muted` | `text-muted` |
| `hint` | `field-hint` |
| `select`, `textarea` | `input` on the `<select>`/`<textarea>` itself |
| `label` (on `<legend>`) | `field-label` |
| `badge-neutral` | `badge` (the DS neutral is the default) |

The tokens of `tokens.css`, which no longer exists, follow this map when writing new CSS:

| Old | In the DS |
|---|---|
| `--font-sans` | `--font-body` |
| `--text-xs/-sm/-md/-lg/-xl` | `12px`/`14px`/`15px`/`20px`/`42px`: the DS uses a fixed px scale |
| `--leading` | nothing (the `body` has `1.55`) |
| `--space-5`/`-6`/`-7` | `--space-6`/`--space-8`/`calc(var(--space-8) * 1.5)` |
| `--radius-*`, `--radius` | nothing: zero corners; only the recording dot is round |
| `--color-surface-2` | `color-mix(in srgb, var(--color-text) 7%, transparent)` |
| `--color-border`, `--color-border-strong` | `--color-divider` |
| `--color-accent-hover`, `--color-accent-contrast` | `--color-accent-600`, `--color-bg` |
| `--color-accent-soft`, `--color-{danger,success,warning}-soft` | `color-mix(in srgb, var(--color-…) 10%, transparent)` |
| `--color-accent` as small text | `--color-accent-ink` |
| `--color-danger-hover`, `--color-focus`, `--shadow` | `--color-danger`, `--color-accent`, `--shadow-sm` |

`--color-surface` keeps its name, but it is the darkest linen, with no border. On screens not yet
redesigned, the DS base (`h1` to `h3` at 42/32/25px, `p` with margin) is contained in the page's
CSS Module with element specificity — `:where(.page) h2{font-size:20px;margin:0}`,
`:where(.page) h3{font-size:17px}` and `:where(.page) p{margin:0}` — so the module's classes keep
winning.

## Theme

The DS only has the dark theme under `:root[data-theme='dark']`. `web/src/app/theme.ts` always writes
the attribute on `<html>`: the explicit choice (`light`/`dark`, remembered in `eclume-tema`) or, under
"Do sistema", the result of `matchMedia('(prefers-color-scheme: dark)')` (with no `matchMedia`,
light). `main.tsx` applies the preference before `render` and turns on `watchSystemTheme()`, which
follows the system's change while the preference is "Do sistema". In the shell, the choice is the
"Tema" `.seg` (Sistema, Claro, Escuro). A new color goes in as a token in the DS, not in the web.

## Brand and icons

- `Brand.tsx` draws the `.brand` lockup: the five bars in inline SVG (filled by the CSS) and
  `eclume` in Archivo 800. With `to`, it is a link.
- `web/public/favicon.svg` is the DS `assets/app-icon.svg`; `index.html` declares the icon and the
  light (`#f7f5f2`) and dark (`#1e1c19`) `theme-color`.
- Icons come from `lucide-react` by named import, with `size={16}` and `aria-hidden`; stroke 2 is the
  Lucide default and the square cap comes from `app.css`.

## Visual verification

`web/e2e/visual.spec.ts` asserts the computed style (background `rgb(247, 245, 242)` in light and
`rgb(30, 28, 25)` in dark, brand field `rgb(111, 90, 68)`, Archivo 800 loaded, zero corners on
`.btn-primary`, no request outside the origin and `?` opening the help drawer) and runs in the usual
E2E. With `E2E_SCREENSHOTS=1`, it saves the screens in light and dark, at 1440×900 and 390×844, in
`web/test-results/screens/app-*.png`, and also, from `design-system/` (or from `ECLUME_DS_DIR`), the
frames of `examples/access.html` as `ds-*.png`, for the side-by-side comparison. There is no pixel
diff: the comparison is reviewed.

## Accessibility

- **Style by class.** `style` in JSX only carries a custom property (`--s`, `--lane`,
  `--altura-visivel`); the rest goes to the CSS Module or to `app.css`. The `no-restricted-syntax`
  of the web's and the phone's `eslint.config.js` bars the rest, the same rule the desktop's
  `ui_assets` imposes on the static UI.
- **Week event.** The day column is `role="list"`, and each event is a `div role="listitem"` with
  the `.cal-event` (position through `--s`, `--d`, `--lane`, state in the `data-*`) and the `Link`
  filling the box, with the event's `aria-label`; focus shows on the item through `:focus-within`
  (product CSS).
- **Focus on route change.** After the first `pathname` change inside the frame (`ShellFrame`,
  `pageFocus.ts` context), the `PageHead` focuses its own `h1` (`tabIndex={-1}`, no scrolling, no
  focus ring); the first load and a search-only change do not move focus.
- **Compact menu.** Opening focuses the bar's first link; Esc closes it and returns focus to the
  Menu button; clicking the current route's link closes it. It applies to the app and the admin
  (`ShellFrame`).
- **axe in the E2E** (`web/e2e/a11y.spec.ts`, `@axe-core/playwright`): sign-in, library, recording,
  Pessoas, Busca, Campos and, in the admin, Usuários and Saúde, in the light and dark themes, with no
  WCAG 2.1 A/AA violation and no exception.
- **Contrast as a test** (`web/src/styles/contrast.test.ts`): reads `:root` and
  `:root[data-theme='dark']` from `eclume.css`, resolves `var()` and `color-mix(... transparent)` over
  the background and asserts, in both themes and over background and surface, the control borders
  (`.input`, `.btn-secondary`, `.check .box`, `.switch .track`, all in `--color-control-border`) at
  3:1 or more (1.4.11, which axe does not measure) and the secondary, warning, success, error and
  table-header texts at 4.5:1 or more. The value changes at the source (`design-system/styles.css`),
  never in a copy.
- **Faithful copy on the phone.** `mobile/ui/src/styles/copy.test.ts` checks that the phone's
  `eclume.css` equals the web's, as `ui_assets` does with the desktop's.
