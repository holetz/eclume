-- 009_tipos_de_agenda — the summary templates become agenda types (holetz/eclume#33).
--
-- Every template (all have an owner since 008) becomes an agenda type of the owner, with the same id: the
-- summaries that cited it stay valid. The admin now maintains the default types
-- (`default_agenda_types`), seeded with the prototype's four types and copied to every account,
-- new or existing. Before that, it ties the children's owner to the parent's with composite FKs, in the pattern
-- 008 uses in `people`. Patterns in docs/standards/code/processamento-automatico.md.

-- --- 1. child's owner = parent's owner ---------------------------------------------------------

-- RLS only checks `owner_id`; the composite FKs guarantee it is the recording's (or the transcript's).
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

-- With speaker, sample and person always of the same owner, the person and voice triggers do not
-- cross accounts: they run with the editor's rights, under their RLS.
ALTER FUNCTION eclume_touch_person_transcripts() SECURITY INVOKER;
ALTER FUNCTION eclume_voice_relink() SECURITY INVOKER;

-- --- 2. agenda types ---------------------------------------------------------------------------

CREATE TABLE agenda_types (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name                  text NOT NULL CHECK (name <> ''),
    position              integer NOT NULL DEFAULT 0,
    -- Placeholders: {assunto}, {data}, {tipo} and {<field key>}.
    title_pattern         text,
    identify              text NOT NULL DEFAULT '',
    default_tags          text[] NOT NULL DEFAULT '{}',
    summary_instructions  text NOT NULL CHECK (summary_instructions <> ''),
    -- The default type it was copied from, for information only.
    from_default_id       uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name),
    UNIQUE (id, owner_id)
);
CREATE INDEX agenda_types_order_idx ON agenda_types (owner_id, position, created_at, id);

-- The platform's, like `platform_settings`: no owner, no RLS and no GRANT to `eclume_app`.
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

-- Snapshots, as before: no FK, the summary survives the type.
ALTER TABLE summaries RENAME COLUMN template_id TO agenda_type_id;
ALTER TABLE summaries RENAME COLUMN template_name TO agenda_type_name;

-- --- 3. templates → the owner's types ----------------------------------------------------------

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

-- --- 4. the admin's default types --------------------------------------------------------------

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

-- Existing accounts also receive the defaults (the converted templates do not say how to identify,
-- and detection would be blind), after their own types; a name already in use gets " (padrão)".
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

-- Seeds what every new account receives: the default types marked for new accounts. Idempotent (a
-- name the account already has stays as is). Runs with the connection role, at sign-up.
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

-- --- 5. removals -------------------------------------------------------------------------------

DROP FUNCTION eclume_seed_summary_templates(uuid);
DROP TABLE summary_templates;

-- --- 6. RLS and GRANTs -------------------------------------------------------------------------

ALTER TABLE agenda_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_types FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_types_own ON agenda_types
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON agenda_types TO eclume_app;

-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON agenda_types, default_agenda_types TO eclume_server;
