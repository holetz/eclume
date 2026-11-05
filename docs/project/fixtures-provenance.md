---
type: project
title: Audio fixture provenance
description: Where each audio test fixture in the repository comes from, whether any real voice is in it, and what is still to confirm before the open-source release.
resource: worker-gpu/tests/fixtures/**, worker-gpu/scripts/make-test-audio.sh, desktop/crates/import/tests/fixtures/**
tags: [fixtures, audio, provenance, privacy, open-source]
timestamp: 2026-11-05
audience: both
authority: current
source: holetz/eclume#257
maintainer: holetz
---

# Audio fixture provenance

Recorded by the secret and personal-data sweep (#257). The sweep checks that no fixture carries a
real person's voice without recorded consent. It does not replace or rename any audio file. Since #351 the synthetic Piper fixture, whose voices descend from the research-only Blizzard 2013 Lessac data, is replaced by CC0 recordings.

| Fixture | Origin | Real voice | State |
| --- | --- | --- | --- |
| `worker-gpu/tests/fixtures/two-voices.ogg` | `worker-gpu/scripts/make-test-audio.sh fixture`: about 32 s of pt-BR, six sentences alternating between two speakers, from six clips of [Common Voice](https://commonvoice.mozilla.org/) pt 17.0 (`dev` split) that the script reads by byte range from `fsicoli/common_voice_17_0` at revision `8262c16bf297c87a9cd88c51997c4758ed7a8ba2` and checks against pinned sha256 values. Clip ids: `common_voice_pt_19839027`, `19372052`, `19839054`, `19372064`, `19839053`, `19372093`. Opus mono 16 kHz | Yes: two volunteer donors, one woman in her twenties (client `7620a5e1…`) and one man in his thirties (client `270576f5…`). Common Voice identifies donors by a hashed id only | Clean. The corpus is CC0-1.0 and its donors consented to publication, so no further consent is needed. No Piper or lessac model is fetched for it |
| `desktop/crates/import/tests/fixtures/tone.{m4a,mp3,wav,webm,ogg,avi}` | `desktop/crates/import/tests/fixtures/generate.sh`: a 2 s sine tone at 440 Hz, encoded with ffmpeg in each format | No: a pure tone | Clean |
| `desktop/crates/import/tests/fixtures/no-audio.mp4` | The same script: a 1 s black video with no audio track | No | Clean |

The one-hour benchmark audio that `make-test-audio.sh bench` builds from public-domain LibriVox
readings is not committed; see [calibracao-voz.md](calibracao-voz.md) for the readers it uses.
