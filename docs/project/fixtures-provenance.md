---
type: project
title: Audio fixture provenance
description: Where each audio test fixture in the repository comes from, whether any real voice is in it, and what is still to confirm before the open-source release.
resource: worker-gpu/tests/fixtures/**, worker-gpu/scripts/make-test-audio.sh, desktop/crates/import/tests/fixtures/**
tags: [fixtures, audio, provenance, privacy, open-source]
timestamp: 2026-11-01
audience: both
authority: current
source: holetz/eclume#257
maintainer: holetz
---

# Audio fixture provenance

Recorded by the secret and personal-data sweep (#257). The sweep checks that no fixture carries a
real person's voice without recorded consent. It does not replace or rename any audio file.

| Fixture | Origin | Real voice | State |
| --- | --- | --- | --- |
| `worker-gpu/tests/fixtures/duas-vozes.ogg` | `worker-gpu/scripts/make-test-audio.sh fixture`: a pt-BR dialogue synthesized with two Piper TTS voices (`faber`, `cadu`), about 30 s, Opus mono 16 kHz | No: both voices are synthetic | Consent not needed. Confirm that the licence of the two Piper voice models allows redistributing their output; record it here |
| `desktop/crates/import/tests/fixtures/tom.{m4a,mp3,wav,webm,ogg,avi}` | `desktop/crates/import/tests/fixtures/gerar.sh`: a 2 s sine tone at 440 Hz, encoded with ffmpeg in each format | No: a pure tone | Clean |
| `desktop/crates/import/tests/fixtures/sem-audio.mp4` | The same script: a 1 s black video with no audio track | No | Clean |

The `duas-vozes.ogg` file is being renamed to `two-voices.ogg` on the unmerged branch
`plan/240-worker-engines-english`. The provenance above follows the file through that rename.

The one-hour benchmark audio that `make-test-audio.sh bench` builds from public-domain LibriVox
readings is not committed; see [calibracao-voz.md](calibracao-voz.md) for the readers it uses.
