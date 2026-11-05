---
title: What preprocessing does to the audio
topic: processamento
pages: [gravacao]
related: [processing-stages, why-it-failed, correct-the-transcript]
terms: [preprocessing, noise, volume, silence, channels, 16 kHz, mono, audio quality]
order: 2
updated: 2026-09-27
---
Before transcription, the server prepares a copy of the audio so the model understands speech better.
Whoever administers the server chooses what this step does, and it applies to all recordings.

## What can happen to the audio

- **Format:** the audio always becomes 16 kHz mono, the format the transcription model uses.
- **Noise reduction:** removes constant background noise, like air conditioning and fans.
- **Volume normalization:** keeps speech at a similar volume from start to end.
- **Silence trimming:** removes the silence at the start and end of the recording. The transcript's
  timings stay those of the original audio.
- **Channel separation:** when each channel of the file has one person, as in some phone recordings,
  each channel is transcribed separately. Audio with both channels equal skips this.

## The audio you hear

The recording's player always plays the **original**. The prepared copy is only for transcription and
is discarded afterwards.

## If preprocessing fails

The transcription goes on with the audio only converted to 16 kHz mono, and the step shows as failed,
with the reason. The recording does not stop because of it.
