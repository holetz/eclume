-- 030_agente_conversas — as conversas do Agente, com as mensagens e os arquivos (holetz/eclume#142).
--
-- `agent_sessions` é uma conversa do usuário (título e última atividade em `updated_at`);
-- `agent_messages` guarda a pergunta (`user`, sempre `done`) e a resposta (`assistant`, que o job
-- `agent_turn` leva de `queued` a `done` ou `failed`, com as fontes e o modelo); `agent_files` guarda
-- os anexos (`input`, com o texto extraído) e os arquivos que o agente gerou (`output`), cujo
-- conteúdo mora no bucket em `storage_key`. As três vivem sob a RLS do dono. Um arquivo que sai
-- (a conversa excluída, em cascata, ou a conta) leva o objeto do bucket pela fila da 024.
-- Regras em docs/standards/code/server-agentes.md §Agente.

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
-- As respostas em aberto da conta (o limite de pedidos simultâneos).
CREATE INDEX agent_messages_open_idx ON agent_messages (owner_id) WHERE status IN ('queued', 'running');

CREATE TABLE agent_files (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id    uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
    -- A mensagem que levou o anexo ou que gerou o arquivo; nulo no anexo ainda não enviado.
    message_id    uuid REFERENCES agent_messages (id) ON DELETE SET NULL,
    direction     text NOT NULL CHECK (direction IN ('input', 'output')),
    name          text NOT NULL CHECK (name <> '' AND char_length(name) <= 200),
    media_type    text NOT NULL,
    size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
    storage_key   text NOT NULL,
    -- O texto extraído do anexo (cortado no teto); nulo no arquivo gerado.
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
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sessions, agent_messages, agent_files TO eclume_server;

-- O arquivo que sai leva o objeto do bucket. SECURITY DEFINER: quem exclui é o dono, sob a RLS,
-- sem acesso à fila.
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
