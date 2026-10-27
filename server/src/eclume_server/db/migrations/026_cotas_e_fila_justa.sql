-- 026_cotas_e_fila_justa — per-account quotas and a fair GPU queue (holetz/eclume#98).
--
-- Platform default quotas (`platform_settings.quotas`, `null` = no limit) and the per-account
-- override (`users.quotas`, only the overridden fields; `NULL` = follows the default). The numbers are
-- the spec's D6: storage 10 GiB, file 2 GiB, 3 open uploads, 600 min of audio and 200
-- agent requests in 24 h.
ALTER TABLE platform_settings
    ADD COLUMN quotas jsonb NOT NULL DEFAULT
        '{"storage_bytes": 10737418240, "file_bytes": 2147483648, "open_uploads": 3,
          "gpu_minutes_24h": 600, "agent_requests_24h": 200}'::jsonb;

ALTER TABLE users ADD COLUMN quotas jsonb;

-- Dispatch on the account's turn: `queued` without `dispatched_at` waits in the database; with it, it is in
-- `eclume:gpu`. The open jobs from before this migration are already in arq: they are born dispatched.
ALTER TABLE transcription_jobs ADD COLUMN dispatched_at timestamptz;

UPDATE transcription_jobs SET dispatched_at = queued_at WHERE state IN ('queued', 'running');

-- Dispatch looks for the account's oldest held job and the sum of those dispatched in the last 24 h.
CREATE INDEX transcription_jobs_owner_dispatch_idx ON transcription_jobs (owner_id, dispatched_at);
