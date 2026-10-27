-- 032_agente_habilidades_e_acoes — the user's skills and the Agent's actions (holetz/eclume#145).
--
-- `agent_skills` keeps the person's skills: a short name (`/name` in the conversation), the description
-- the agent reads to choose, the instructions in Markdown and, optionally, the allowed
-- tools (null = all). `agent_actions` is the action proposal the agent made and, at the same
-- time, the audit record: the targets frozen in the proposal, who confirmed and the result
-- per target. It survives the conversation's deletion (`SET NULL`) and only goes with the account.
-- `agent_messages` gains the skill used in the question. All under the owner's RLS.
-- Rules in docs/standards/code/server-agentes.md `§Agente`.

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
    -- The conversation and the answer that proposed it; null after the conversation goes (the audit stays).
    session_id     uuid REFERENCES agent_sessions (id) ON DELETE SET NULL,
    message_id     uuid REFERENCES agent_messages (id) ON DELETE SET NULL,
    tool           text NOT NULL,
    params         jsonb NOT NULL DEFAULT '{}',
    summary        text NOT NULL,
    -- [{recording_id, title}], frozen in the proposal: it is what the card showed.
    targets        jsonb NOT NULL DEFAULT '[]',
    status         text NOT NULL DEFAULT 'proposed' CHECK (
        status IN ('proposed', 'queued', 'running', 'done', 'failed', 'cancelled', 'expired')
    ),
    -- {recording_id: {status: done|skipped|failed, detail}}, written together with each target's operation.
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
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_skills, agent_actions TO eclume_server;
