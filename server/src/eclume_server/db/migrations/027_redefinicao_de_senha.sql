-- 027_redefinicao_de_senha — link de redefinição de senha gerado pelo admin (holetz/eclume#119).
--
-- O link carrega um segredo de 32 bytes (`secrets.token_urlsafe`) guardado só como SHA-256, como a
-- sessão e o PAT; vale 24 h e é de uso único. Gerar outro vence os pendentes da conta, e desativar
-- a conta também. `admin_id` diz quem gerou (fica nulo se a conta de admin sair).
-- Sem RLS e sem GRANT para `eclume_app`, como `sessions`: só o papel de conexão a lê.
CREATE TABLE password_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    admin_id    uuid REFERENCES admins (id) ON DELETE SET NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO eclume_server;
