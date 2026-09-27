-- 009_tipos_de_agenda — os templates de resumo viram tipos de agenda (holetz/eclume#33).
--
-- Cada template (todos têm dono desde a 008) vira um tipo de agenda do dono, com o mesmo id: os
-- resumos que o citavam continuam válidos. O admin passa a manter os tipos padrão
-- (`default_agenda_types`), semeados com os quatro tipos do protótipo e copiados para toda conta,
-- nova ou existente. Antes disso, amarra o dono dos filhos ao do pai por FKs compostas, no padrão
-- que a 008 usa em `people`. Padrões em docs/standards/code/processamento-automatico.md.

-- --- 1. dono do filho = dono do pai ------------------------------------------------------------

-- A RLS confere só `owner_id`; as FKs compostas garantem que ele é o da gravação (ou da transcrição).
ALTER TABLE recordings  ADD CONSTRAINT recordings_id_owner_id_key  UNIQUE (id, owner_id);
ALTER TABLE transcripts ADD CONSTRAINT transcripts_id_owner_id_key UNIQUE (id, owner_id);

ALTER TABLE transcription_jobs DROP CONSTRAINT transcription_jobs_recording_id_fkey;
ALTER TABLE transcription_jobs
    ADD CONSTRAINT transcription_jobs_recording_fk FOREIGN KEY (recording_id, owner_id)
    REFERENCES recordings (id, owner_id) ON DELETE CASCADE;
ALTER TABLE transcripts DROP CONSTRAINT transcripts_recording_id_fkey;
ALTER TABLE transcripts
    ADD CONSTRAINT transcripts_recording_fk FOREIGN KEY (recording_id, owner_id)
    REFERENCES recordings (id, owner_id) ON DELETE CASCADE;

ALTER TABLE speakers           DROP CONSTRAINT speakers_transcript_id_fkey;
ALTER TABLE segments           DROP CONSTRAINT segments_transcript_id_fkey;
ALTER TABLE speaker_embeddings DROP CONSTRAINT speaker_embeddings_transcript_id_fkey;
ALTER TABLE summaries          DROP CONSTRAINT summaries_transcript_id_fkey;

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'speakers', 'segments', 'speaker_embeddings', 'summaries', 'voice_samples', 'speaker_suggestions'
    ] LOOP
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (transcript_id, owner_id)'
            ' REFERENCES transcripts (id, owner_id) ON DELETE CASCADE',
            tbl, tbl || '_transcript_fk'
        );
    END LOOP;
END
$$;

-- Com locutor, amostra e pessoa sempre do mesmo dono, os gatilhos de pessoa e de voz não
-- atravessam contas: rodam com os direitos de quem edita, sob a RLS dele.
ALTER FUNCTION eclume_touch_person_transcripts() SECURITY INVOKER;
ALTER FUNCTION eclume_voice_relink() SECURITY INVOKER;

-- --- 2. tipos de agenda ------------------------------------------------------------------------

CREATE TABLE agenda_types (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name                  text NOT NULL CHECK (name <> ''),
    position              integer NOT NULL DEFAULT 0,
    -- Marcadores: {assunto}, {data}, {tipo} e {<chave do campo>}.
    title_pattern         text,
    identify              text NOT NULL DEFAULT '',
    default_tags          text[] NOT NULL DEFAULT '{}',
    summary_instructions  text NOT NULL CHECK (summary_instructions <> ''),
    -- O tipo padrão de que foi copiado, só como informação.
    from_default_id       uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name),
    UNIQUE (id, owner_id)
);
CREATE INDEX agenda_types_order_idx ON agenda_types (owner_id, position, created_at, id);

-- Da plataforma, como `platform_settings`: sem dono, sem RLS e sem GRANT a `eclume_app`.
CREATE TABLE default_agenda_types (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   text NOT NULL UNIQUE CHECK (name <> ''),
    position               integer NOT NULL DEFAULT 0,
    title_pattern          text,
    identify               text NOT NULL DEFAULT '',
    default_tags           text[] NOT NULL DEFAULT '{}',
    summary_instructions   text NOT NULL CHECK (summary_instructions <> ''),
    include_for_new_users  boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE recordings
    ADD COLUMN agenda_type_id      uuid,
    ADD COLUMN agenda_type_origin  text CHECK (agenda_type_origin IN ('auto', 'edited')),
    ADD CONSTRAINT recordings_agenda_type_fk FOREIGN KEY (agenda_type_id, owner_id)
        REFERENCES agenda_types (id, owner_id) ON DELETE SET NULL (agenda_type_id);

-- Instantâneos, como antes: sem FK, o resumo sobrevive ao tipo.
ALTER TABLE summaries RENAME COLUMN template_id TO agenda_type_id;
ALTER TABLE summaries RENAME COLUMN template_name TO agenda_type_name;

-- --- 3. templates → tipos do dono --------------------------------------------------------------

INSERT INTO agenda_types (id, owner_id, name, position, identify, summary_instructions, created_at, updated_at)
SELECT
    id,
    owner_id,
    name,
    row_number() OVER (PARTITION BY owner_id ORDER BY created_at, id),
    coalesce(description, ''),
    instructions,
    created_at,
    updated_at
FROM summary_templates;

-- --- 4. tipos padrão do admin ------------------------------------------------------------------

INSERT INTO default_agenda_types (name, position, title_pattern, identify, default_tags, summary_instructions)
VALUES
    (
        'Reunião de equipe',
        1,
        'Reunião de equipe · {assunto}',
        'Reunião recorrente da equipe interna para planejar ou revisar trabalho. Não é conversa com '
        'cliente nem 1:1.',
        '{interno,planejamento}',
        E'## Resumo\nDe duas a quatro frases sobre o que a reunião tratou.\n\n' ||
        E'## Decisões\nUm item por decisão, com quem é o responsável.\n\n' ||
        E'## Próximos passos\nUm item por tarefa: responsável, o quê e quando.'
    ),
    (
        '1:1',
        2,
        NULL,
        'Conversa entre duas pessoas da mesma equipe sobre andamento, dificuldades e desenvolvimento.',
        '{}',
        E'## Pontos tratados\nUm item por assunto, em uma ou duas frases.\n\n' ||
        E'## Combinados\nUm item por acompanhamento combinado: quem, o quê e até quando.'
    ),
    (
        'Conversa com cliente',
        3,
        NULL,
        'Conversa com alguém de fora da equipe para quem o trabalho é feito.',
        '{}',
        E'## Pedidos do cliente\nUm item por pedido, com o contexto em uma frase.\n\n' ||
        E'## Compromissos assumidos\nUm item por compromisso: quem assumiu e o quê.\n\n' ||
        E'## Prazos\nUm item por prazo citado, com a data como foi dita.'
    ),
    (
        'Nota de voz',
        4,
        NULL,
        'Uma pessoa só falando: ideia, lembrete ou rascunho ditado.',
        '{}',
        'Reescreva o que foi ditado como texto limpo, em parágrafos, sem hesitações nem repetições. '
        'Mantenha as ideias na ordem em que vieram e não acrescente nada.'
    );

-- Contas existentes também recebem os padrões (os templates convertidos não dizem como identificar,
-- e a detecção ficaria às cegas), depois dos tipos delas; um nome já usado ganha " (padrão)".
INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags, summary_instructions,
                          from_default_id)
SELECT
    u.id,
    CASE WHEN EXISTS (SELECT 1 FROM agenda_types a WHERE a.owner_id = u.id AND a.name = d.name)
         THEN d.name || ' (padrão)' ELSE d.name END,
    coalesce((SELECT max(a.position) FROM agenda_types a WHERE a.owner_id = u.id), 0) + d.position,
    d.title_pattern,
    d.identify,
    d.default_tags,
    d.summary_instructions,
    d.id
FROM users u CROSS JOIN default_agenda_types d;

-- Semeia o que toda conta nova recebe: os tipos padrão marcados para contas novas. Idempotente (um
-- nome que a conta já tem fica como está). Roda com o papel de conexão, no cadastro.
CREATE FUNCTION eclume_seed_user_defaults(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, from_default_id)
    SELECT target, d.name, d.position, d.title_pattern, d.identify, d.default_tags, d.summary_instructions, d.id
    FROM default_agenda_types d
    WHERE d.include_for_new_users
    ON CONFLICT (owner_id, name) DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION eclume_seed_user_defaults(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eclume_seed_user_defaults(uuid) TO eclume_server;

-- --- 5. remoções -------------------------------------------------------------------------------

DROP FUNCTION eclume_seed_summary_templates(uuid);
DROP TABLE summary_templates;

-- --- 6. RLS e GRANTs ---------------------------------------------------------------------------

ALTER TABLE agenda_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_types FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_types_own ON agenda_types
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON agenda_types TO eclume_app;

-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON agenda_types, default_agenda_types TO eclume_server;
