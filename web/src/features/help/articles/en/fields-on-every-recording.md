---
title: Add a field to every recording
topic: organizar
pages: [campos]
related: [write-a-rule, test-a-rule, where-values-come-from, registered-tags]
terms: [field, fields, client, project, text, list, choice, title, tags]
order: 1
updated: 2026-09-30
---
Fields are the pieces of information you want on every recording, filled in by the agent after the
transcription. They live in [Custom fields](/config/campos).

## The title and the tags

The title does not appear here: it comes from the recording's agenda type, through the type's pattern
and subject rule. See [Build the title from the agenda type](/ajuda/title-pattern).

Tags do not appear here either: they have a registry of their own, with the general rule, each tag's
description and the choice between using only the registered ones or letting the agent create others.
Configure everything in [Tags](/tags). See [Register the tags and let the agent use them](/ajuda/registered-tags).

## Your fields

Use **New field** and choose the type:

- **Text:** a free value, like "Client" or "Project".
- **List:** several values, like "External participants".
- **Choice:** one value among options you define, like "Project phase": Proposal, Execution, Delivery.

A common example is the **Client** field, of the text type: it says which client each meeting was
with and becomes a filter in the library and in search.

## Automatic or by hand

With **Fill in automatically after the transcript** on, the agent fills in the field by the rule in
**How to identify**. Off, the field stays empty for you to fill in on the recording. The **Automatic**
switch in the list does the same without opening the field.

See [Write a rule that fills in a field](/ajuda/write-a-rule).
