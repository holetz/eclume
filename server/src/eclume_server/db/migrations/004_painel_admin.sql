-- 004_painel_admin — admin panel (holetz/eclume#12): writing `users` by admins only
-- in the RLS itself, invitations by link and encrypted organization secrets.
--
-- Core pattern (docs/standards/code/server-nucleo.md): `org_id` in every table, per-command
-- policies reading `eclume_org()`/`eclume_user()`/`eclume_admin()`, `ENABLE` + `FORCE ROW LEVEL
-- SECURITY`. Accepting the invitation and enqueueing read with the system role.
-- (The numbering skips 003, which belongs to holetz/eclume#11; the runner applies in name order.)

-- --- users: read by the organization, written by admins only ------------------------------------

-- The policy from 001 applied to every command: under RLS, any member could update another user
-- of the organization, and only the route's check prevented it. `eclume_admin()` reads `users` under the
-- SELECT policy, which does not call the function: there is no recursion. The `WITH CHECK` does not require admin so that an admin
-- can demote themselves (the route guarantees another active admin remains).
DROP POLICY users_org ON users;
CREATE POLICY users_read ON users FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY users_admin_update ON users FOR UPDATE
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org());

-- --- invitations --------------------------------------------------------------------------------

-- The link token (`ecli_` + 32 base62) only exists in the creation response; the database keeps the SHA-256.
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

-- --- secrets ------------------------------------------------------------------------------------

-- `crypto.encrypt` (AES-GCM); the API only returns `is_set` and `updated_at`.
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
