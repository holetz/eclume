---
title: How voice suggestions work
topic: transcricao
pages: [pessoas, pessoa, gravacao]
related: [link-speaker-to-person, forget-a-voice, correct-the-transcript]
terms: [voiceprint, biometrics, LGPD, threshold, voice identification]
order: 2
updated: 2026-09-30
---
When a speaker in the transcript is not linked to anyone yet, eclume can suggest who it is, by
comparing the voice with the voiceprint of the people **you** registered.

## What a voiceprint is

It is a set of samples of one person: the passages of speech in which you confirmed that a speaker
was them. It uses the same model that separates the speakers in the transcript.

## When eclume suggests a person

The suggestion appears when the voice gets close enough to a voiceprint to pass the threshold that
whoever administers the server set, but does not reach your minimum score for automatic assignment.

- A suggestion never links on its own. It only becomes a link when you accept.
- Accepting adds the speaker's samples to the person's voiceprint, and the next suggestions improve.
- Declining leaves the speaker without a person and does not change the voiceprint.

> **Off by default**
> Whoever administers the server must turn on voice identification in the panel before any
> suggestion appears. Off, nothing is compared and no sample is kept.

## Automatic assignment

When a speaker's voice passes the **minimum score** you choose in [People](/pessoas) (default 75%)
and no other person has a similar voice, eclume links the speaker to the person on its own, at
transcription time, and the summary already comes out with their name.

- The speaker shows as **Assigned by voice**, with the score. Use **Confirm** to count it as a sample
  of the person's voice, or **Unlink person** if it got it wrong.
- An automatic assignment does not enter the voiceprint until you confirm: a mistake does not spread.
- Raise the score to link less and suggest more, or turn assignment off on the same card. The change
  applies to the next recordings.

## Consent and removal

When you created your account, you accepted responsibility for asking the people you record for their
consent. A voiceprint is biometric data under the LGPD: agree with the person about keeping it too.
If they ask, open their page and use **Forget the voice**: the samples and the pending suggestions
go, and the links already confirmed stay as they are.
