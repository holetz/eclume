-- 010_campos_e_valores — the user's fields and each recording's values (holetz/eclume#33).
--
-- Title and tags are built-in fields (the value stays in `recordings.title`/`tags`, which search, the
-- library and export read; `field_values` keeps the source). The other fields are the
-- user's: text, list or choice, each with the rule the agent follows. Patterns in
-- docs/standards/code/processamento-automatico.md.

CREATE TABLE fields (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Slug of the name, unique per owner: the field's placeholder in the title pattern.
    key           text NOT NULL CHECK (key ~ '^[a-z0-9_]{1,64}$'),
    name          text NOT NULL CHECK (name <> ''),
    kind          text NOT NULL CHECK (kind IN ('text', 'list', 'choice')),
    builtin       text CHECK (builtin IN ('title', 'tags')),
    options       text[] NOT NULL DEFAULT '{}',
    instructions  text NOT NULL DEFAULT '',
    auto_fill     boolean NOT NULL DEFAULT true,
    position      integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, key),
    UNIQUE (id, owner_id),
    CHECK (kind <> 'choice' OR cardinality(options) > 0),
    CHECK (builtin IS NULL OR (builtin = 'title' AND kind = 'text') OR (builtin = 'tags' AND kind = 'list'))
);
CREATE UNIQUE INDEX fields_builtin_idx ON fields (owner_id, builtin) WHERE builtin IS NOT NULL;
CREATE INDEX fields_order_idx ON fields (owner_id, position, id);

CREATE TABLE field_values (
    recording_id         uuid NOT NULL,
    field_id             uuid NOT NULL,
    owner_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Text or choice → string; list → array of strings; `null` = nothing found.
    value                jsonb NOT NULL DEFAULT 'null',
    origin               text NOT NULL CHECK (origin IN ('auto', 'edited', 'accepted')),
    -- Transcript revision that filled it (automatic).
    transcript_revision  integer,
    provider_name        text,
    model                text,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (recording_id, field_id),
    FOREIGN KEY (recording_id, owner_id) REFERENCES recordings (id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (field_id, owner_id) REFERENCES fields (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX field_values_field_idx ON field_values (field_id);

-- An account's built-in fields, with the default rule. Idempotent.
CREATE FUNCTION eclume_seed_builtin_fields(target uuid) RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO fields (owner_id, key, name, kind, builtin, instructions, position)
    VALUES
        (target, 'titulo', 'Título', 'text', 'title',
         'Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas.', 1),
        (target, 'tags', 'Tags', 'list', 'tags',
         'De 1 a 5 tags curtas, em minúsculas. Prefira as tags que você já usa.', 2)
    ON CONFLICT DO NOTHING;
$$;
REVOKE ALL ON FUNCTION eclume_seed_builtin_fields(uuid) FROM PUBLIC;

-- Seeding a new account now also creates the built-in fields.
CREATE OR REPLACE FUNCTION eclume_seed_user_defaults(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, from_default_id)
    SELECT target, d.name, d.position, d.title_pattern, d.identify, d.default_tags, d.summary_instructions, d.id
    FROM default_agenda_types d
    WHERE d.include_for_new_users
    ON CONFLICT (owner_id, name) DO NOTHING;
    PERFORM eclume_seed_builtin_fields(target);
END
$$;

SELECT eclume_seed_builtin_fields(id) FROM users;

ALTER TABLE fields       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fields       FORCE ROW LEVEL SECURITY;
ALTER TABLE field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_values FORCE ROW LEVEL SECURITY;
CREATE POLICY fields_own ON fields
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY field_values_own ON field_values
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());

GRANT SELECT, INSERT, UPDATE, DELETE ON fields, field_values TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON fields, field_values TO eclume_server;
GRANT EXECUTE ON FUNCTION eclume_seed_builtin_fields(uuid) TO eclume_server;
