---
title: Why a recording failed
topic: processamento
pages: [gravacao]
related: [try-again, processing-stages, how-long-it-takes]
terms: [failure, error, failed, agent, queue, corrupted file, no agent]
order: 3
updated: 2026-09-27
---
When a step fails, the recording's step bar marks which one and shows the reason. The most common
causes, by step:

## Audio received and transcription

- **The file does not open:** the file arrived damaged or in a format the server cannot read.
  Import it again from the original.
- **The transcription processor did not answer:** the server tries again a few times on its own. If
  it continues, tell whoever administers the server.

## Field filling and agenda type

- **Agent not configured:** the server has no agent for this step. It shows as skipped, not as a failure.
- **Agent offline or with an invalid response:** the server tries again a few times before marking the failure.

A failure in filling does not stop the following steps: the agenda type and the summary run just the
same, and the fields stay empty for you to fill in. Without the agenda type, though, the summary has
no instructions and is skipped. Choose the type by hand on the recording, and the summary comes out
from it. See [Try a failed step again](/ajuda/try-again).

## Summary

The summary fails when the summary agent is offline or takes too long. The server tries again before
giving up, and you can ask for another summary on the recording page.
