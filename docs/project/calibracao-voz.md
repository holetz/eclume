---
type: project
title: Voice identification threshold calibration
description: How the eclume voice-suggestion threshold was chosen — 33 real LibriVox readers in 127 synthetic meetings diarized by pyannote community-1 on the GTX 1660 SUPER, false-positive and false-negative rates per threshold, per comparison mode and per speech duration, and the 0.55 threshold with a normalized centroid.
resource: worker-gpu/scripts/voice_calibration.py, server/src/eclume_server/voice.py
tags: [voice, calibration, threshold, pyannote, lgpd, benchmark]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#15
maintainer: holetz
---

# Voice identification threshold calibration

The voice suggestion ([identificacao-por-voz.md](/docs/standards/code/identificacao-por-voz.md))
compares the embedding of each new speaker with the fingerprint of the people who consented. This is the
experiment that chose the comparison mode, the default threshold and the minimum speech.

## Data

- **Real speech in Portuguese**, from LibriVox (public domain): 14 collections with each
  section's reader in the catalog. **33 readers** with two or more sections were included, up to 4 sections per reader, from
  different collections when possible. Each section is a different recording session. Only the
  first 5 min of each section were used.
- **Synthetic meetings**: 127 "meetings" of 2 or 3 readers in alternating turns of 6 to 25 s,
  with 15, 30, 60, 120 or 240 s of speech per reader. They were converted to the upload format
  (mono Opus 16 kHz, 32 kbps) and diarized by WhisperX's `DiarizationPipeline` with
  `return_embeddings=True`. It is the same path and the same model as the GPU worker
  (`pyannote/speaker-diarization-community-1`, embeddings
  `pyannote/wespeaker-voxceleb-resnet34-LM`, 256 dimensions).
- **The 1 h bench** of the worker (`/srv/eclume/bench/bench-1h.ogg`), with the turns taken from the stories
  of three readers.
- **The diarized speaker is matched to the reader** by overlap with the known turns. A
  speaker with less than 80% of a reader's speech was simply discarded: 4 of 337, one of them a
  bench reader, whom the diarization merged with another reader.
- Result: **333 labeled speakers**, from 115 sections and 33 readers; median of 49 s of speech
  per speaker, minimum of 5.5 s.

## Protocol

- **Test**: each labeled speaker, compared with the fingerprint of each of the 33 readers.
- **Fingerprint**: `k` samples drawn from the reader, from meetings and sections **different** from those of the
  test. This way the genuine pair never comes from the same recording session.
- **Pairs**: 330 genuine (same reader) and 10,656 impostor (different reader), with `k = 3`.
- **Comparison modes**:
  - `centroid`: cosine with the normalized mean of the normalized samples, like the server's
    `l2_normalize(avg(l2_normalize(...)))`;
  - `max`: the highest cosine with a sample;
  - `mean`: the mean of the cosines.
- **False positive (FPR)** is the impostor above the threshold. **False negative (FNR)** is the genuine
  below it.

```bash
python3 worker-gpu/scripts/voice_calibration.py manifest --out manifest.json
docker --context gpu-host run --rm -v <dir>:/work eclume-worker-gpu:prod \
  python /work/voice_calibration.py prepare /work/manifest.json --work /work
docker --context gpu-host run --rm --gpus all -v /srv/eclume/models:/models \
  -v /srv/eclume/secrets/hf_token:/run/secrets/hf_token:ro -v /srv/eclume/bench:/bench:ro -v <dir>:/work \
  eclume-worker-gpu:prod python /work/voice_calibration.py embed --work /work --out /work/embeddings.json --extra /work/extra.json
python3 worker-gpu/scripts/voice_calibration.py analyze embeddings.json
```

Cost on the host: diarizing the 128 meetings (~9 h of audio) took 25 min on the GTX 1660 SUPER, with the
production worker idle next to it.

## Results

### Per mode, with the 3-sample fingerprint

| Mode | EER | Threshold at FPR 1% | FNR there | Threshold at FPR 0.1% | FNR there |
|---|---|---|---|---|---|
| centroid, 1 sample | 2.1% | 0.460 | 2.1% | 0.575 | 4.2% |
| **centroid, 3 samples** | **0.9%** | 0.460 | 0.9% | 0.565 | 3.6% |
| max, 3 samples | 0.9% | 0.485 | 0.9% | 0.605 | 2.7% |
| mean of cosines, 3 | 1.2% | 0.440 | 1.2% | 0.545 | 4.2% |

### Centroid with 3 samples, per threshold

| Threshold | FPR | FNR |
|---|---|---|
| 0.40 | 2.99% | 0.91% |
| 0.45 | 1.19% | 0.91% |
| 0.50 | 0.44% | 0.91% |
| **0.55** | **0.17%** | **3.64%** |
| 0.60 | 0.07% | 3.94% |
| 0.65 | 0.06% | 4.55% |
| 0.70 | 0.05% | 5.76% |

### Centroid with 3 samples, at threshold 0.55, by the tested speaker's speech

| Speech | FPR | FNR | Impostors | Genuine |
|---|---|---|---|---|
| < 20 s | 0.10% | 1.6% | 2,048 | 63 |
| 20–45 s | 0.26% | 2.8% | 2,304 | 71 |
| 45–90 s | 0.24% | 4.5% | 2,112 | 66 |
| 90–180 s | 0.09% | 7.0% | 2,272 | 71 |
| ≥ 180 s | 0.16% | 1.7% | 1,920 | 59 |

### Distributions

- **Genuine** (centroid, 3 samples): p1 0.51, p5 0.68, median 0.88.
- **Impostors**: median 0.14, p99 0.46, p99.9 0.56.
- **The rare high impostors** (maximum 0.92) come from a few pairs of similar readers. The most similar
  centroids are two catalog readers, at 0.58. There is also label
  noise: one catalog reader has two samples with a cosine of 0.15 between
  them, which suggests a section read by another person.
- **The two synthetic voices** of the test dialogue of #8 (Piper, faber and cadu) sit at 0.33.

## Decision

- **Mode: normalized centroid of the samples**, with the lowest EER together with max. It is a
  single aggregation in SQL, stable when a sample is bad, and its cost does not grow with the number of
  samples. "Max" gains little in FNR and loses in FPR.
- **Default threshold: 0.55.** With an FPR of 0.17% per comparison, an account with 50 people in the
  directory has ~8% chance of a wrong suggestion for an unknown speaker. The suggestion
  only proposes, and rejecting costs one click; automatic assignment uses its own, higher threshold
  (default 0.75, ~0.05% FPR in the table above), which each account adjusts. With an FNR of ~4%, the right person almost always
  shows up. Below 0.50 the FPR triples; above 0.60 precision barely improves.
- **Minimum speech of 10 s** to compare and to become a sample. Not even the shortest speaker (5.5 s)
  worsened the rates. The cut protects against diarization fragments of 1–2 s, which the experiment
  does not have.
- **An audiobook is not a meeting.** Clean reading, without overlap and with a close microphone separates
  better than a real room. In meetings, genuines should drop more than impostors rise. That is
  why the threshold sits at the FPR ≈ 0.1–0.2% point, not at the EER one, and the admin can adjust it in
  Administration → Voice identification.
