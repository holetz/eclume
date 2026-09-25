-- 002_agentes — agentes de sumarização (holetz/eclume#9): providers da organização, templates de
-- resumo (pessoais e padrões da organização) e resumos versionados, com isolamento por RLS.
--
-- Padrão do núcleo (docs/standards/code/server-nucleo.md): `org_id` em toda tabela, políticas por
-- comando lendo `eclume_org()`/`eclume_user()`, `ENABLE` + `FORCE ROW LEVEL SECURITY`. O worker
-- CPU (papel de sistema) grava o andamento dos resumos; `eclume_app` só cria e apaga.

-- O usuário da transação é admin ativo da organização (lido sob a RLS de `users`).
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
    -- `crypto.encrypt` (AES-GCM); a API devolve só `api_key_set`.
    api_key_encrypted  text,
    enabled            boolean NOT NULL DEFAULT true,
    options            jsonb NOT NULL DEFAULT '{}',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_providers_org_idx ON agent_providers (org_id, created_at, id);

-- --- templates ----------------------------------------------------------------------------------

-- `owner_id` nulo: padrão da organização (`scope: organization`), editado só por admin. O padrão
-- da organização para o resumo automático é `org_settings.summarization.default_template_id`;
-- `is_default` aqui é o padrão pessoal, no máximo um por usuário.
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

-- --- resumos ------------------------------------------------------------------------------------

-- Template e provider ficam em instantâneo (nome, tipo, instruções): o resumo sobrevive à edição
-- ou à exclusão deles.
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

-- --- padrões iniciais ---------------------------------------------------------------------------

-- Semeia os três templates padrão da organização e, se ela ainda não tem, faz da ata o template
-- padrão do resumo automático. Roda com o papel de sistema (`create_org` e esta migration).
CREATE OR REPLACE FUNCTION eclume_seed_summary_templates(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    ata uuid;
BEGIN
    IF EXISTS (SELECT 1 FROM summary_templates WHERE org_id = target AND owner_id IS NULL) THEN
        RETURN;
    END IF;
    -- Instantes distintos: a listagem ordena por `created_at` e os três nascem na mesma transação.
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

-- Providers: a organização lê (o resumo resolve o provider padrão sob a RLS); só admin escreve.
CREATE POLICY agent_providers_read ON agent_providers FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY agent_providers_insert ON agent_providers FOR INSERT
    WITH CHECK (org_id = eclume_org() AND eclume_admin());
CREATE POLICY agent_providers_update ON agent_providers FOR UPDATE
    USING (org_id = eclume_org() AND eclume_admin())
    WITH CHECK (org_id = eclume_org() AND eclume_admin());
CREATE POLICY agent_providers_delete ON agent_providers FOR DELETE
    USING (org_id = eclume_org() AND eclume_admin());

-- Templates: os padrões da organização e os próprios; o dono escreve os seus, o admin os da organização.
CREATE POLICY summary_templates_read ON summary_templates FOR SELECT
    USING (org_id = eclume_org() AND (owner_id IS NULL OR owner_id = eclume_user()));
CREATE POLICY summary_templates_insert ON summary_templates FOR INSERT
    WITH CHECK (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));
CREATE POLICY summary_templates_update ON summary_templates FOR UPDATE
    USING (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())))
    WITH CHECK (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));
CREATE POLICY summary_templates_delete ON summary_templates FOR DELETE
    USING (org_id = eclume_org() AND (owner_id = eclume_user() OR (owner_id IS NULL AND eclume_admin())));

-- Resumos herdam a visibilidade da transcrição; criar e apagar é do dono da gravação.
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

-- `org_settings`: a política da 001 valia para todo comando; vira só leitura, e a escrita é do
-- admin (o padrão da organização de templates aqui, o painel da #12 depois).
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
