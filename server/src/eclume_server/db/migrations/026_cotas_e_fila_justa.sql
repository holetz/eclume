-- 026_cotas_e_fila_justa — cotas por conta e fila justa da GPU (holetz/eclume#98).
--
-- Cotas padrão da plataforma (`platform_settings.quotas`, `null` = sem limite) e a sobreposição
-- por conta (`users.quotas`, só os campos sobrepostos; `NULL` = segue o padrão). Os números são os
-- da D6 da spec: armazenamento 10 GiB, arquivo 2 GiB, 3 uploads abertos, 600 min de áudio e 200
-- pedidos ao agente em 24 h.
ALTER TABLE platform_settings
    ADD COLUMN quotas jsonb NOT NULL DEFAULT
        '{"storage_bytes": 10737418240, "file_bytes": 2147483648, "open_uploads": 3,
          "gpu_minutes_24h": 600, "agent_requests_24h": 200}'::jsonb;

ALTER TABLE users ADD COLUMN quotas jsonb;

-- Despacho na vez da conta: `queued` sem `dispatched_at` espera no banco; com ele, está em
-- `eclume:gpu`. Os jobs em aberto de antes desta migração já estão no arq: nascem despachados.
ALTER TABLE transcription_jobs ADD COLUMN dispatched_at timestamptz;

UPDATE transcription_jobs SET dispatched_at = queued_at WHERE state IN ('queued', 'running');

-- O despacho procura o mais antigo retido da conta e a soma dos despachados nas últimas 24 h.
CREATE INDEX transcription_jobs_owner_dispatch_idx ON transcription_jobs (owner_id, dispatched_at);
