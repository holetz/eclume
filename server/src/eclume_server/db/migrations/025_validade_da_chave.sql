-- 025_validade_da_chave — a chave do provider de agentes ganha a data de cadastro (holetz/eclume#93).
--
-- Expandir: coluna anulável. `key_set_at` muda sempre que a chave muda (criar, trocar, apagar) e
-- dá o vencimento do token de longa duração do Claude (`sk-ant-oat…`, 365 dias), que o
-- `eclume-server saude --json` informa e o `vigia.sh` avisa. As chaves já guardadas recebem a data
-- de criação do provider: nunca depois do cadastro real, então o aviso só pode vir cedo.

ALTER TABLE agent_providers ADD COLUMN key_set_at timestamptz;

UPDATE agent_providers SET key_set_at = created_at WHERE api_key_encrypted IS NOT NULL;
