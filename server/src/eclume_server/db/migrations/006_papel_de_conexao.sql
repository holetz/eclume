-- 006_papel_de_conexao — the application's connection role, with no superuser and no DDL.
--
-- Three roles (docs/standards/code/server-nucleo.md `§Papéis do banco`):
--   * the owner/migrator — whoever runs this migration (the image's superuser in production); owner of
--     every object, used only by the one-shot `migrate`;
--   * `eclume_server` — connection of the server and the CPU worker: no SUPERUSER, not an owner, DML only.
--     It has BYPASSRLS because the system operations (credentials, ingestion, health) cross
--     organizations by design; requests drop to `eclume_app` per transaction;
--   * `eclume_app` — unchanged: NOLOGIN, NOBYPASSRLS, target of the RLS `SET LOCAL ROLE`.
--
-- The role is born NOLOGIN; `eclume-server migrate` with `ECLUME_RUNTIME_DB_PASSWORD` enables LOGIN and
-- sets the password. Idempotent: dev, test and production run the same file.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eclume_server') THEN
        CREATE ROLE eclume_server NOLOGIN;
    END IF;
END
$$;
ALTER ROLE eclume_server NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Member of `eclume_app`, for the `SET LOCAL ROLE eclume_app` of every request.
GRANT eclume_app TO eclume_server;

GRANT USAGE ON SCHEMA public TO eclume_server;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eclume_server;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eclume_server;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO eclume_server;
-- The migrations registry belongs to the migrator: the application only reads it.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM eclume_server;

-- Objects the next migrations create (by the same migrator) are born with the access already.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eclume_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO eclume_server;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO eclume_server;
