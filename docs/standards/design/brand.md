---
type: standard
title: eclume brand
description: The eclume visual identity — linen and walnut, Archivo with IBM Plex Mono, zero radius, 2px rules and terracotta only for recording and failure — with the token roles, the component vocabulary and the commitments projected into DESIGN.md.
resource: .design/**
tags: [design, brand, tokens]
timestamp: 2026-10-01
audience: both
authority: current
source: design-system/styles.css (generated into the copies by design-system/sincronizar.py), docs/standards/code/web-design-system.md and holetz/eclume#130, holetz/eclume#122
maintainer: holetz
---

# eclume brand

The section headings stay in English because `cq design build` projects them by name into the
sections of `DESIGN.md`; the prose is English as well. The exact values live only in
`/.design/tokens.json`, which mirrors `design-system/styles.css`, the versioned source of the
Design System; web, desktop and mobile consume the copies generated from it
([web-design-system.md](../code/web-design-system.md)).

## Overview

**North star: "an institution's working file".** eclume is a tool people use for hours to read,
review and rediscover meetings. The interface looks like well-organized linen paper: dark ink,
straight 2px rules separating the structure, no curves, and color spent only on what means
something.

- **Sober:** hierarchy comes from the weight of Archivo 800 and from space, not from ornament.
- **Structural:** 2px rules draw the frame (page head, sidebar, dividers); shadows only separate
  layers that float.
- **Honest about state:** terracotta appears when something is recording or failing, and nowhere
  else.

## Colors

The linen background (`background`) and the surface one tone below (`surface`) carry the reading;
the ink (`on-surface`) is almost black and warm, and secondary text (`text-muted`) is linen 700.

- **Walnut (`primary`)** is the only action accent: primary button, link, focus and active
  navigation item. `accent-ink` is the dark walnut for kickers.
- **Terracotta (`recording`)** is semantic, not decorative: a recording in progress and failure. It
  never becomes a second accent for variety.
- `success`, `warning` and `danger` are states; `highlight` is the search and selection highlight.
  As text, all of them pass 4.5:1 over the background and the surface in both themes.
- **The control border (`control-border`) is not a structure rule.** Field, checkbox, secondary
  button and the off-switch track use linen 600, with at least 3:1 over the background and the
  surface in both themes; the `divider` remains the light structure rule. Darkening the divider
  would thicken every line on the page.
- Speakers have six colors of their own in OKLCH (`--speaker-1` to `--speaker-6` in the CSS), of
  equal lightness, that do not compete with walnut.
- **Dark theme** (`data-theme="dark"`): the `dark-*` tokens swap background, surface, ink, light
  walnut, light terracotta, the states, the accent ink, the highlight and the divider.
  `DESIGN.md` has no modes; the CSS is what applies the swap.

**Single-accent rule.** A block has at most one accent; terracotta only enters when the recording
or failure state is present.

## Typography

Archivo is the single voice: 800 with slightly negative tracking in headings (h1 42px, h2 32px, h3
25px), 400 at 15px with 1.55 line height in running text and transcripts, 800 at 14px in buttons.
Kickers and badges use 11px, weight 600, uppercase and wide tracking. IBM Plex Mono 500 with
tabular numbers marks times, durations and counters. The fonts come from the build
(`@fontsource`), with no CDN.

## Layout

Spacing grid in 4px steps (4, 8, 12, 16, 24, 32). The shell has a 240px sidebar and the content
uses the full width beside it (the DS `--content-width` of 1040px does not apply on the web);
running text stays at 68ch; the page opens with `.page-head`, title and actions over a 2px rule.
Density is that of a tool: compact lists and tables, with breathing room reserved for reading the
transcript.

## Elevation & Depth

The structure is flat and drawn by rules. Shadows (`sm`, `md`, `lg`) only for what floats: menus,
popovers, dialogs and the help drawer. In dark, the shadow becomes a 1px outline plus the drop.

## Shapes

Zero radius everywhere: buttons, fields, cards, tags, badges and dialogs. The badge marks state
with a 6px square, not a dot. Lucide icons with square caps and joins
(`stroke-linecap: square`).

## Components

The vocabulary comes from `design-system/styles.css`: `.btn` with `btn-primary` and `btn-secondary`
(a bare `.btn` is transparent), `.input` on fields, `select` and `textarea`, `.card`, `.badge` and
`.tag`, `.nav` and `.sidebar`, `.page-head`, `.kicker`, `.hr`. The web adds only what the DS lacks,
in `app.css`.

The real brand mark is the web's (`web/src/app/Brand.tsx` and `web/public/favicon.svg`). The
lockup in `/.design/assets/lockup.svg` is the package's generic one and stays only until the eclume
brand is exported there.

## Do's and Don'ts

### Do

- **Do** assemble screens with the `design-system/` classes and adjust the product in `app.css` or
  in the screen's CSS Module.
- **Do** use 2px rules for structure and keep zero radius.
- **Do** reserve terracotta for recording and failure.

### Don't

- **Don't** edit `web/src/styles/eclume.css`: it is a faithful copy and only changes through the
  sync.
- **Don't** round corners, use pills or introduce a second color accent.
- **Don't** load fonts or icons from a CDN: the server is self-hosted.
