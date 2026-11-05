---
title: Agent skills and actions
topic: resumos
pages: [agente]
related: [chat-with-the-agent, adjust-by-chat, connect-mcp-assistant]
terms: [skill, skills, instruction, instructions, action, actions, batch, confirm, regenerate, tag, collection, agenda type]
order: 6
updated: 2026-10-05
---
The Agent can follow a way of working that you repeat, saved as a **skill**, and can propose changes
to several recordings at once, which only happen after you confirm.

## Create a skill

In [Skills](/agente/habilidades), in the Agent group of the menu, click **New skill** and fill in:

- **Name**: short, in lowercase letters, numbers and hyphens, such as `minutes` or `committee-checklist`.
  It is what you type in the conversation.
- **Description**: what the skill does. The Agent reads the description to decide when to use it on
  its own.
- **Instructions**: the script in Markdown, such as the answer format and what to check.
- **Tools** (optional): tick **Limit the tools** so the skill uses only the ones you choose, for
  example only the summaries and file generation.

Each skill can be edited, turned off or deleted. Turned off, it does not appear in the picker or to
the Agent.

## Use it in the conversation

On the [Agent](/agente) screen, start the message with `/name`, such as `/minutes yesterday's meeting`,
or pick the skill in the picker beside the Send button. The question shows the name of the skill
used. If you pick none, the Agent may load on its own the skill whose description matches the request.

## Ask for changes in batch

Ask in plain language, such as "regenerate the summaries of the September board meetings", "add the
audit tag to the recordings of the Aurora client", "add these recordings to the Board collection" or
"change the agenda type of these recordings to Committee". The Agent changes nothing on its own: the
answer brings a card with what will be done and the list of affected recordings.

- **Confirm** runs the change. The card follows the progress and shows, per recording, what was
  done, what was already that way and what failed.
- **Discard** gives up the proposal, changing nothing.

A proposal is valid for 24 hours. Confirming again does not repeat the change.

## Limits

Each proposal reaches up to 20 recordings to regenerate summaries and up to 50 for tags, collections
and agenda type; above that, the Agent asks you to narrow the request (a period, a type, a
collection or a tag). The Agent uses collections and agenda types that already exist. Regenerating
summaries counts against your account's quota of agent requests, like the summaries asked for on
screen.
