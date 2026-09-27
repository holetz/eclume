-- 012_etapas_do_pipeline — o estado de cada etapa do processamento, por gravação e revisão
-- (holetz/eclume#33): recebido → pré-processamento → transcrição → campos → tipo de agenda → resumo.
--
-- A revisão é a do job de transcrição: retranscrever refaz a cadeia numa revisão nova. A Saúde do
-- admin lê daqui as execuções das últimas 24 h. Padrões em
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
    -- Motivo do pulo (`reason`), avisos, confiança da detecção, parâmetros do pré-processamento.
    detail         jsonb NOT NULL DEFAULT '{}',
    UNIQUE (recording_id, revision, step),
    FOREIGN KEY (recording_id, owner_id) REFERENCES recordings (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX pipeline_steps_health_idx ON pipeline_steps (step, finished_at);

-- --- histórico das gravações existentes --------------------------------------------------------

-- Recebido e transcrição saem dos jobs; um job ainda em aberto fica sem a linha da transcrição
-- (sai `pending`), e um nascido falho (hash divergente) falha já no recebido.
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

-- As etapas que não existiam antes ficam puladas nas revisões transcritas.
INSERT INTO pipeline_steps (owner_id, recording_id, revision, step, state, started_at, finished_at, detail)
SELECT j.owner_id, j.recording_id, j.revision, s.step, 'skipped',
       coalesce(j.finished_at, j.queued_at), coalesce(j.finished_at, j.queued_at),
       '{"reason": "before_pipeline"}'
FROM transcription_jobs j
CROSS JOIN (VALUES ('preprocessing'), ('fields'), ('agenda_type')) AS s (step)
WHERE j.state = 'succeeded';

-- O resumo: feito na última revisão transcrita que tem resumo automático; pulado nas demais.
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

-- --- RLS e GRANTs ------------------------------------------------------------------------------

ALTER TABLE pipeline_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_steps_own ON pipeline_steps
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
-- O upload e a retranscrição (sob a RLS do dono) abrem as etapas da revisão nova.
GRANT SELECT, INSERT, UPDATE ON pipeline_steps TO eclume_app;
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON pipeline_steps TO eclume_server;
