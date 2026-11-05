---
title: Configure an agenda type
topic: organizar
pages: [agendas]
related: [title-pattern, change-recording-type, edit-summary]
terms: [agenda type, agenda, team meeting, 1:1, customer conversation, voice note, summary instructions, preview]
order: 4
updated: 2026-10-01
---
The agenda type says what kind of conversation a recording is and how to summarize it. After the
transcription, an agent picks the type, and the type sets the title, the tags and the summary.

## The default type

Every account has the type **Geral** (General), with the **Default** badge, at the top of the list.
A recording gets it when no other type fits with good confidence (below 60%), when it is the only
one, when there is no detection agent or when detection fails. This way every recording has a type, a
title and a summary. It cannot be deleted and has no "How to identify"; you can edit the rest, even
the name.

## The types every account receives

The server seeds these types with Portuguese names; they are yours to rename.

- **Reunião de equipe** (team meeting): planning or reviewing the internal team's work. The summary
  brings decisions and next steps with an owner.
- **1:1:** a conversation between two people on the same team. The summary brings the points covered
  and the agreements.
- **Conversa com cliente** (customer conversation): someone outside the team for whom the work is
  done. The summary brings requests, commitments and deadlines.
- **Nota de voz** (voice note): one person alone speaking. The summary is the cleaned-up text.

They are yours: edit, delete or create others in [Agenda types](/config/agendas). Deleting a type
moves its recordings to the default type.

## What each type has

- **Name.**
- **Recording title:** a pattern with placeholders, such as `Team meeting · {subject}`. See
  [Build the title from the agenda type](/ajuda/title-pattern).
- **How to write the subject:** the rule the agent follows for the title's `{subject}`. Empty, the
  default type's rule applies.
- **How to identify:** what the agent reads to pick the type. Say what sets this type apart from the
  others.
- **Default tags:** added to the automatic tags.
- **Summary instructions:** in Markdown. The summary follows these instructions, with the same headings.

## Reach the type from the summary

On the recording page, the type badge above the summary opens this type here. After an adjustment
through the summary chat, **Take this request to the type instructions** opens the type with the
request at the end of the summary instructions, for you to review and save. See
[Adjust the summary by chat](/ajuda/adjust-by-chat).

## Preview before saving

**Preview on a recording** shows, on a recording you choose, whether the agent would pick this type
and with what confidence, and the title, tags and summary that would come out. Nothing is saved.
