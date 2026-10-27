-- 015_dispositivos_e_mcp — device credential, pairing code and use through MCP
-- (holetz/eclume#35).
--
-- The token gains its kind (`personal`, created on the web; `device`, issued by the login or by the pairing
-- of a device), the device platform and the last use by the MCP server, which the Health page counts
-- as connected assistants. Recording deletion gets its own scope. Patterns in
-- docs/standards/code/server-mcp-e-dispositivos.md and docs/standards/code/server-nucleo.md.

-- --- 1. kind, platform and use through MCP -------------------------------------------------------

ALTER TABLE api_tokens
    ADD COLUMN kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'device')),
    ADD COLUMN platform text CHECK (platform IN ('windows', 'macos', 'linux', 'ios', 'android')),
    ADD COLUMN mcp_last_used_at timestamptz;

-- No existing client loses deletion: it was part of `recordings:write`.
UPDATE api_tokens SET scopes = array_append(scopes, 'recordings:delete')
WHERE 'recordings:write' = ANY (scopes) AND NOT 'recordings:delete' = ANY (scopes);

-- The Health page counts the tokens used by MCP in the last 24 h.
CREATE INDEX api_tokens_mcp_idx ON api_tokens (mcp_last_used_at) WHERE mcp_last_used_at IS NOT NULL;

-- --- 2. pairing codes ----------------------------------------------------------------------------

-- The code (6 characters) is only kept as HMAC-SHA256 with the server key: a plain SHA-256 of
-- 30^6 combinations would be reversed from the database.
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

-- The web generates and queries under RLS; the exchange by the app (no account yet) belongs to the connection role.
GRANT SELECT, INSERT, UPDATE ON pairing_codes TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON pairing_codes TO eclume_server;
