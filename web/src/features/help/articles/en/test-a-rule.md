---
title: Test a rule before saving
topic: organizar
pages: [campos]
related: [write-a-rule, fields-on-every-recording, configure-agenda-type]
terms: [test, try, preview, simulate, draft]
order: 3
updated: 2026-09-27
---
**Test on a recording** shows what a field's rule would fill in, without saving anything.

## How to test

1. In [Custom fields](/config/campos), open the field and adjust the rule.
2. Use **Test on a recording**.
3. Wait for the result: it takes a few seconds to a minute, depending on the server's agent.

The test runs the rule's **draft**, as it is on screen, on your 3 most recent transcribed
recordings. The result shows one row per recording: the title and the value the field would have,
or *empty*.

## The test saves nothing

Neither the field nor the recordings change. Liked the result? Use **Save**, and the rule applies
to the next recordings.

## When the test does not run

- **No transcribed recordings:** record or import one first.
- **No agent configured to fill fields:** ask whoever administers the server.
