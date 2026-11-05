---
title: Build the title from the agenda type
topic: organizar
pages: [agendas, campos]
related: [configure-agenda-type, write-a-rule, fields-on-every-recording]
terms: [title, title pattern, placeholder, subject, date, key]
order: 5
updated: 2026-09-30
---
A recording's title always comes from its agenda type: the **Recording title** field builds the
title, and **How to write the subject** tells the agent how to write the `{assunto}` (the subject).
Since every recording gets a type (when none fits, the default type stays), every title follows a type.

## The placeholders

Click a placeholder below the field to insert it where the cursor is. The placeholder names are
fixed (they are read by the server) and stay in Portuguese:

- `{assunto}` (subject): the automatic title, written by the agent from the type's subject rule.
- `{data}` (date): the recording's date, like 27/09/2026.
- `{tipo}` (type): the name of the agenda type.
- `{chave}` (key): the value of one of your fields, by its key. For example, `{cliente}`.

Example: `{cliente} · Alignment meeting · {data}` becomes "Guion · Alignment meeting · 27/09/2026".

## An empty placeholder

When a placeholder has no value, it disappears along with the separator that would be left over
(` · ` or ` - `). In the example above, with no customer, the title becomes "Alignment meeting · 27/09/2026".

## The subject rule

In **How to write the subject**, say what the subject should carry, for example "the customer and
the main subject, in up to 8 words". A type with an empty rule uses the default type's. The default
type already comes with a rule, which you can change.

## Which wins

- The type's pattern replaces the automatic title: what the agent wrote enters only through `{assunto}`.
- Without a pattern, the automatic title applies.
- A title that you **edited** or **accepted** on the recording is never replaced.
