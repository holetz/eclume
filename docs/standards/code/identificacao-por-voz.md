---
type: standard
title: Identifying people by voice
description: How eclume suggests and assigns who each speaker is by voice — the voiceprint as a set of samples of confirmed speakers, matching by normalized centroid at ingest with a calibrated threshold, only among the owner's people, a suggestion below the account threshold and automatic assignment above it (before the summary), retranscription that keeps links, and the LGPD regime (the platform on/off switch with the embeddings purged when switched off, the account that stops keeping samples with the account purge, the notice acceptance at sign-up in place of per-person consent, and forgetting a person's voice).
resource: server/src/eclume_server/voice.py, server/src/eclume_server/db/migrations/019_atribuicao_automatica_de_locutores.sql, web/src/features/people/AutoAssignCard.tsx, server/src/eclume_server/routes/voice.py, server/src/eclume_server/people.py, server/src/eclume_server/db/migrations/005_identificacao_por_voz.sql, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql, web/src/features/people/VoiceSection.tsx, web/src/features/admin/SpeakersPage.tsx, web/src/features/transcript/SpeakersPanel.tsx, server/src/eclume_server/db/migrations/028_conta_sem_amostras_de_voz.sql, web/src/features/account/AccountPage.tsx
tags: [code, server, web, voz, lgpd, pgvector]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#95, holetz/eclume#97, holetz/eclume#116, holetz/eclume#144
maintainer: holetz
---

# Identifying people by voice

Linking speakers to people by hand in every transcript is repetitive. eclume learns the voice of whoever
has already been confirmed, **links on its own** the speaker whose voice passes the account's assignment threshold and
**suggests** the person in the less certain cases. Voice is biometric data, sensitive
personal data under the LGPD (art. 11), so everything here depends on two locks: the platform
on/off switch, which only the admin changes, and the acceptance of the notice "Sou responsável por pedir o consentimento
das pessoas que gravo", which every account gives at sign-up and which replaces per-person consent.

## The voiceprint is a set of samples

- **Sample** (`voice_samples`): the embedding of **one speaker confirmed** as the person, copied
  from `speaker_embeddings` when the owner links the speaker (`PATCH` with `person_id`). It also stores the
  model, the speech (`talk_ms`), who confirmed, when, and the transcript's `owner_id`.
- **The sample lives as long as the link exists.** The FK `(transcript_id, speaker_id) → speakers` has
  `ON DELETE CASCADE`, and the `speakers_voice_relink` trigger deletes the sample when the speaker's `person_id`
  changes. Unlinking, relinking to another person, merging, retranscribing or deleting the recording
  remove exactly that speaker's contribution. That is why the voiceprint is a set and not an
  accumulated centroid: a centroid cannot subtract the vector that merging or retranscription
  has already deleted.
- **A sample only enters** with voice identification switched on in the platform and at least
  `MIN_SAMPLE_TALK_MS` (10 s) of speech. The condition lives in the `INSERT ... SELECT` itself
  (`voice.add_sample`), not in an `if` before it.
- **No new sample from a recording whose audio was deleted** by the audio retention policy
  (`recordings.audio_deleted_at IS NOT NULL`): `_ADD_SAMPLE` joins `recordings` and requires it
  null, so confirming a speaker of such a recording adds nothing. The voiceprints already
  extracted stay and keep matching other recordings; only new contributions stop.
- **The person and the sample belong to the same account.** The FK `(person_id, owner_id) → people (id,
  owner_id)` guarantees that a person's voiceprint only gathers voices from the recordings of that person's owner.

## Matching in `ingest_transcript`

- It runs in the ingestion's `system_tx`, after the embeddings, only when the job came with
  `options.embeddings` and voice identification is switched on in the platform. It filters the
  transcript's owner explicitly (`s.owner_id = :owner`), because the connection role bypasses
  RLS: **matching is only against the owner's own people**.
- **Voiceprint = normalized centroid** of each person's samples, of the same model and the same
  dimension, excluding the samples of the transcript itself:
  `l2_normalize(avg(l2_normalize(embedding)))`. **Score = `max(0, 1 − distância de cosseno)`**
  between the normalized speaker and the centroid.
- Only a speaker with no person and with at least `MIN_COMPARE_TALK_MS` (10 s) is matched. No one is
  suggested who is already linked to another speaker of the same transcript.
- Above `voice_identification.suggestion_threshold`, it writes up to `MAX_SUGGESTIONS` (3) per
  speaker into `speaker_suggestions` (`pending`, with the transcript's `owner_id`), from the highest score
  to the lowest.
- **The default threshold is 0.55**, calibrated with real speech in
  [calibracao-voz.md](/docs/project/calibracao-voz.md): an FPR of 0.17% and an FNR of 3.6% per
  comparison. The admin adjusts it.
- Exact matching, with no ANN index. An account has dozens of people and hundreds of samples, and the
  index would require a fixed dimension on the column.

## Automatic assignment

- **Account preference** (`users.voice_auto_assign`, on by default; `users.voice_auto_threshold`,
  default 0.75, from 0.50 to 0.99): `GET`/`PATCH /me/voice-assignment`, session only. The `PATCH` applies to the
  next transcripts and does not touch the links that already exist. It only takes effect with voice identification
  switched on in the platform (`platform_enabled` in the response); the 0.75 default sits above the suggestion
  default (0.55), where the calibration gives an FPR of ~0.05% ([calibracao-voz.md](/docs/project/calibracao-voz.md)).
- **When it links.** In the same `ingest_transcript` matching (`voice.suggest`), before the chain of
  fields, agenda type and summary: the summary is born with the person's name and not with "Locutor N". The
  speaker's first candidate needs a score ≥ the account threshold **and** a margin of
  `AUTO_MARGIN` (0.05) over the second, so it does not link when two people have a similar voice; a
  person that two speakers contend for goes to the one with the higher score. Whoever does not pass these
  criteria only receives suggestions, as before.
- **What it writes.** `speakers.person_id`, the `label` with the person's name and `speakers.auto_score`
  (the score). A null `auto_score` is a link made or confirmed by someone; the API's `Speaker` carries
  `auto_score` for the interface to flag "Atribuído pela voz — 91%".
- **It does not reinforce the voiceprint.** The sample (`voice.add_sample`) only enters with `auto_score IS NULL`:
  a wrong assignment does not become a sample and does not spread to the next ones. **Confirming** is the speaker's
  `PATCH` with the same `person_id`; it clears `auto_score` and the sample enters. Changing or unlinking the
  person also clears it.
- **Retranscription** restores the automatic link as it was (with the `auto_score`, without a sample);
  after the restoration, the remaining speakers go through assignment again.
- **Required naming after voice** (holetz/eclume#144): with `users.require_speaker_naming`
  on, whatever the automatic assignment (and the retranscription restoration) did not link stops the chain
  at the `speakers` step until the owner links each speaker with at least 10 s of speech to a person. The
  automatic link counts as named; linking the last person through the speaker's `PATCH` releases the
  recording. It also applies with voice switched off in the platform. Rules in
  [processamento-automatico.md](processamento-automatico.md#speaker-naming).
- **Web:** the "Atribuição automática" card under People (switch and minimum score; it only shows with
  voice switched on in the platform) and, in the speakers panel, the badge with **Confirmar** and **Desligar pessoa**.

## A suggestion is only a proposal

- `Speaker.suggestions` shows only the `pending` suggestions of a speaker **with no person**, and only with
  voice identification switched on (`voice.load_suggestions`, in batch, in the transcript, the listing and
  the search).
- **Accepting is the speaker's `PATCH` with `person_id`.** The suggestion becomes `accepted` and, with voice
  switched on, the sample enters: the confirmation reinforces the voiceprint.
- **Rejecting is `DELETE /transcripts/{id}/speakers/{speaker_id}/suggestions/{person_id}`**, session
  only. The suggestion becomes `rejected`, disappears and does not come back for that speaker. The `revision` goes up.
- The suggestion itself never links: only the automatic assignment above links on its own, and only above the account threshold.

## Retranscription keeps the confirmed links

- Before deleting the old speakers, the ingest stores their links and speech intervals
  (`voice.capture_links`).
- After inserting the new ones, it matches each old link to the new speaker with the **largest
  speech overlap**, one to one. It only matches with an overlap of at least 50% of both speakers' speech
  (`RESTORE_OVERLAP`), and restores `person_id` and `label`. It goes by time, not by voice: it works with voice
  switched off and only reapplies a human decision about the same audio.
- Once the link is restored, the sample is recreated from the new embedding. A link that does not match is lost.
  An orphan sample does not exist, because the FK does not allow it.

## LGPD

- **Platform on/off switch:** `voice_identification.enabled`, off by default, in
  `PATCH /admin/settings`, only through the admin session. Off, nothing is matched, no sample
  enters and the pending suggestions do not show. The worker only computes embeddings with it on
  (`options.embeddings`).
- **Notice acceptance in place of per-person consent.** The account is born accepting the notice in
  force ([server-nucleo.md](server-nucleo.md)); asking for the consent of those recorded is the
  responsibility of whoever records. The person has no consent state, form or history.
- **Forgetting a person's voice** (`DELETE /people/{id}/voiceprint`) deletes the samples, the
  pending suggestions and the `speaker_embeddings` of the speakers linked to them, with ordinary `DELETE`s
  under the owner's RLS (`voice.forget`): every sample of the person is in the owner's own recordings. The
  speaker ↔ person link stays; without the vector, relinking one of those speakers does not recreate the sample, and
  only a retranscription recreates it (holetz/eclume#97 followed the spec's recommendation; the final decision on the
  scope belongs to the owner). **Deleting the person** takes everything in cascade.
- **Removing a single sample** (`DELETE /people/{id}/voice-samples/{transcript_id}/{speaker_id}`)
  deletes only that sample, under the owner's RLS (`voice.forget_sample`); 404 if it does not exist or belongs to
  another account. **The speaker stays linked to the person**: the sample leaves the voiceprint, not the link. Only a
  retranscription that restores the link recreates it.
- **Session only:** the voice routes refuse a PAT (403 `session_required`). A leaked PAT neither reads nor
  deletes biometrics. `GET /people/{id}/voiceprint` returns `enabled` (the platform), the count and the
  samples, without the vectors.
  Each sample carries the `recording_id` and the `excerpt` (`start_ms`/`end_ms` of that speaker's longest
  speech), to listen to the sample in the recording's audio; `excerpt` is null if the recording or the
  segments no longer exist.
- **The per-recording embeddings** (`speaker_embeddings`) exist for every speaker while voice
  is switched on, but never leave through the API nor are matched against people of another account.
- **Purge on switch-off.** The `enabled: true → false` transition deletes, in the same transaction as the
  `PATCH /admin/settings` (connection role), the `speaker_embeddings` and the pending suggestions of
  **the whole platform** (`voice.purge_embeddings`) and, after the commit, enqueues
  `purge_embedding_objects` on the CPU worker, which lists `recordings/` and deletes every
  `speaker_embeddings.json` — the one of each revision (`recordings/{id}/r{revision}/`) and the one of the
  old keys, without a revision — (batches of 1000; nothing, if voice was switched back on in the meantime). The job
  accepts and ignores the old `org_id` argument, which a job from the previous version may carry. The
  samples (confirmed speakers) stay: forgetting them goes through the person. Switching back on does not bring back the old
  vectors: only a retranscription recreates them.
- **The account can stop keeping samples** (holetz/eclume#116): `users.voice_keep_samples`
  (migration 028, default `true`), exposed as `keep_samples` in `/me/voice-assignment` along with
  `sample_count` and `voiceprint_people` (read-only). The `true → false` transition deletes, in the same
  transaction as the `PATCH` and under the owner's RLS (`voice.purge_account`), the samples, the
  `speaker_embeddings` and the pending suggestions **of the account** and, after the commit, enqueues
  `purge_embedding_objects(owner_id)`, which deletes only the `speaker_embeddings.json` of the account's
  recordings (nothing, if it went back to keeping them in the meantime; without an argument, the job remains the
  platform one). Unlike the platform purge, **the samples also go**: it is the data subject's explicit choice
  not to have biometrics stored. From then on the job is born with `embeddings: false`
  (`transcribe_options(..., keep_samples=)`), ingestion writes no vector for the account, nothing is
  matched or suggested, and confirming a speaker creates no sample. The speaker ↔ person links
  stay. Going back to `true` applies to the next transcripts, without recovering what left.
- **It holds at ingestion.** A job enqueued with `embeddings: true` before the switch-off (of the
  platform or of the account) reaches `ingest_transcript` after it: ingestion rereads the platform and
  the owner's preference and does not write the vector.
- **The embeddings JSON does not stay in the bucket.** Whether the vector is kept or discarded, ingestion puts the
  `speaker_embeddings.json` of the revision that arrived (the key the job carries) on the bucket's
  deletion queue, in the same transaction; the drain deletes it within a minute. Biometrics live only in the database.
- **Deleting the recording** deletes the audio, the whole `recordings/{id}/` (raw transcript and
  embeddings of every revision), transcript, speakers, segments, embeddings, samples, suggestions, jobs and summaries
  (cascade in the database and `Storage.delete_recording` in the bucket). A recording deleted during
  transcription has the artifacts the worker wrote afterwards deleted by `ingest_transcript`.
  Proof in `test_voice.py`.
- **No voice audit trail.** 008 removed `voice_audit`, `voice_consents`, the admin export
  and purge: with no per-person consent, there is nothing to audit or export per person, and
  the admin does not see user content.

## Isolation

- `voice_samples` and `speaker_suggestions` have `owner_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` and the
  owner policy `<tabela>_own`, like every content table
  ([server-nucleo.md](server-nucleo.md#rls-isolation)). `eclume_app` has `DELETE` on both,
  to forget the voice under RLS.
- The proof is in `server/tests/test_voice.py`: another account is never matched or read, through the API nor
  through direct SQL under `eclume_app`.

## Web

- **Recording** (`SpeakersPanel`): the speaker assigned by voice shows "Atribuído pela voz — 91%" with
  Confirmar; each pending suggestion shows as "Parece ser Fulana — 87%",
  with Aceitar and Recusar.
- **Person** (`VoiceSection`): if voice identification is switched on, the samples and "Esquecer a
  voz".
  The `Person` schema carries `voice_sample_count` (samples of the voiceprint) and `speaking_time_ms` (sum of the
  `talk_ms` of the speakers linked to the person, under the owner's RLS), computed in
  `people.person_select`.
- **Account** (`/config/conta`, Privacy and data): the counts of voiceprints and samples and, with
  voice switched on in the platform, the **Guardar amostras de voz desta conta** switch; switching it off asks for
  confirmation (`ConfirmDialog`). With the account without samples, the `AutoAssignCard` under People replaces the
  automatic assignment switch with a notice that leads to Account.
- **Admin** (`/admin/locutores`, Identification section): on/off switch (depends on diarization and asks for confirmation when switching off) and a threshold from 0.50 to 0.99.
