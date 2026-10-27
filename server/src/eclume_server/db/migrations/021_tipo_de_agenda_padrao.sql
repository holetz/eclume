-- 021_tipo_de_agenda_padrao — every user has a fallback agenda type, and the title becomes
-- defined by the types only (holetz/eclume#76).
--
-- The fallback type ("Geral", with the "Padrão" badge on screen) cannot be deleted and is applied
-- when no other type fits with confidence, when it is the only one, with no detection agent or
-- when detection fails: every processed recording gets a type and, with it, the automatic summary.
-- Each type gains the title subject rule (`title_instructions`); when empty, the fallback type's
-- applies. The built-in title rule, which was edited in "Campos e regras", becomes the rule of the account's
-- fallback type. Patterns in docs/standards/code/processamento-automatico.md.

ALTER TABLE agenda_types
    ADD COLUMN is_fallback         boolean NOT NULL DEFAULT false,
    ADD COLUMN title_instructions  text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX agenda_types_fallback_idx ON agenda_types (owner_id) WHERE is_fallback;

-- The admin also writes the subject rule of the types they distribute.
ALTER TABLE default_agenda_types ADD COLUMN title_instructions text NOT NULL DEFAULT '';

-- An account's fallback type, with its built-in title rule. Idempotent. "Geral" already used
-- by a user type becomes "Geral (padrão)", as in migration 009.
CREATE FUNCTION eclume_seed_fallback_type(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM agenda_types WHERE owner_id = target AND is_fallback) THEN
        RETURN;
    END IF;
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, title_instructions, is_fallback)
    VALUES (
        target,
        CASE WHEN EXISTS (SELECT 1 FROM agenda_types WHERE owner_id = target AND name = 'Geral')
             THEN 'Geral (padrão)' ELSE 'Geral' END,
        0,
        '{assunto}',
        '',
        '{}',
        E'## Resumo\nDe duas a quatro frases sobre o que a conversa tratou.\n\n' ||
        E'## Decisões\nUm item por decisão tomada. Sem decisões, escreva "Nenhuma decisão registrada."\n\n' ||
        E'## Próximos passos\nUm item por tarefa combinada: responsável, o quê e quando, quando ditos.',
        coalesce(
            (SELECT instructions FROM fields WHERE owner_id = target AND builtin = 'title'),
            'Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas.'
        ),
        true
    );
END
$$;
REVOKE ALL ON FUNCTION eclume_seed_fallback_type(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eclume_seed_fallback_type(uuid) TO eclume_server;

-- Seeding a new account also creates the fallback type, after the built-in fields (it reads the title
-- rule).
CREATE OR REPLACE FUNCTION eclume_seed_user_defaults(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, title_instructions, from_default_id)
    SELECT target, d.name, d.position, d.title_pattern, d.identify, d.default_tags, d.summary_instructions,
           d.title_instructions, d.id
    FROM default_agenda_types d
    WHERE d.include_for_new_users
    ON CONFLICT (owner_id, name) DO NOTHING;
    PERFORM eclume_seed_builtin_fields(target);
    PERFORM eclume_seed_fallback_type(target);
END
$$;

SELECT eclume_seed_fallback_type(id) FROM users;

-- The title no longer has its own rule and switch on screen: the subject is always filled, by the
-- rule of the recording's type.
UPDATE fields SET auto_fill = true, updated_at = now() WHERE builtin = 'title' AND NOT auto_fill;
