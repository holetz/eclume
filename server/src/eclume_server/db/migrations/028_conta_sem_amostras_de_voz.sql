-- 028_conta_sem_amostras_de_voz — the account can stop keeping voice samples (holetz/eclume#116).
--
-- `users.voice_keep_samples` (default `true`) is the data subject's choice. Turning it off deletes, in the same
-- transaction and under the owner's RLS, the account's samples, `speaker_embeddings` and pending
-- suggestions; from then on ingestion writes no vector for the account and the job does not request the embedding.
-- Rules in docs/standards/code/identificacao-por-voz.md.

ALTER TABLE users
    ADD COLUMN voice_keep_samples boolean NOT NULL DEFAULT true;
