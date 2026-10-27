-- 030_marcacao_dos_locutores — the account can require every speaker to have a person before the agent
-- chain (holetz/eclume#144).
--
-- `users.require_speaker_naming` (off by default) turns the lock on. The new `speakers` step sits between
-- transcription and agenda type; the new `waiting` state is its state when some speaker with enough
-- speech has no person, and the chain only continues when the owner names them all or releases the recording.
-- Rules in docs/standards/code/processamento-automatico.md.

ALTER TABLE users
    ADD COLUMN require_speaker_naming boolean NOT NULL DEFAULT false;

ALTER TABLE pipeline_steps DROP CONSTRAINT pipeline_steps_step_check;
ALTER TABLE pipeline_steps ADD CONSTRAINT pipeline_steps_step_check
    CHECK (step IN ('received', 'preprocessing', 'transcription', 'speakers', 'fields', 'agenda_type', 'summary'));

ALTER TABLE pipeline_steps DROP CONSTRAINT pipeline_steps_state_check;
ALTER TABLE pipeline_steps ADD CONSTRAINT pipeline_steps_state_check
    CHECK (state IN ('pending', 'active', 'done', 'failed', 'skipped', 'waiting'));

-- Revisions already transcribed went through speakers with no lock: the step is done, with no reason.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at)
SELECT j.owner_id, j.recording_id, j.revision, 'speakers', 'done',
       coalesce(j.finished_at, j.queued_at), coalesce(j.finished_at, j.queued_at)
FROM transcription_jobs j
WHERE j.state = 'succeeded'
ON CONFLICT (recording_id, revision, step) DO NOTHING;

-- The "precisam de você" filter looks for the waiting step.
CREATE INDEX pipeline_steps_waiting_idx ON pipeline_steps (recording_id, revision) WHERE state = 'waiting';
