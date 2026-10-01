repo: holetz/eclume
branch: main

## Last sync
date: 2026-09-27T01:53:00Z

### Updated in this project
- Added help components: search, topic grid, article layout, FAQ, inline hint, help drawer, shortcuts
- Added examples/help: help center, article, contextual help, desktop help menu (no help UI in the repo yet)

## Screen map
| Screen | Repo files |
| --- | --- |
| examples/access | web/src/features/auth/LoginPage.tsx, web/src/app/routes.tsx |
| examples/library | web/src/features/library/*, web/src/features/import/*, web/src/features/transcript/*, web/src/features/search/* |
| examples/organize | web/src/features/people/*, web/src/features/admin/TemplatesPage.tsx |
| examples/settings | web/src/features/tokens/*, web/src/features/desktop/* |
| examples/admin | web/src/features/admin/*, docs/glossary.md |
| examples/desktop | desktop/ui/index.html, desktop/ui/style.css |
| examples/help | docs/glossary.md, docs/standards/code/identificacao-por-voz.md |
| templates/app-shell | web/src/app/AppShell.tsx, web/src/app/nav.ts |
| templates/admin | web/src/features/admin/AdminLayout.tsx, sections.ts |
| templates/desktop | desktop/ui/index.html, desktop/ui/style.css |
| foundations/dark.html | web/src/app/theme.ts, web/src/styles/tokens.css |

## Sync history
- 2026-09-27T00:40:36Z · Added v6 screen-map patterns, examples/ per surface, skeleton templates
- 2026-09-26T12:24:06Z · Rebranded as eclume; added status, transcript, shell, recording card and desktop components, dark theme and five templates
