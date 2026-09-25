-- 004_painel_admin — painel de administração (holetz/eclume#12): escrita de `users` só por admin
-- na própria RLS, convites por link e segredos da organização cifrados.
--
-- Padrão do núcleo (docs/standards/code/server-nucleo.md): `org_id` em toda tabela, políticas por
-- comando lendo `eclume_org()`/`eclume_user()`/`eclume_admin()`, `ENABLE` + `FORCE ROW LEVEL
-- SECURITY`. O aceite do convite e o enfileiramento leem com o papel de sistema.
-- (A numeração pula a 003, que é da holetz/eclume#11; o runner aplica em ordem de nome.)

-- --- users: leitura da organização, escrita só de admin -----------------------------------------

-- A política da 001 valia para todo comando: sob a RLS, qualquer membro atualizaria outro usuário
-- da organização, e só a checagem da rota impedia. `eclume_admin()` lê `users` sob a política de
-- SELECT, que não chama a função: não há recursão. O `WITH CHECK` não pede admin para que um admin
-- possa se rebaixar (a rota garante que sobra outro admin ativo).
DROP POLICY users_org ON users;
CREATE POLICY users_read ON users FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY users_admin_update ON users FOR UPDATE
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org());

-- --- convites -----------------------------------------------------------------------------------

-- O token do link (`ecli_` + 32 base62) só existe na resposta da criação; o banco guarda o SHA-256.
CREATE TABLE invitations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email             text NOT NULL,
    role              text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    group_ids         uuid[] NOT NULL DEFAULT '{}',
    token_hash        text NOT NULL UNIQUE,
    expires_at        timestamptz NOT NULL,
    accepted_at       timestamptz,
    accepted_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON invitations (org_id, created_at DESC, id DESC);
CREATE INDEX invitations_email_idx ON invitations (org_id, lower(email)) WHERE accepted_at IS NULL;

-- --- segredos -----------------------------------------------------------------------------------

-- `crypto.encrypt` (AES-GCM); a API devolve só `is_set` e `updated_at`.
CREATE TABLE org_secrets (
    org_id           uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,63}$'),
    value_encrypted  text NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    PRIMARY KEY (org_id, name)
);

-- --- RLS ----------------------------------------------------------------------------------------

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY invitations_admin ON invitations
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org() AND eclume_admin());

CREATE POLICY org_secrets_admin ON org_secrets
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org() AND eclume_admin());

ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE org_secrets FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE         ON invitations TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_secrets TO eclume_app;
