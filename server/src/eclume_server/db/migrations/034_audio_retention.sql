-- 034_audio_retention — server-side audio retention that keeps the transcript and summary (holetz/eclume#179).
--
-- `users.audio_retention_days` is the account's choice (null = off, the default: nothing is deleted).
-- `platform_settings.retention.audio_max_days` is the admin ceiling (null = none); it only caps a
-- user value and never deletes on its own. When the purge runs, `recordings.audio_key` becomes null
-- and `recordings.audio_deleted_at` is set in the same transaction, so a null key always means
-- "the audio was deleted by retention". Rules in docs/standards/code/server-nucleo.md.

ALTER TABLE users
    ADD COLUMN audio_retention_days integer
        CONSTRAINT users_audio_retention_days_range CHECK (audio_retention_days BETWEEN 1 AND 3650);

ALTER TABLE platform_settings
    ADD COLUMN retention jsonb NOT NULL DEFAULT '{"audio_max_days": null}'::jsonb;

ALTER TABLE recordings
    ALTER COLUMN audio_key DROP NOT NULL,
    ADD COLUMN audio_deleted_at timestamptz,
    ADD CONSTRAINT recordings_audio_deleted_consistent CHECK (audio_deleted_at IS NULL OR audio_key IS NULL);

-- The purge scans recordings that still hold audio, oldest first.
CREATE INDEX recordings_audio_due_idx ON recordings (created_at) WHERE audio_key IS NOT NULL;
