---
type: standard
title: Desktop app interface in the Design System
description: The desktop app's window and tray follow the eclume Design System — HTML and ES modules with no framework or bundler, a faithful eclume.css (the same copy as the web), fonts.css and app.css, tauri.js as the only contact with Tauri, one section per view, a selectable theme (Sistema, Claro or Escuro), a CSP with no inline style, embedded Lucide icons, the global shortcuts by mode (global, Wayland portal or system shortcut) and the window ones, the window on Linux, the help menu, the "Atualizado para X" notice, the Recentes panel at the top of the main view and the Playwright tests with a simulated Tauri.
resource: desktop/ui/**, desktop/ui-tests/**, desktop/scripts/sincronizar_ds.sh, desktop/scripts/cdp.mjs, desktop/src-tauri/tests/ui_assets.rs, desktop/src-tauri/src/shortcuts.rs, desktop/src-tauri/tauri.conf.json
tags: [code, desktop, design-system, ui, css, tauri, playwright, atalhos]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#40, holetz/eclume#57, holetz/eclume#88, holetz/eclume#125, holetz/eclume#130, holetz/eclume#114, holetz/eclume#120, holetz/eclume#141, holetz/eclume#147
maintainer: holetz
---

# Desktop app interface in the Design System

The window (520 × 600) and the tray menu of the desktop app follow the frames of
`design-system/examples/desktop.html`, from the eclume Design System, in variant A where the frame
marks "Pending stage 2". The texts stay in pt-BR. The same DS applies to the web
([web-design-system.md](web-design-system.md)), and the two copies of the CSS are one and the same.

## No framework

- The UI is HTML and JS in **native ES modules** (`<script type="module">`), served by the Tauri
  protocol as static `frontendDist`. There is no bundler, lockfile or build step: the host's
  `cargo tauri build` and `cargo xwin` run without Node.
- There are five views, with all state coming from Rust. A framework would bring a bundler and a
  build into the release just to draw lists.

## Style layers

In the order of `index.html`:

| File | What it holds |
|---|---|
| `fonts.css` | `@font-face` for Archivo 400–800 and IBM Plex Mono 400/500, latin subset, pointing to `fonts/*.woff2` (with the `OFL.txt`) |
| `eclume.css` | a faithful copy of the DS `styles.css` without the Google Fonts `@import`; **byte for byte equal** to `web/src/styles/eclume.css` |
| `app.css` | product only: `.tray.tray-window` filling the whole window, the utilities the examples do through `style=""` (`.row`, `.stack`, `.grid-2`...), the 16-bar meter, the first-run fields |

- **Syncing.** `desktop/ui/eclume.css` is generated from `design-system/styles.css` by
  `uv run python design-system/sincronizar.py`, together with the web and phone copies
  ([web-design-system.md](web-design-system.md)); `bash desktop/scripts/sincronizar_ds.sh` only
  downloads the `@fontsource` fonts through `npm pack` into a temporary directory, at the same
  version as the web, without depending on `web/node_modules`. A product adjustment goes in
  `app.css`, never in `eclume.css`.
- **CSS with LF.** `.gitattributes` pins `*.css text eol=lf`: the equality test compares bytes,
  and a Windows checkout with `core.autocrlf=true` would bring the web one with CRLF.
- **Tokens.** The DS classes already use `--color-rec` (terracotta, reserved for recording),
  `--speaker-2` and `--color-success`. The `--rec → --color-accent` map in the DS readme
  contradicts the Color section, and the Color section prevails. The `--radius-*` are 0: every
  corner is square.

## CSP and DOM

- The window's CSP is `default-src 'self' ipc: http://ipc.localhost`. It blocks `style=""`, and
  no style attribute goes into the HTML. Dynamic values (the `--h` of each meter bar) go through
  `el.style.setProperty`, which the CSP allows.
- The window loads nothing from outside: no font, no script, no image.
- The DOM is built by `dom.js` (`el(tag, attrs, ...filhos)`, `trocar`, `$`), with no `innerHTML`
  carrying data from the server or the disk. `$` fails loudly when the markup changed.
- `icones.js` embeds the Lucide icons used (gear, help, back, close, copy, microphone) as
  SVG, with the ISC license in the header; `data-icone="<nome>"` in the HTML receives the SVG on load.

## Modules and views

- **`tauri.js`** is the only place that touches Tauri: `invoke`, `listen` and `versao` resolve
  `window.__TAURI__` (the `withGlobalTauri`) on every call, so tests can inject the mock first.
- **`vocabulario.js`** is a byte-for-byte copy of `web/src/lib/vocabulario.js` (the shared state
  vocabulary, [frontend-web.md](frontend-web.md)); the upload queue takes from it the labels and
  the tone of the device states (Gravando, Aguardando envio, Enviando, Enviada, Falhou o envio), and
  a failed upload shows the `last_error` as text on its own row (`.fila-erro`), not only in the
  `title`. Change the text in the web and copy the file; never edit the copy.
- **`main.js`** registers the views, one `<section data-vista>` each, and only one is visible. It
  applies the theme, handles the window keys and queries `status`, `recordings` and `recent` every
  1 s (and on the `status-changed` event); a failure of `recent` keeps the last panel and does not
  stop the rest from drawing. Without a credential (`connection: first_run`), the window stays on
  the first run, and the window keys do not apply.
- **`vistas/*.js`** export `montar(secao, app)`, which returns `{ entrar?, sair?, atualizar? }`:

| View | DS frame | What it shows |
|---|---|---|
| `principal` | Main window, Voice note, Automatic recording, After an update | the Recentes panel at the top, status line, record, "Nova nota" and "Importar arquivo…", meter and markers, per-app policy, meeting question, upload queue and account |
| `primeira-execucao` | First run | known servers, fingerprint check, e-mail and password, and under "Avançado" the pairing code and the address |
| `importar` | Import file | the date read from the chosen file with its origin and the conversion progress; the drop area takes a dragged file or opens the picker again |
| `configuracoes` | Settings · Meetings, Audio, Storage, Server | the six tabs, in this order: Geral (Aparência, Início and Avisos; opens by default), Reuniões (detection and per-app policy, with the automatic stop), Áudio, Armazenamento, Pasta and Servidor; `app.ir("configuracoes", { aba })` opens another |
| `atalhos` | — (help menu) | the sheet with the global shortcuts and the window ones |

- **Theme.** "Aparência", in the Geral tab, chooses Sistema (the default), Claro or Escuro
  (`theme` in the config, which `status` also carries). In Sistema, `data-theme` on `<html>`
  follows `prefers-color-scheme`, as the DS readme asks, and tracks the system change with the app
  open; Claro and Escuro override the system. The DS only has dark under `data-theme="dark"`, so
  the attribute is always written.

## Recent panel

- The top of the main view, right below the brand line and before the status line, holds the
  **Recentes** panel (`#recentes`, built by `recentes.js`): the account's last N recordings that
  the `recent` command delivers ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md) §Recent
  recordings panel). N comes from Configurações → Geral → "Gravações recentes na janela" (Ocultar,
  3, 5 or 10; 5 by default); Ocultar hides the panel.
- **Two rows in Geral, one per place.** Right below, "Gravações recentes no menu da bandeja"
  (`#recentes-bandeja-quantidade`: Ocultar, 1, 3 or 5; 1 by default) saves `tray_recent_count`
  immediately, separate from the window; the labels say "na janela" and "no menu da bandeja" so
  the difference is clear. The menu itself is native, built in Rust
  ([desktop-gravacao.md](desktop-gravacao.md) §App and tray).
- **Compact for 520 × 600.** A one-line header (the "Recentes" kicker and, when there are any,
  "N precisam de você" in `.badge-warning`) and one row per recording in a three-column grid:
  the title with an ellipsis (without a title, the short date "dd/mm hh:mm"), the state `.badge`
  and the `btn-sm` action. A second `.recente-detalhe` line only appears when there is something
  to say: the transcription's `<progress class="progress">` with the % as text, the waiting
  sentence (`fraseDaEspera`), the reason (`motivo`) or an action's error.
- **Vocabulary labels.** Rust delivers the phase; `recentes.js` takes the labels from
  `vocabulario.js`: `ESTADOS_APARELHO` on the device, `ESTADOS_SERVIDOR` for queued and ready,
  the `andamento` of `ETAPAS` ("Transcrevendo", "Resumindo"), and the outcome texts ("Resumo
  pronto", "O resumo falhou", "A transcrição falhou", "Pronta sem resumo"). An unknown state
  becomes "Precisa de você", with the step, the code and "resolva no web".
- **Alerts as text.** A row with an alert carries `.recente-alerta`, the reason as text on the
  second line and the action that resolves it: **Abrir no web** (`open_recording`) or **Tentar
  agora** (`sync_now`). State is never conveyed by color alone.
- **Copiar resumo** (with the copy icon) calls `copy_summary`; the feedback ("Copiado" on the
  button and "Resumo copiado em Markdown." in a `role="status"`, or the error) stays on the row for
  2.5 s, kept by key so it survives the redraw every second. On entering, the main view calls
  `recent_refresh` so the panel does not wait for the next round of polling.

## Shortcuts

- **Global**, registered in Rust (`shortcuts.rs`, without JS permission): toggle recording,
  new note (which also stops the note in progress) and marker (only with an active recording).

| OS | Record | New note | Marker |
|---|---|---|---|
| Windows and Linux | `Ctrl+Alt+R` | `Ctrl+Alt+N` | `Ctrl+Alt+M` |
| macOS | `⌘⇧R` | `⌘⇧N` | `⌘⇧K` |

  The DS's `Ctrl+Shift` would steal everyday shortcuts, because the registration captures the key
  system-wide: `Ctrl+Shift+M` is Teams mute, `Ctrl+Shift+N` Chrome's incognito window and
  `Ctrl+Shift+R` reload without cache. On ABNT2, AltGr (`Ctrl+Alt`) does not use R, N or M. On the
  Mac, `⌘⇧M` is Teams mute.
- The shortcuts live in `config.json` (`shortcuts: {record, note, marker}`) and change under Áudio →
  "Alterar", which captures the next combination in the window. The text is validated by
  `Shortcut::from_str` on save.
- **Three modes per session**, which the Áudio tab explains in one line (`ShortcutMode` in the
  `SettingsView`):

| Mode | When | How the shortcut arrives |
|---|---|---|
| `global` | X11, Windows, macOS | `tauri-plugin-global-shortcut`; a registration failure becomes "Em uso por outro app" (another app holds the combination) or "Indisponível nesta sessão" (the plugin did not start) |
| `portal` | Wayland with `org.freedesktop.portal.GlobalShortcuts` (KDE, GNOME 48+) | `ashpd`: one session with the three shortcuts, the preferred trigger in the XDG format (`CTRL+ALT+r`) and the `Activated` signal; the system may ask for confirmation. Registering again closes the previous session |
| `system` | Wayland without the portal (GNOME 46) | the shortcut belongs to the system and calls `eclume-desktop --alternar-gravacao`, `--nova-nota` or `--marcador`; the single instance (`tauri-plugin-single-instance`) hands the flag to the open instance, and with no instance the app opens and performs the action. On GNOME, "Criar atalhos no GNOME" writes custom-keybindings at `…/custom-keybindings/eclume-<ação>/` (name "eclume · …", combination in the GTK format, `<Control><Alt>n`); creating again only rewrites them, removing does not touch the person's own shortcuts, and once they are created each registration rewrites them with the current combinations and executable (the AppImage, when it runs from one). Outside GNOME, the tab shows the command for each action. Without the system shortcut, the line says "Crie o atalho no sistema" |

  In a Wayland session the app starts in `system` and moves to `portal` when the portal answers.
  The button and the tray work in every mode.
- **Window ones**, through `keydown` in JS: `Ctrl/⌘+O` import, `Ctrl/⌘+,` settings,
  `Ctrl/⌘+/` shortcuts and `Esc` goes back to the main view. "Importar arquivo…" and `Ctrl/⌘+O`
  open the system file picker directly (`tauri-plugin-dialog`); once a file is chosen, the
  `importar` view opens with it, and cancelling leaves the window where it was.

## Window on Linux

- The title bar is the native one. On Wayland, tao up to 0.35 covered the GTK HeaderBar with an
  `EventBox` above the buttons, and minimize and close did not receive the click until the window
  was reallocated (tauri-apps/tauri#13440); that is why `Cargo.toml` pins Tauri at 2.12 or later,
  which brings tao 0.37 with the fix. There is no custom title bar on any system.
- Closing hides the window (the app stays in the tray), as on the other systems.

## Start with the computer

- The Geral settings tab has the **Iniciar com o computador** switch (`#iniciar-com-o-sistema`, in
  the "Início" section, before "Avisos"), **on by default** and saved immediately like the others.
- The preference is `Config.autostart` (default `true`, including in a config from an earlier
  version). The app **reconciles** the system registration with it on every launch and every save
  (`reconcile_autostart`), instead of registering once: a path that changed fixes itself, and
  whoever turned it off stays off after reopening or updating. A development build
  (`debug_assertions`) does not register, and a system failure only goes to the log.
- Started by the system (`--autostart`), the app comes up **in the tray only**: the window starts
  hidden and only opens from the tray item or a shortcut.

## Help and updates

- The help icon opens a `.menu`: "Primeiros passos" (the `primeira-gravacao` article) and
  "Permissões de microfone" (`permissoes-de-microfone`), opened at `<web_url>/ajuda/<artigo>`, "Atalhos de teclado", "Abrir a central de ajuda", "Relatar um
  problema…" (opens the logs folder, with the hint "Anexe o eclume.log": the server is local and
  there is no form) and the version line. Every article the UI asks `open_help` for must exist in
  `web/src/features/help/articles/`: the `ui_assets` test extracts the slugs from `desktop/ui/js`
  and fails without the `.md`, and the CI `desktop` filter includes the articles.
- After an automatic update, the main view shows the `.alert-success` "Atualizado para
  X" with the release notes until the person closes it ([desktop-distribuicao.md](desktop-distribuicao.md)).

## Tests

- **`ui_assets`** (`desktop/src-tauri/tests`, in `cargo test`): `eclume.css` and
  `js/vocabulario.js` equal to the web ones,
  no `http(s)://` URL in the UI, the declared fonts present with the `OFL.txt`, no
  `style=""` and `index.html` loading only files that exist. That is why not even a `placeholder`
  carries `https://`.
- **Playwright** (`desktop/ui-tests`, in the CI `desktop` job and on the host): the test itself
  serves `desktop/ui`, aborts and records every outside request and injects `mock-tauri.js`, which
  simulates `window.__TAURI__` with scenarios (`window.__mock.cenario(nome)`: ocioso, gravando, nota,
  marcadores, pergunta, fila, vazio, atualizado, atalhoEmUso, pat, primeiraExecucao, semServidor,
  caMudou, recentes) and records each command in `__mock.chamadas`. `recent` answers in every
  scenario (empty outside `recentes`), and `copy_summary` writes the Markdown to
  `__mock.estado.areaDeTransferencia`.
- **`recentes.spec.ts`** checks the panel at the top with the configured N, each phase with its
  label and progress, the unknown state as "Precisa de você" with Abrir no web, Copiar
  resumo through Tauri (and the error without copying anything), Tentar agora, Ocultar and the
  absence of horizontal scrolling at 520 × 600 and 380 × 420.
- **`visual.spec.ts`** goes through each view at 520 × 600 and 380 × 420, in the light and dark
  themes, and checks Archivo loaded, no external request, no horizontal scrolling, the square
  corners of the DS pieces and the record button in `--color-rec`. The screenshots go to
  `desktop/ui-tests/capturas/<vista>-<tamanho>-<tema>.png` (outside git), for review.
- **In the real window**, `node desktop/scripts/cdp.mjs eval "<expr>"` and
  `node desktop/scripts/cdp.mjs screenshot janela.png` talk to WebView2 through debugging
  port 9229 ([estacao-windows.md](../../project/estacao-windows.md)), with Node 22's native
  `WebSocket` and no dependency.
