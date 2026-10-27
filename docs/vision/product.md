---
type: vision
title: Product vision
description: The eclume product vision — the confirmed record (platform, users, purpose, positioning, operating context, brand commitments and principles), projected into PRODUCT.md for whoever designs, and the direction (target state, pillars that are already reality or still direction, and non-goals with the reason).
resource: PRODUCT.md
tags: [product, design]
timestamp: 2026-10-05
audience: both
authority: background
source: product interview confirmed in /quenching:design:align (2026-09-28) and product decision of 2026-09-26
maintainer: holetz
---

# Product vision

The record headings (from `Platform` to `Product Principles`) are projected into `PRODUCT.md`
by `cq design build`; `Target state`, `Pillars` and `Non-goals` are the direction, outside the projection.

## Platform

web

## Users

People who record work meetings and need to find them again (each user with their own space, open sign-up) and the platform admin, who configures the summary agents and operates the host.

## Product Purpose

Record meetings, transcribe them on the server's own GPU, separate and recognize speakers, organize by person, find through search and summarize by agenda type, with the agents the admin configures.

## Positioning

Self-hosted institutional transcription (open source in the future), focused on organizing, finding and recognizing people; it integrates with lumea only through a versioned API contract.

## Operating Context

A desktop work tool, on the LAN, with long sessions of reading and reviewing transcripts; light and dark theme.

## Brand Commitments

Linen and walnut palette, Archivo + IBM Plex Mono, zero radius, 2px hairlines, terracotta only for recording and failure; product in pt-BR.

## Product Principles

Rules that hold for any screen; a proposal that goes against them is designing a different product.

- **Isolated account.** Each account sees only what is its own; there is no sharing between accounts.
- **No live transcription.** eclume works on the finished recording.
- **Never records without showing it.** Every recording, on any device, has a visible indication.
- **The admin does not see content.** Whoever administers handles the platform's configuration and
  health, with no access to the accounts' recordings, transcripts and summaries.
- **Whoever records answers for the consent** of the people recorded, through accepting the notice at sign-up.
- **The device records, the server processes.** The device records and uploads; transcribing,
  classifying and summarizing is the server's work.

## Target state

Each person records their work on whatever device is at hand, and the house server turns the
recording into something that can be read and found again: a transcript with recognized speakers,
agenda type, fields and summary, organized by time, person, collection and tag, and queryable by
search and by question. The account belongs to each person, the admin operates the platform without
seeing content, and the same server serves the web, the desktop, the phone and the integrations.
Further ahead, eclume is open software that any institution installs and operates on its own host.

## Pillars

Each pillar is **reality**, with the standard that governs it, or **direction**, with no standard yet.

- **Account per user** — reality: open sign-up, with no invitation and no e-mail confirmation,
  acceptance of the notice and deletion by the person themself ([server-nucleo.md](../standards/code/server-nucleo.md),
  [contrato-v1.md](../standards/api/contrato-v1.md)).
- **Admin with its own login** — reality: agents, default agenda types, preprocessing and
  health ([server-admin.md](../standards/code/server-admin.md), [frontend-web.md](../standards/code/frontend-web.md)).
- **Capture on any device** — reality: the desktop detects meetings with per-app policies,
  records the voice note through the button, the tray or the shortcut (with stop on silence) and imports
  with the file's date and markers; the phone is a portable recorder; the web imports through the modal
  ([desktop-deteccao-e-sync.md](../standards/code/desktop-deteccao-e-sync.md),
  [desktop-gravacao.md](../standards/code/desktop-gravacao.md),
  [desktop-importacao.md](../standards/code/desktop-importacao.md), [mobile-app.md](../standards/code/mobile-app.md),
  [formato-audio-upload.md](../standards/code/formato-audio-upload.md)).
- **Device that finds the server by itself** — reality: installer with the address, mDNS, pairing
  code and pinned CA ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md),
  [desktop-deteccao-e-sync.md](../standards/code/desktop-deteccao-e-sync.md)).
- **Automatic processing** — reality: preprocessing, transcription, agenda type, fields
  and summary ([processamento-automatico.md](../standards/code/processamento-automatico.md),
  [jobs-transcricao.md](../standards/api/jobs-transcricao.md)).
- **Summary-centered recording** — reality: summary editable by hand or through the chat, and the Agent
  over the base, with stored conversations and input and output files ([server-agentes.md](../standards/code/server-agentes.md),
  [frontend-web.md](../standards/code/frontend-web.md)).
- **Library over time** — reality: week, month, list and filters, search, people, collections and
  tags ([frontend-web.md](../standards/code/frontend-web.md), [server-nucleo.md](../standards/code/server-nucleo.md),
  [processamento-automatico.md](../standards/code/processamento-automatico.md)).
- **Recognizing people by voice** — reality
  ([identificacao-por-voz.md](../standards/code/identificacao-por-voz.md)).
- **Integrations** — reality: PAT (lumea), MCP server and synced folder on the desktop
  ([contrato-v1.md](../standards/api/contrato-v1.md),
  [server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md),
  [desktop-pasta-sincronizada.md](../standards/code/desktop-pasta-sincronizada.md)).
- **Help inside the product** — reality
  ([web-central-de-ajuda.md](../standards/code/web-central-de-ajuda.md)).
- **Voice note also by voice command** (wake word) — direction. It only enters with a pt-BR model
  that runs offline, is light and has a permissive license, with no hidden open microphone (respecting
  "never records without showing it") and without triggering on every mention of the product in a meeting.
- **Open source and self-hostable by third parties** — direction: any institution installs and
  operates eclume on its own host.

## Non-goals

- **Organization, tenant, groups and invitations** — the account per user replaced them.
- **Sharing between accounts** — each account keeps its own work; what belongs to someone else
  arrives through them.
- **Live transcription and bots that join the call** — the product works on the finished
  recording, and a bot in the call would be recording without the device showing it.
- **E-mail confirmation at sign-up** — sign-up is open and the host belongs to the house; confirmation would only
  delay use.
- **Per-person voice consent** — acceptance of the notice at sign-up replaced it.
- **"Client" as an entity** — collection and tag cover grouping by client.
