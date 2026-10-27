-- 023_cadastro_de_tags — tags gain a per-account registry, fixed by default (holetz/eclume#78).
--
-- `tags` is the user's registry: name, description ("quando usar") and source (`user`, or `auto` when
-- the agent created it). In the default mode (`users.tag_mode = 'fixed'`), the agent only chooses among the registered
-- tags; in the self-managed one (`auto`), it can create up to `tag_new_limit` per recording, always
-- preferring reuse, up to the registry's tag ceiling. `recordings.tags` is still the value that
-- search, the library and export read: the registry sits beside it, and rename, merge and delete
-- touch both. Patterns in docs/standards/code/processamento-automatico.md.

CREATE TABLE tags (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (name <> '' AND char_length(name) <= 64),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    origin       text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'auto')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One tag per name, accent- and case-insensitive.
CREATE UNIQUE INDEX tags_owner_name_idx ON tags (owner_id, lower(eclume_unaccent(name)));

ALTER TABLE users
    ADD COLUMN tag_mode       text NOT NULL DEFAULT 'fixed' CHECK (tag_mode IN ('fixed', 'auto')),
    ADD COLUMN tag_new_limit  integer NOT NULL DEFAULT 1 CHECK (tag_new_limit BETWEEN 0 AND 5);

-- Registers the tags already used in the recordings and in the types' default tags, with the most used spelling of
-- each name (accent- and case-insensitive).
INSERT INTO tags (owner_id, name)
SELECT owner_id, mode() WITHIN GROUP (ORDER BY tag)
FROM (
    SELECT r.owner_id, u.tag FROM recordings r, unnest(r.tags) AS u(tag)
    UNION ALL
    SELECT a.owner_id, u.tag FROM agenda_types a, unnest(a.default_tags) AS u(tag)
) used
WHERE btrim(tag) <> '' AND char_length(tag) <= 64
GROUP BY owner_id, lower(eclume_unaccent(tag));

-- The recordings now use the registry's spelling, without repeating the same tag written two ways.
UPDATE recordings r
SET tags = coalesce(
    (
        SELECT array_agg(x.name ORDER BY x.first_pos)
        FROM (
            SELECT tg.name, min(u.i) AS first_pos
            FROM unnest(r.tags) WITH ORDINALITY AS u(tag, i)
            JOIN tags tg ON tg.owner_id = r.owner_id AND lower(eclume_unaccent(tg.name)) = lower(eclume_unaccent(u.tag))
            GROUP BY tg.name
        ) x
    ),
    '{}'
)
WHERE cardinality(r.tags) > 0;

-- A new account receives in the registry the default tags of the types it gets.
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
    INSERT INTO tags (owner_id, name)
    SELECT target, min(u.tag)
    FROM agenda_types a, unnest(a.default_tags) AS u(tag)
    WHERE a.owner_id = target
    GROUP BY lower(eclume_unaccent(u.tag))
    ON CONFLICT DO NOTHING;
END
$$;

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tags_own ON tags
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO eclume_server;
