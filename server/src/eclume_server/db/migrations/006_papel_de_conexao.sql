-- 006_papel_de_conexao — papel de conexão da aplicação sem superusuário e sem DDL.
--
-- Três papéis (docs/standards/code/server-nucleo.md §Papéis do banco):
--   * o dono/migrador — quem roda esta migration (o superusuário da imagem em produção); dono de
--     todo objeto, usado só pelo one-shot `migrate`;
--   * `eclume_server` — conexão do server e do worker CPU: sem SUPERUSER, sem ser dono, só DML.
--     Tem BYPASSRLS porque as operações de sistema (credenciais, ingestão, saúde) atravessam
--     organizações por desenho; as requisições baixam para `eclume_app` por transação;
--   * `eclume_app` — inalterado: NOLOGIN, NOBYPASSRLS, alvo do `SET LOCAL ROLE` da RLS.
--
-- O papel nasce NOLOGIN; `eclume-server migrate` com `ECLUME_RUNTIME_DB_PASSWORD` liga o LOGIN e
-- fixa a senha. Idempotente: dev, teste e produção rodam o mesmo arquivo.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eclume_server') THEN
        CREATE ROLE eclume_server NOLOGIN;
    END IF;
END
$$;
ALTER ROLE eclume_server NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Membro de `eclume_app`, para o `SET LOCAL ROLE eclume_app` de toda requisição.
GRANT eclume_app TO eclume_server;

GRANT USAGE ON SCHEMA public TO eclume_server;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eclume_server;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eclume_server;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO eclume_server;
-- O registro das migrations é do migrador: a aplicação só lê.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM eclume_server;

-- Objetos que as próximas migrations criarem (pelo mesmo migrador) já nascem com o acesso.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eclume_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO eclume_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO eclume_server;
