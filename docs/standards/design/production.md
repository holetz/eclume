---
type: standard
title: Design production
description: The gate for producing an artifact with the eclume brand from a single token source, across web, Typst and PDF.
resource: .design/genres/**, .design/media/**
tags: [design, production, accessibility]
timestamp: 2026-09-28
audience: both
authority: background
source: quenching design brand pack, adapted for eclume
maintainer: holetz
---

# Design production

Every artifact cites this standard before it is produced, picks a genre contract, imports the
generated adapter for its medium and checks the rendered target, not only the source.

## Do's and Don'ts

### Do

- **Do** keep every primitive declaration in `/.design/tokens.json` and regenerate the adapters.
- **Do** preserve accessible foreground and background pairs and the semantic order of headings.
- **Do** inspect the real HTML, deck or PDF after rendering.

### Don't

- **Don't** copy a color, type size, radius or spacing into a media primitive.
- **Don't** use an asset without a recorded license and role.
- **Don't** treat the lossy projection of `DESIGN.md` as the whole DTCG source.
