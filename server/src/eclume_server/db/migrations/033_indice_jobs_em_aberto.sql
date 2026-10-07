-- Expandir: índice parcial para as varreduras e a fila, que só olham o que está em andamento
-- (`queued`/`running`); a tabela cresce com o histórico de `succeeded`/`failed`/`canceled`.
-- Sem CONCURRENTLY: o migrador roda cada arquivo numa transação.
CREATE INDEX IF NOT EXISTS transcription_jobs_open_state_idx ON transcription_jobs (state) WHERE state IN ('queued', 'running');
