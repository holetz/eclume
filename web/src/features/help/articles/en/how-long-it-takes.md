---
title: How long it takes
topic: processamento
pages: [gravacao, biblioteca]
related: [processing-stages, why-it-failed, import-files]
terms: [delay, queue, wait, GPU, time, processing, notice, notification, summary ready]
order: 5
updated: 2026-10-01
---
The time until a recording is ready depends more on the queue than on the audio length.

## The queue

The server has one transcription processor (the GPU) that serves one recording at a time, in order
of arrival. While it waits, the recording shows as **Queued** in the library, and the transcription
as **waiting** in the step bar.

## Once its turn comes

A one-hour meeting is usually ready a few minutes after the transcription starts. The agenda type,
the fields and the summary take a few more seconds to a minute, depending on the agent configured on
the server.

## When it takes longer

- Many recordings arrived together, like at the end of a day full of meetings.
- An agent was slow to answer, and the server is trying again.

The recording page updates on its own: no need to reload.

## Knowing when it is ready

You do not need to keep watching the page. eclume lets you know when a recording's processing ends:
**Summary ready**, **The summary failed**, **Ready without a summary** (with the reason) or **The
transcription failed**. Cancelling or deleting the summary is your own action and raises no notice.

- **In the desktop app**, the notice arrives for every recording of your account, coming from the
  computer, the phone or the browser. The summary-ready one has **Copy** and **Open**; the others,
  **Open**. You turn it off in Settings › Notices.
- **In the browser**, with an eclume tab open, the tab title counts the notices that arrived while
  you were on another tab, like "(2) Library · eclume". To also get the system notice, turn on
  **Notify in the browser** in Environment, or tap **Notify me when it is ready** when importing a
  file. The choice holds only for that browser.
- **On the phone**, the app does not notify: it only talks to the server on eclume's Wi‑Fi. The list
  shows the title the server gave the recording, and the detail has **Open on the web**.
