---
title: What eclume does on its own after each recording
topic: organizar
pages: [automacao]
related: [processing-stages, configure-agenda-type, registered-tags, automatic-collections, voice-suggestions]
terms: [automatic processing, automation, rules, after the recording, voice, speaker naming, awaiting speakers, agenda type, fields, tags, collections, summary]
order: 10
updated: 2026-10-05
---
After a recording arrives, eclume follows a sequence of steps on its own. The **Automatic processing**
page, under **Rules** in the sidebar, shows them all in the order they happen, how each one stands now
and the way to the screen that configures it. The switches live on each step's screen; only speaker
naming is switched on right there.

## The steps, in order

1. **Preprocessing and transcription:** the audio is prepared, turned into text and split by
   speaker. Whoever administers the server configures it, so the step has no link.
2. **Speakers by voice:** each speaker is compared with the voices of the registered people. With
   automatic assignment on in **People**, the speaker is linked to the person on its own when the
   score passes the minimum you chose; off, the voice only suggests. See
   [How voice suggestions work](/ajuda/voice-suggestions).
3. **Speaker naming:** off, the recording goes on with "Speaker N" for whoever the voice did not
   recognize. On (**Require speaker naming**), a recording with any speaker without a person stops
   in **Awaiting speakers** before the type, the fields, the collections and the summary. Link each
   speaker to a person on the recording page and the rest goes on by itself; **Go on without naming**
   releases the recording without the names. The library says how many are waiting and has the
   **Need you** filter. Turning the switch off releases all that were waiting.
4. **Agenda type:** the agent picks the meeting's type among yours, in **Agenda types**.
   The type gives the title, the default tags and the summary instructions. See
   [Configure an agenda type](/ajuda/configure-agenda-type).
5. **Custom fields:** the agent fills the fields marked as automatic in **Custom fields**.
6. **Tags:** along with the fields, the agent tags the subjects. In **Tags** you choose whether it
   uses only the registered tags or may create new ones. See [Register the tags and let the agent use them](/ajuda/registered-tags).
7. **Collections with a rule:** the recording joins on its own the collections that have a rule it
   meets. The rule lives in each collection, in **Collections**. See
   [Let the agent put recordings in collections](/ajuda/automatic-collections).
8. **Summary:** the agent writes the summary following the chosen agenda type's instructions.

## When something does not happen

If a step was skipped or failed on a recording, the reason shows in the step bar on the recording
page. See [What each processing step does](/ajuda/processing-stages).
