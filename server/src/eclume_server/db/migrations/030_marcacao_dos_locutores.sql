-- 030_marcacao_dos_locutores — a conta pode exigir que todo locutor tenha pessoa antes da cadeia por
-- agente (holetz/eclume#144).
--
-- `users.require_speaker_naming` (padrão desligado) liga a trava. A etapa nova `speakers` fica entre
-- a transcrição e o tipo de agenda; o estado novo `waiting` é o dela quando algum locutor com fala
-- suficiente está sem pessoa, e a cadeia só segue quando o dono nomeia todos ou solta a gravação.
-- Regras em docs/standards/code/processamento-automatico.md.

ALTER TABLE users
    ADD COLUMN require_speaker_naming boolean NOT NULL DEFAULT false;

ALTER TABLE pipeline_steps DROP CONSTRAINT pipeline_steps_step_check;
ALTER TABLE pipeline_steps ADD CONSTRAINT pipeline_steps_step_check
    CHECK (step IN ('received', 'preprocessing', 'transcription', 'speakers', 'fields', 'agenda_type', 'summary'));

ALTER TABLE pipeline_steps DROP CONSTRAINT pipeline_steps_state_check;
ALTER TABLE pipeline_steps ADD CONSTRAINT pipeline_steps_state_check
    CHECK (state IN ('pending', 'active', 'done', 'failed', 'skipped', 'waiting'));

-- As revisões já transcritas passaram pelos locutores sem trava: a etapa fica concluída, sem motivo.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at)
SELECT j.owner_id, j.recording_id, j.revision, 'speakers', 'done',
       coalesce(j.finished_at, j.queued_at), coalesce(j.finished_at, j.queued_at)
FROM transcription_jobs j
WHERE j.state = 'succeeded'
ON CONFLICT (recording_id, revision, step) DO NOTHING;

-- O filtro "precisam de você" procura a etapa em espera.
CREATE INDEX pipeline_steps_waiting_idx ON pipeline_steps (recording_id, revision) WHERE state = 'waiting';
