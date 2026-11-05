---
title: Register the tags and let the agent use them
topic: organizar
pages: [tags]
related: [tags-and-collections, fields-on-every-recording, write-a-rule]
terms: [tag, tags, registry, when to use, description, general rule, merge, rename, delete, self-managed, limit, variants, agent]
order: 10
updated: 2026-09-30
---
Tags mark the **subject** of recordings. They live in a registry of yours, in [Tags](/tags), and the
agent chooses among them after the transcription.

## Fixed tags by default

By default, the agent uses only the registered tags: it picks the ones that fit the conversation and
discards any other. This way the list does not grow with variants like "meeting", "meetings" and
"team-meeting".

The **Assign tags automatically after the transcript** switch turns the agent on and off. Off, it
assigns no tags: what stays is the agenda type's default tags and whatever you add on the recording page.

## Say when to use each tag

Each tag has a name and a description, the **When to use**. The agent reads both before choosing, so
write in the description what makes the tag fit:

> **steelworks-customer**
> Conversations with Serra Azul Steelworks or about it.

Without a description, the agent decides by the name alone. The **General rule**, in the card at the
top of the screen, applies to all tags: how many to use, how to write them, what to avoid.

## Let the agent create tags

Under **Which tags the agent uses**, choose **The agent can create tags** when you want the registry
to grow on its own. The agent still prefers to reuse a registered tag and only creates a new one when
none fits. You control:

- **New tags per recording:** from 1 to 5. The default is 1.
- **Registry ceiling:** when the registry reaches 200 tags, the agent stops creating. The card shows
  how many there are, like "42 of 200 tags".
- **Variants:** a new tag that is only another spelling of an existing one (capitals, accents,
  plural with "s") becomes the existing one. "Budgets" becomes "budget".

Tags the agent creates get the **Created by the agent** badge. Check them from time to time in the
list: merge or delete the ones that do not fit.

## Rename, merge and delete

- **Edit:** changes the name and description. Renaming swaps the name on all recordings and in the
  agenda types' default tags. A name that already exists, ignoring capitals and accents, is refused:
  to join the two, use Merge.
- **Merge into…:** where there was the tag there is now the chosen tag, on the recordings and in the
  types' default tags, and the first leaves the registry. The chosen tag keeps its name and description.
- **Delete:** removes the tag from the registry, from all recordings and from the types' default tags.
  The recordings stay in the library.

**See recordings**, on the tag's row, opens the library already filtered by it.

## Tags you write

A tag you type on a recording, in an upload or in an agenda type's default tags enters the registry
on its own, as your tag. If a tag with the same letters already exists, ignoring capitals and
accents, the recording gets the registry's spelling.
