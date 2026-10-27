-- 025_validade_da_chave — the agent provider's key gains its registration date (holetz/eclume#93).
--
-- Expand: nullable column. `key_set_at` changes whenever the key changes (create, replace, delete) and
-- gives the expiry of Claude's long-lived token (`sk-ant-oat…`, 365 days), which
-- `eclume-server saude --json` reports and `vigia.sh` warns about. Keys already stored receive the
-- provider's creation date: never later than the real registration, so the warning can only come early.

ALTER TABLE agent_providers ADD COLUMN key_set_at timestamptz;

UPDATE agent_providers SET key_set_at = created_at WHERE api_key_encrypted IS NOT NULL;

-- The date is not a secret: `eclume_app` reads the column, like the other non-secret ones (008, 011).
GRANT SELECT (key_set_at) ON agent_providers TO eclume_app;
