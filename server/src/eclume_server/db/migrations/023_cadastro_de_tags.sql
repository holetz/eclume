-- 023_cadastro_de_tags — as tags ganham cadastro por conta, fixo por padrão (holetz/eclume#78).
--
-- `tags` é o cadastro do usuário: nome, descrição ("quando usar") e origem (`user`, ou `auto` quando
-- o agente criou). No modo padrão (`users.tag_mode = 'fixed'`), o agente só escolhe entre as tags
-- cadastradas; no autogerenciado (`auto`), pode criar até `tag_new_limit` por gravação, sempre
-- preferindo reusar, até o teto de tags do cadastro. `recordings.tags` continua sendo o valor que a
-- busca, a biblioteca e a exportação leem: o cadastro fica ao lado, e renomear, mesclar e excluir
-- mexem nos dois. Padrões em docs/standards/code/processamento-automatico.md.

CREATE TABLE tags (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (name <> '' AND char_length(name) <= 64),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    origin       text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'auto')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Uma tag por nome, sem acento e sem caixa.
CREATE UNIQUE INDEX tags_owner_name_idx ON tags (owner_id, lower(eclume_unaccent(name)));

ALTER TABLE users
    ADD COLUMN tag_mode       text NOT NULL DEFAULT 'fixed' CHECK (tag_mode IN ('fixed', 'auto')),
    ADD COLUMN tag_new_limit  integer NOT NULL DEFAULT 1 CHECK (tag_new_limit BETWEEN 0 AND 5);

-- Cadastra as tags já usadas nas gravações e nas tags padrão dos tipos, com a grafia mais usada de
-- cada nome (sem acento e sem caixa).
INSERT INTO tags (owner_id, name)
SELECT owner_id, mode() WITHIN GROUP (ORDER BY tag)
FROM (
    SELECT r.owner_id, u.tag FROM recordings r, unnest(r.tags) AS u(tag)
    UNION ALL
    SELECT a.owner_id, u.tag FROM agenda_types a, unnest(a.default_tags) AS u(tag)
) used
WHERE btrim(tag) <> '' AND char_length(tag) <= 64
GROUP BY owner_id, lower(eclume_unaccent(tag));

-- As gravações passam a usar a grafia do cadastro, sem repetir a mesma tag escrita de dois jeitos.
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

-- A conta nova recebe no cadastro as tags padrão dos tipos que ganha.
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
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO eclume_server;
