-- 031_agente_conversas — the Agent's conversations, with the messages and the files (holetz/eclume#142).
--
-- `agent_sessions` is a user conversation (title and last activity in `updated_at`);
-- `agent_messages` keeps the question (`user`, always `done`) and the answer (`assistant`, which the
-- `agent_turn` job takes from `queued` to `done` or `failed`, with the sources and the model); `agent_files` keeps
-- the attachments (`input`, with the extracted text) and the files the agent generated (`output`), whose
-- content lives in the bucket at `storage_key`. All three live under the owner's RLS. A file that goes
-- (the conversation deleted, by cascade, or the account) takes the bucket object through the 024 queue.
-- Rules in docs/standards/code/server-agentes.md `§Agente`.

CREATE TABLE agent_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title       text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_sessions_owner_idx ON agent_sessions (owner_id, updated_at DESC, id DESC);

CREATE TABLE agent_messages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
    owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('user', 'assistant')),
    content     text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'done' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    sources     jsonb NOT NULL DEFAULT '[]',
    queries     integer NOT NULL DEFAULT 0,
    model       text,
    error       jsonb,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_messages_session_idx ON agent_messages (session_id, created_at, id);
-- The account's open answers (the concurrent request limit).
CREATE INDEX agent_messages_open_idx ON agent_messages (owner_id) WHERE status IN ('queued', 'running');

CREATE TABLE agent_files (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id    uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
    -- The message that carried the attachment or that generated the file; null on an attachment not sent yet.
    message_id    uuid REFERENCES agent_messages (id) ON DELETE SET NULL,
    direction     text NOT NULL CHECK (direction IN ('input', 'output')),
    name          text NOT NULL CHECK (name <> '' AND char_length(name) <= 200),
    media_type    text NOT NULL,
    size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
    storage_key   text NOT NULL,
    -- The text extracted from the attachment (cut at the ceiling); null on a generated file.
    text_content  text,
    created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_files_session_idx ON agent_files (session_id, created_at);
CREATE INDEX agent_files_message_idx ON agent_files (message_id);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_files    ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_files    FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_sessions_own ON agent_sessions
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY agent_messages_own ON agent_messages
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY agent_files_own ON agent_files
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sessions, agent_messages, agent_files TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sessions, agent_messages, agent_files TO eclume_server;

-- The file that goes takes the bucket object. SECURITY DEFINER: the deleter is the owner, under RLS,
-- with no access to the queue.
CREATE FUNCTION eclume_agent_file_storage_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        INSERT INTO storage_deletions (key) VALUES (OLD.storage_key);
        RETURN OLD;
    END
    $$;
CREATE TRIGGER agent_files_storage_delete
    AFTER DELETE ON agent_files
    FOR EACH ROW EXECUTE FUNCTION eclume_agent_file_storage_deleted();
