# eclume design system

eclume is a self-hosted institutional transcription service (this repository). The name joins eco and lume. This system keeps the Modernist grammar: flat and architectural, set entirely in Archivo, a warm linen-and-walnut palette, a visible grid, zero corner radius and strong 2px rules. On top of that it adds the eclume brand and the product layer the web app and the desktop app need: recording status, transcripts with six speaker hues, the grouped app shell, the tray window, and a dark theme.

## How to use this

- Link `styles.css` from every page and take every color, font, spacing, radius and shadow from its variables. Never hard-code a value the tokens already carry.
- Build with the classes below. The component pages are plain HTML, so view source and copy the markup.
- `templates/` holds the skeletons a consuming project copies to start a screen: App shell (user web app), Admin panel, Desktop window and Mobile recorder.
- `examples/` holds every screen of the v6 screen map (26 Sep 2026), one file per surface on a zoomable canvas: `access`, `library`, `organize`, `settings`, `admin`, `desktop`, `help`, `mobile`. They are reference compositions, not templates. Frames tagged "Pending stage 2 · variant A" follow variant A of an open decision and will change once stage 2 decides.
- Dark theme: set `data-theme="dark"` on `<html>`. The app follows `prefers-color-scheme` by setting the attribute itself and stores an explicit choice (see `web/src/app/theme.ts` in the repo).

## Language

The design system is written in English: interface copy, labels, sample content, route names, file names and documentation. The product repository names routes in Portuguese (for example `/pessoas`, `/busca`); the examples show their English equivalents (`/people`, `/search`), and the `github.md` screen map keeps the real repo paths.

## Brand

- **Mark**: five square-cut vertical bars, a spoken word as a waveform (`assets/logo-mark.svg`). It is always walnut on linen, or linen on walnut and ink.
- **Wordmark**: always `eclume`, lowercase, Archivo 800 at -0.035em. Use the `.brand` class with the inline mark SVG. `assets/logo.svg` and `assets/logo-reverse.svg` are the static lockups.
- **App icon**: a solid walnut square with the linen mark at 72% (`assets/app-icon.svg`). Use it for Tauri and the favicon.
- Clear space is the mark's width on every side. Never round, tint, outline or recolor the mark.

## Color

The ground is `--color-bg` #f7f5f2 (linen) with `--color-text` #262420 and one walnut accent, #6f5a44, plus 100–900 ramps. Walnut is spent on the primary action, links, focus and the current nav item. Terracotta `--color-rec` #b8432c (the `accent-2` ramp) is reserved for recording; `--color-danger` #a33a26 for failure. Everything else is ink.

- `--color-accent-ink` is the accent for small text (accent-600 on light, accent-300 on dark).
- `--color-text-muted`, `--color-success`, `--color-warning` and `--color-danger` are the status roles.
- `--color-highlight` marks the segment playing now and search hits.
- `--speaker-1` … `--speaker-6` are six hues on one OKLCH lightness and chroma, so no voice outweighs another. The dark theme lifts them together.

## Type

Archivo for everything (800 for headings, buttons and speaker names; 400 for body). IBM Plex Mono (`--font-mono`) for timecodes, tokens, URLs and file names.

## Icons

Use Lucide (https://lucide.dev), at a 2px stroke.

## Components

| Class | What it is | Shown in |
| --- | --- | --- |
| `.brand` | Mark and wordmark lockup | foundations/brand.html |
| `.btn` + `.btn-primary/-secondary/-ghost/-icon/-block` | Actions | components/buttons.html |
| `.btn-rec` (+ `aria-pressed`, `.btn-rec-lg`) | Record and stop (desktop) | components/status.html |
| `.badge` + `-progress/-success/-warning/-danger` | Recording status. Always a word, and only Transcribing blinks | components/status.html |
| `.progress` + `.progress-row` | Job progress | components/status.html |
| `.alert` + `-info/-success/-warning/-error`, `.alert-title` | Messages with a 2px rule in the tone | components/status.html |
| `.tag` | Small labels (tags, filters) | components/buttons.html |
| `.field`, `.input`, `.radio`, `.seg` | Forms | components/forms.html |
| `.shell`, `.sidebar`, `.nav-group`, `.nav-link`, `.main`, `.page-head` | App shell with grouped sidebar | components/shell.html |
| `.rec-card` | Library entry | components/recording-card.html |
| `.segment`, `.speaker` + `.speaker-1…6`, `.timecode` | Transcript | components/transcript.html |
| `.tray`, `.tray-section`, `.status-line[data-status]`, `.queue` | Desktop tray window | components/desktop.html |
| `.tray-window` | 520px main desktop window | examples/desktop.html |
| `.auth`, `.auth-brand`, `.auth-form`, `.auth-admin` | Sign-in and sign-up layout; ink field for the admin panel | components/auth.html |
| `.with-filters` (+ `data-collapsed`), `.filters`, `.filter-group`, `.toolbar` | Page with a collapsible right-hand filter panel | components/calendar.html |
| `.cal-week`, `.cal-col`, `.cal-event` (`--s`, `--d`, `data-kind`, `data-status`), `.cal-now`, `.cal-month`, `.cal-cell`, `.day-group`, `.rec-row` | Library in time: week, month, list | components/calendar.html |
| `.dialog-lg`, `.dialog-head`, `.dropzone`, `.date-source` | Import modal with a date per file | components/import.html |
| `.pipeline` + `li[data-state=done/active/failed/skipped]` | Server processing steps as words | components/recording-parts.html |
| `.player`, `.disclosure` | Compact player, collapsed transcript | components/recording-parts.html |
| `.doc`, `.doc-bar`, `.doc-editing` | Summary document and its edit state | components/recording-parts.html |
| `.chat`, `.msg` (`-user/-agent`), `.msg-note`, `.composer` | Summary chat with the server agent | components/recording-parts.html |
| `.props`, `.prop`, `.origin` (+ `.origin-edited`) | Filled fields with the origin of each value | components/recording-parts.html |
| `.check`, `.switch`, `.tabs`/`.tab`, `.choice` | Controls | components/controls.html |
| `.list`, `.list-row`, `.order-list`, `.panel`, `.split` | Settings lists, reorderable steps, edit panel | components/controls.html |
| `.code-block`, `.steps`, `.stats`/`.stat` | Copyable values, numbered instructions, stats row | components/connect.html |
| `.menu`, `.menu-item`, `.toast`, `.meter` | Menus, OS notifications, voice level | components/menus.html |
| `.btn-sm`, `.btn-danger` | Small and destructive buttons | components/buttons.html |
| `.help-search`, `.topic-grid`/`.topic`, `.crumbs`, `.help-article`, `.article-meta`, `.toc` | Help center and articles (article body is `.doc`) | components/help.html |
| `.faq` (wraps `details.disclosure` + `.faq-answer`) | Common questions | components/help.html |

| `.hint` (+ `aria-expanded`), `.popover`, `.help-drawer` (`-head/-body/-foot`), `.help-links`, `.shortcuts`, `.kbd` | Contextual help: inline hint, help drawer opened with `?`, keyboard shortcuts | components/help.html |
| `.marker-count`, `.player-track` + `.player-tick` (`--at`), `.marker-bar`, `.marker-chip`, `.segment-marker` | Markers: indicator, ticks on the player, marker list, marker row in the transcript | components/markers.html |
| `.phone[data-os]`, `.phone-screen`, `.phone-status`, `.m-top`, `.m-body`, `.m-section`, `.m-net`, `.m-rec`, `.m-timer`, `.meter-lg`, `.m-cells`/`.m-cell`, `.markers`, `.m-rows`/`.m-row`, `.m-chips`/`.m-chip`, `.sheet`, `.viewfinder`, `.qr-slot`, `.lock`, `.live`, `.notif` | Mobile recorder (iOS and Android) | components/mobile.html |
| `.card`, `.table`, `.dialog`, `.hr`, `.kicker` | Surfaces and structure | components/*.html |

## Help

Help lives in three places. The Help center link sits last in the sidebar, under a Help group. On any screen, `?` or the Help button opens `.help-drawer` with the articles for that page. Next to a setting whose meaning isn't obvious, a `.hint` opens a `.popover` with two sentences and a link to the article. In the desktop app, a help icon beside Settings opens a `.menu` with the shortcuts sheet, the help center and the app version. Articles are written in plain second person and state what the product does. eclume runs on a local server with no one on the other end, so articles carry no feedback prompt.

## Desktop app direction

The Tauri main window is 520 × 600 (`.tray.tray-window`); the compact tray panel is 360px wide with a 2px ink frame, split into sections by 2px rules. From the top, the sections are the live status line, the record button with New note and Import file, meeting detection (a warning alert with Record / Not now), the sync queue and the signed-in account. The app signs in with email and password against the server it discovered; the manual address sits under Advanced. Red appears only on the record button and the recording status line. Idle, syncing and synced states each get a coloured square. Map `desktop/ui/style.css` variables onto these tokens: `--accent` becomes `--color-accent`, `--rec` becomes `--color-accent`, and `--sync` becomes `--speaker-2`.

## Markers

A marker is a timestamp with an optional short note, added while recording on the phone or the desktop app. Wherever a recording is listed (card, calendar event, phone list), `.marker-count` says how many it has. On the recording page the player shows a walnut tick per marker and `.marker-bar` lists them under it; in the open transcript a `.segment-marker` row sits before the segment that contains its time, with the note and the device it came from. Clicking any of them plays from that time. A marker without a note reads "Marker" in muted ink.

## Mobile app direction

The phone is a portable microphone: it records, keeps recordings when it is away from the server, and syncs them over Wi‑Fi once it is back on the server's network (automatic, Wi‑Fi only, with Sync now). It does not read transcripts. iOS and Android share one eclume layout; only the device frame, status bar and lock-screen surfaces (Live Activity, ongoing notification) differ. Screens from the top: status bar, `.m-top`, the `.m-net` strip (On network / Away / Syncing), then content. Home is the terracotta `.m-rec` block over the "On this phone" list. Recording shows the status line, a mono `.m-timer`, `.meter-lg`, the marker list and three `.m-cells` at the bottom: Pause, Marker, Stop. After Stop, a `.sheet` asks for a title and an agenda type, both optional. First launch discovers the server on the network, then signs in with email and password; scanning the QR code from web My settings → Mobile app is the fallback. Hit targets are 44px minimum. Screens: examples/mobile.html; skeleton: templates/mobile.

## Do

- Let the grid show: equal cells, 2px rules between sections.
- Keep everything flush left, including labels inside wide buttons.
- State status in words. Color only reinforces it.

## Don't

- Round a corner, except the recording dot.
- Use a speaker hue for anything other than a speaker.
- Colorize imagery. Photographs go through `.grayscale`.
