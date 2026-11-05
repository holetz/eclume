---
title: What each processing step does
topic: processamento
pages: [gravacao, biblioteca]
related: [preprocessing, why-it-failed, how-long-it-takes]
terms: [steps, pipeline, processing, status, skipped, waiting, transcribing, summarizing, awaiting speakers, waiting for you]
order: 1
updated: 2026-10-08
---
Every recording goes through the same seven steps, one after the other. The step bar at the top of
the recording page shows which one it is on.

## The seven steps

1. **Audio received:** the file arrived whole at the server.
2. **Preprocessing:** the audio is prepared for transcription, according to what whoever administers
   the server turned on. See [What preprocessing does to the audio](/ajuda/preprocessing).
3. **Transcription:** speech becomes text, split by speaker and with the timing of each utterance. In
   a [voice note](/ajuda/voice-notes) there is one speaker, with no voice separation.
4. **Speakers:** after voice identification, it checks that every speaker with an utterance has a
   person. It only stops the recording when your account requires speaker naming (in
   **Automatic processing**); then it stays **Awaiting speakers** until you link each speaker to a
   person or choose **Go on without naming**.
5. **Agenda type:** an agent picks the type that best describes the recording, among yours. When none
   fits with good confidence, the default type stays. The type gives the default tags and the title rule.
6. **Fields:** an agent reads the transcript and fills the fields marked as automatic, like the tags
   and the fields you created, and writes the subject by the type's rule. The title is built from the
   type's pattern.
7. **Summary:** the agent writes the summary following the chosen type's instructions.

## The states of a step

Each step says its state in words, beside the name, without depending on the bar's color.

- **waiting:** the step has not started yet.
- **in progress:** the step is running now, with the name of what it does (for example, "Transcribing").
- **done:** the step finished; only its name shows.
- **failed:** something went wrong. The reason shows as text below the bar and, when possible, the
  button to try again. See [Why a recording failed](/ajuda/why-it-failed).
- **waiting for you:** only the **Speakers** step: the recording waits for you to name the speakers
  without a person, and the reason shows below the bar. When the last one gets a name, the rest goes on by itself.
- **skipped:** the step did not need to or could not run, and the reason shows as text below the bar.
  For example: "Summary · skipped: no agent configured; ask your administrator".

A recording is **Ready** when the last step ends, skipped or not. In the library, it shows as
**Queued** while it waits for its turn at transcription, with the step name while it moves,
**Awaiting speakers** when it waits for the names, and **Failed** or **Cancelled** when the
transcription did not finish. The library's **Need you** filter gathers the ones waiting for names.

## Why the recording waits in the queue

While the recording is **Queued**, its page says why it waits, in one sentence:

- **Waiting for the processor:** the position ("3rd in the queue") and, when there is history, when
  it should start ("starts in about 12 min (estimate)"). The forecast comes from the duration of the
  latest transcriptions and is only an estimate.
- **Behind your recordings:** the server transcribes one recording per account at a time; yours go
  in the order they arrived, and the sentence says how many come before.
- **24-hour minutes used up:** the account passed its transcription minutes of the last 24 hours, and
  the sentence says at what time the recording goes in.
- **Processor offline:** the sentence says since when. The recording is saved and goes in on its own
  when the processor is back.

Waiting never becomes a failure: the recording stays in the queue until its turn.
