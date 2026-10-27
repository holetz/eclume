-- 012_etapas_do_pipeline — the state of each processing step, per recording and revision
-- (holetz/eclume#33): received → preprocessing → transcription → fields → agenda type → summary.
--
-- The revision is the transcription job's: retranscribing redoes the chain in a new revision. The admin's
-- Health page reads the runs of the last 24 h from here. Patterns in
-- docs/standards/code/processamento-automatico.md.

CREATE TABLE pipeline_steps (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recording_id   uuid NOT NULL,
    revision       integer NOT NULL CHECK (revision >= 1),
    step           text NOT NULL
        CHECK (step IN ('received', 'preprocessing', 'transcription', 'fields', 'agenda_type', 'summary')),
    state          text NOT NULL CHECK (state IN ('pending', 'active', 'done', 'failed', 'skipped')),
    started_at     timestamptz,
    finished_at    timestamptz,
    duration_ms    integer GENERATED ALWAYS AS (
        (extract(epoch FROM finished_at - started_at) * 1000)::integer
    ) STORED,
    error_code     text,
    error_message  text,
    -- Skip reason (`reason`), warnings, detection confidence, preprocessing parameters.
    detail         jsonb NOT NULL DEFAULT '{}',
    UNIQUE (recording_id, revision, step),
    FOREIGN KEY (recording_id, owner_id) REFERENCES recordings (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX pipeline_steps_health_idx ON pipeline_steps (step, finished_at);

-- --- history of the existing recordings --------------------------------------------------------

-- Received and transcription come from the jobs; a job still open gets no transcription row
-- (it comes out `pending`), and one born failed (hash mismatch) fails right at received.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at,
                            error_code, error_message)
SELECT j.owner_id, j.recording_id, j.revision, 'received',
       CASE WHEN j.error_code = 'hash_mismatch' THEN 'failed' ELSE 'done' END,
       j.queued_at, j.queued_at,
       CASE WHEN j.error_code = 'hash_mismatch' THEN j.error_code END,
       CASE WHEN j.error_code = 'hash_mismatch' THEN j.error_message END
FROM transcription_jobs j;

INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at,
                            error_code, error_message)
SELECT j.owner_id, j.recording_id, j.revision, 'transcription',
       CASE j.state WHEN 'succeeded' THEN 'done' ELSE 'failed' END,
       coalesce(j.started_at, j.queued_at), coalesce(j.finished_at, j.queued_at),
       j.error_code, j.error_message
FROM transcription_jobs j
WHERE j.state IN ('succeeded', 'failed') AND j.error_code IS DISTINCT FROM 'hash_mismatch';

-- The steps that did not exist before stay skipped in the transcribed revisions.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at, detail)
SELECT j.owner_id, j.recording_id, j.revision, s.step, 'skipped',
       coalesce(j.finished_at, j.queued_at), coalesce(j.finished_at, j.queued_at),
       '{"reason": "before_pipeline"}'
FROM transcription_jobs j
CROSS JOIN (VALUES ('preprocessing'), ('fields'), ('agenda_type')) AS s (step)
WHERE j.state = 'succeeded';

-- The summary: done in the last transcribed revision that has an automatic summary; skipped in the others.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at, detail)
SELECT j.owner_id, j.recording_id, j.revision, 'summary',
       CASE WHEN automatic.done THEN 'done' ELSE 'skipped' END,
       coalesce(automatic.started_at, j.finished_at, j.queued_at),
       coalesce(automatic.completed_at, j.finished_at, j.queued_at),
       CASE WHEN automatic.done THEN '{}'::jsonb ELSE '{"reason": "before_pipeline"}'::jsonb END
FROM transcription_jobs j
LEFT JOIN LATERAL (
    SELECT true AS done, s.started_at, s.completed_at
    FROM transcripts t JOIN summaries s ON s.transcript_id = t.id
    WHERE t.recording_id = j.recording_id AND s.trigger = 'automatic' AND s.status = 'done'
      AND j.revision = (SELECT max(x.revision) FROM transcription_jobs x
                        WHERE x.recording_id = j.recording_id AND x.state = 'succeeded')
    ORDER BY s.created_at DESC
    LIMIT 1
) automatic ON true
WHERE j.state = 'succeeded';

-- --- RLS and GRANTs ----------------------------------------------------------------------------

ALTER TABLE pipeline_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_steps_own ON pipeline_steps
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
-- The upload and the retranscription (under the owner's RLS) open the steps of the new revision.
GRANT SELECT, INSERT, UPDATE ON pipeline_steps TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_steps TO eclume_server;
