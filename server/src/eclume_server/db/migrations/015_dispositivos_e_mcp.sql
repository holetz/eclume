-- 015_dispositivos_e_mcp — credencial de dispositivo, código de pareamento e uso por MCP
-- (holetz/eclume#35).
--
-- O token ganha o tipo (`personal`, criado na web; `device`, emitido pelo login ou pelo pareamento
-- de um aparelho), a plataforma do aparelho e o último uso pelo servidor MCP, que a Saúde conta
-- como assistentes conectados. A exclusão de gravação passa a ter escopo próprio. Padrões em
-- docs/standards/code/server-mcp-e-dispositivos.md e docs/standards/code/server-nucleo.md.

-- --- 1. tipo, plataforma e uso por MCP -----------------------------------------------------------

ALTER TABLE api_tokens
    ADD COLUMN kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'device')),
    ADD COLUMN platform text CHECK (platform IN ('windows', 'macos', 'linux', 'ios', 'android')),
    ADD COLUMN mcp_last_used_at timestamptz;

-- Nenhum cliente existente perde a exclusão: ela era parte de `recordings:write`.
UPDATE api_tokens SET scopes = array_append(scopes, 'recordings:delete')
WHERE 'recordings:write' = ANY (scopes) AND NOT 'recordings:delete' = ANY (scopes);

-- A Saúde conta os tokens usados pelo MCP nas últimas 24 h.
CREATE INDEX api_tokens_mcp_idx ON api_tokens (mcp_last_used_at) WHERE mcp_last_used_at IS NOT NULL;

-- --- 2. códigos de pareamento --------------------------------------------------------------------

-- O código (6 caracteres) fica só como HMAC-SHA256 com a chave do servidor: um SHA-256 puro de
-- 30^6 combinações seria revertido do banco.
CREATE TABLE pairing_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hmac   text NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    token_id    uuid REFERENCES api_tokens (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pairing_codes_pending_idx ON pairing_codes (code_hmac) WHERE used_at IS NULL;
CREATE INDEX pairing_codes_user_idx ON pairing_codes (user_id, created_at DESC);

ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY pairing_codes_own ON pairing_codes
    USING (user_id = eclume_user()) WITH CHECK (user_id = eclume_user());

-- A web gera e consulta sob a RLS; a troca pelo app (sem conta ainda) é do papel de conexão.
GRANT SELECT, INSERT, UPDATE ON pairing_codes TO eclume_app;
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON pairing_codes TO eclume_server;
