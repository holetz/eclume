-- 032_agente_habilidades_e_acoes — as habilidades do usuário e as ações do Agente (holetz/eclume#145).
--
-- `agent_skills` guarda as habilidades da pessoa: um nome curto (`/nome` na conversa), a descrição
-- que o agente lê para escolher, as instruções em Markdown e, opcionalmente, as ferramentas
-- permitidas (nulo = todas). `agent_actions` é a proposta de ação que o agente fez e, ao mesmo
-- tempo, o registro de auditoria: os alvos congelados na proposta, quem confirmou e o resultado
-- por alvo. Ela sobrevive à exclusão da conversa (`SET NULL`) e sai só com a conta.
-- `agent_messages` ganha a habilidade usada na pergunta. Tudo sob a RLS do dono.
-- Regras em docs/standards/code/server-agentes.md §Agente.

CREATE TABLE agent_skills (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name           text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
    description    text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
    instructions   text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 8000),
    allowed_tools  text[],
    enabled        boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name)
);

CREATE TABLE agent_actions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- A conversa e a resposta que propuseram; nulas depois que a conversa sai (a auditoria fica).
    session_id     uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
    message_id     uuid REFERENCES agent_messages (id) ON DELETE SET NULL,
    tool           text NOT NULL,
    params         jsonb NOT NULL DEFAULT '{}',
    summary        text NOT NULL,
    -- [{recording_id, title}], congelados na proposta: é o que o cartão mostrou.
    targets        jsonb NOT NULL DEFAULT '[]',
    status         text NOT NULL DEFAULT 'proposed' CHECK (
        status IN ('proposed', 'queued', 'running', 'done', 'failed', 'cancelled', 'expired')
    ),
    -- {recording_id: {status: done|skipped|failed, detail}}, gravado junto com a operação de cada alvo.
    results        jsonb NOT NULL DEFAULT '{}',
    error          jsonb,
    confirmed_via  text CHECK (confirmed_via IN ('session', 'pat')),
    token_id       uuid,
    created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_at     timestamptz,
    finished_at    timestamptz
);
CREATE INDEX agent_actions_owner_idx ON agent_actions (owner_id, created_at DESC, id DESC);
CREATE INDEX agent_actions_message_idx ON agent_actions (message_id);

ALTER TABLE agent_messages
    ADD COLUMN skill_id uuid REFERENCES agent_skills (id) ON DELETE SET NULL,
    ADD COLUMN skill_name text;

ALTER TABLE agent_skills  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills  FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_skills_own ON agent_skills
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY agent_actions_own ON agent_actions
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skills, agent_actions TO eclume_app;
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skills, agent_actions TO eclume_server;
