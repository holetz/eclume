-- 002_agentes — summarization agents (holetz/eclume#9): the organization's providers, summary
-- templates (personal and organization defaults) and versioned summaries, isolated by RLS.
--
-- Core pattern (docs/standards/code/server-nucleo.md): `org_id` in every table, per-command
-- policies reading `eclume_org()`/`eclume_user()`, `ENABLE` + `FORCE ROW LEVEL SECURITY`. The CPU
-- worker (system role) writes the summaries' progress; `eclume_app` only creates and deletes.

-- The transaction's user is an active admin of the organization (read under the RLS of `users`).
CREATE OR REPLACE FUNCTION eclume_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
        SELECT EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = eclume_user() AND u.org_id = eclume_org() AND u.role = 'admin' AND u.active
        )
    $$;

-- --- providers ----------------------------------------------------------------------------------

CREATE TABLE agent_providers (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name               text NOT NULL,
    kind               text NOT NULL CHECK (kind IN ('ollama', 'openai-compatible', 'anthropic', 'claude-cli')),
    base_url           text,
    model              text NOT NULL,
    -- `crypto.encrypt` (AES-GCM); the API only returns `api_key_set`.
    api_key_encrypted  text,
    enabled            boolean NOT NULL DEFAULT true,
    options            jsonb NOT NULL DEFAULT '{}',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_providers_org_idx ON agent_providers (org_id, created_at, id);

-- --- templates ----------------------------------------------------------------------------------

-- Null `owner_id`: organization default (`scope: organization`), edited by admins only. The
-- organization's default for the automatic summary is `org_settings.summarization.default_template_id`;
-- `is_default` here is the personal default, at most one per user.
CREATE TABLE summary_templates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    owner_id      uuid REFERENCES users (id) ON DELETE CASCADE,
    name          text NOT NULL,
    description   text,
    instructions  text NOT NULL,
    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (owner_id IS NOT NULL OR NOT is_default)
);
CREATE INDEX summary_templates_org_idx ON summary_templates (org_id, created_at, id);
CREATE UNIQUE INDEX summary_templates_default_idx ON summary_templates (owner_id) WHERE is_default;

-- --- summaries ----------------------------------------------------------------------------------

-- Template and provider are kept as a snapshot (name, type, instructions): the summary survives their
-- editing or deletion.
CREATE TABLE summaries (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    transcript_id        uuid NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
    transcript_revision  integer NOT NULL,
    template_id          uuid NOT NULL,
    template_name        text NOT NULL,
    instructions         text NOT NULL,
    version              integer NOT NULL,
    status               text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    trigger              text NOT NULL CHECK (trigger IN ('manual', 'automatic')),
    provider_id          uuid NOT NULL,
    provider_name        text NOT NULL,
    provider_kind        text NOT NULL,
    model                text NOT NULL,
    content_md           text,
    error_code           text,
    error_message        text,
    attempts             integer NOT NULL DEFAULT 0,
    created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    started_at           timestamptz,
    completed_at         timestamptz,
    UNIQUE (transcript_id, template_id, version)
);
CREATE INDEX summaries_transcript_idx ON summaries (transcript_id, created_at DESC, id DESC);
CREATE INDEX summaries_provider_open_idx ON summaries (provider_id) WHERE status IN ('queued', 'running');

-- --- initial defaults ---------------------------------------------------------------------------

-- Seeds the organization's three default templates and, if it has none yet, makes the minutes the
-- default template of the automatic summary. Runs with the system role (`create_org` and this migration).
CREATE OR REPLACE FUNCTION eclume_seed_summary_templates(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    ata uuid;
BEGIN
    IF EXISTS (SELECT 1 FROM summary_templates WHERE org_id = target AND owner_id IS NULL) THEN
        RETURN;
    END IF;
    -- Distinct instants: the listing sorts by `created_at` and all three are born in the same transaction.
    INSERT INTO summary_templates (org_id, name, description, instructions, created_at, updated_at)
    VALUES (
        target,
        'Ata de reunião',
        'Decisões e encaminhamentos com responsável.',
        'Escreva a ata da reunião em Markdown, com as seções Contexto (uma ou duas frases), '
        'Participantes, Pontos discutidos, Decisões e Encaminhamentos. Cada encaminhamento é uma '
        'caixa de seleção (`- [ ]`) com responsável e prazo, quando ditos. Use os nomes dos '
        'locutores como aparecem na transcrição. Não invente o que não foi dito.',
        now(),
        now()
    )
    RETURNING id INTO ata;
    INSERT INTO summary_templates (org_id, name, description, instructions, created_at, updated_at)
    VALUES
        (
            target,
            'Resumo executivo',
            'Até cinco tópicos para a diretoria.',
            'Resuma a reunião para a diretoria em até cinco tópicos: objetivo, principais '
            'conclusões, riscos, decisões e próximos passos. Frases curtas, sem detalhes '
            'operacionais. Não invente o que não foi dito.',
            now() + interval '1 millisecond',
            now() + interval '1 millisecond'
        ),
        (
            target,
            'Decisões e ações',
            'Só o que foi decidido e o que ficou combinado.',
            'Liste só as decisões tomadas e as ações combinadas, em duas seções Markdown: '
            'Decisões (uma por item) e Ações (`- [ ] ação — responsável — prazo`, com "a definir" '
            'quando não dito). Indique o momento aproximado (HH:MM:SS) de cada item. Não invente '
            'o que não foi dito.',
            now() + interval '2 milliseconds',
            now() + interval '2 milliseconds'
        );
    UPDATE org_settings
    SET summarization = jsonb_set(summarization, '{default_template_id}', to_jsonb(ata::text))
    WHERE org_id = target AND summarization->>'default_template_id' IS NULL;
END
$$;
REVOKE ALL ON FUNCTION eclume_seed_summary_templates(uuid) FROM PUBLIC;

SELECT eclume_seed_summary_templates(id) FROM organizations;

-- --- RLS ----------------------------------------------------------------------------------------

ALTER TABLE agent_providers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries         ENABLE ROW LEVEL SECURITY;

-- Providers: the organization reads (the summary resolves the default provider under RLS); only admins write.
CREATE POLICY agent_providers_read ON agent_providers FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY agent_providers_insert ON agent_providers FOR INSERT
    WITH CHECK (org_id = eclume_org() AND eclume_admin());
CREATE POLICY agent_providers_update ON agent_providers FOR UPDATE
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org() AND eclume_admin());
CREATE POLICY agent_providers_delete ON agent_providers FOR DELETE
    USING (org_id = eclume_org() AND eclume_admin());

-- Templates: the organization defaults and one's own; the owner writes theirs, the admin the organization's.
CREATE POLICY summary_templates_read ON summary_templates FOR SELECT
    USING (org_id = eclume_org() AND (owner_id IS NULL OR owner_id = eclume_user()));
CREATE POLICY summary_templates_insert ON summary_templates FOR INSERT
    WITH CHECK (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));
CREATE POLICY summary_templates_update ON summary_templates FOR UPDATE
    USING (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())))
    WITH CHECK (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));
CREATE POLICY summary_templates_delete ON summary_templates FOR DELETE
    USING (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));

-- Summaries inherit the transcript's visibility; creating and deleting belongs to the recording's owner.
CREATE POLICY summaries_read ON summaries FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM transcripts t WHERE t.id = transcript_id));
CREATE POLICY summaries_insert ON summaries FOR INSERT
    WITH CHECK (
        org_id = eclume_org()
        AND created_by = eclume_user()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );
CREATE POLICY summaries_delete ON summaries FOR DELETE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );

-- `org_settings`: the policy from 001 applied to every command; it becomes read-only, and writing belongs to the
-- admin (the organization's template default here, the panel of #12 later).
DROP POLICY org_settings_org ON org_settings;
CREATE POLICY org_settings_read ON org_settings FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY org_settings_admin_update ON org_settings FOR UPDATE
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org() AND eclume_admin());

ALTER TABLE agent_providers   FORCE ROW LEVEL SECURITY;
ALTER TABLE summary_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE summaries         FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_providers   TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON summary_templates TO eclume_app;
GRANT SELECT, INSERT, DELETE         ON summaries         TO eclume_app;
GRANT UPDATE                         ON org_settings      TO eclume_app;
