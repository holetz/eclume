---
title: Let the agent put recordings in collections
topic: organizar
pages: [colecoes]
related: [tags-and-collections, people-directory, configure-agenda-type]
terms: [collection, collections, automatic, rule, when to include, participants, company, area, merge]
order: 9
updated: 2026-09-30
---
A collection can receive recordings on its own. After the transcription, the agent reads the
conversation and adds the recording to each collection whose rule it meets.

## Turn it on in a collection

1. In [Collections](/colecoes), create or edit the collection.
2. In **When to include**, write the rule: what the recording needs to have to get in.
3. Tick **Include automatically after the transcript**.

The list shows the **Automatic** badge on collections with a rule and with inclusion on. Without a
rule, the agent includes nothing.

## What the rule can use

Besides the transcript, the agent receives:

- **The agenda type** of the recording, such as "Customer conversation".
- **The identified participants:** the people linked to the speakers, with company, area, role and
  person tags. See [Record where each person is from](/ajuda/people-directory).

Examples:

- "Meetings with someone from the company Agro Sul."
- "Conversations of the type Customer conversation with someone who has the person tag "board"."
- "When the conversation is about the Horizonte project: schedule, budget or deliverables."
- "Meetings with someone from the Finance area or with the role of manager, except voice notes."

For participants, the agent uses only those linked to a speaker. Link the speakers first, or let
voice identification do it. The agent does not invent someone's company from what it heard.

## Who wins

- The collection chosen at upload stays, and the agent only adds.
- On a new transcript, the agent redoes its own choice.
- If you change a recording's collections, the agent no longer touches that recording's collections.

## Merge two collections

**Merge into…**, on the collection's row, moves its recordings to another collection and deletes it.
The collection that receives keeps its own name, description and rule.
