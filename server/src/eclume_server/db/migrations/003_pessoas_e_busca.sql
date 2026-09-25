-- 003_pessoas_e_busca — diretório de pessoas da organização, coleções do usuário, edição da
-- transcrição pelo dono e busca full-text em português sem acento (holetz/eclume#11).
--
-- Segue o padrão de 001_nucleo: `org_id` em toda tabela, políticas sobre `eclume_org()` e
-- `eclume_user()`, `ENABLE` + `FORCE ROW LEVEL SECURITY` e GRANT só do necessário a `eclume_app`.
-- As políticas novas de escrita em `speakers`, `segments` e `speaker_embeddings` consultam
-- `transcripts` e `recordings`, nunca `recording_shares` ou `group_members` (regra anti-recursão).

CREATE EXTENSION IF NOT EXISTS unaccent;

-- `unaccent()` é STABLE (depende do search_path); com o dicionário fixado, o resultado é imutável
-- e pode entrar em coluna gerada.
CREATE OR REPLACE FUNCTION eclume_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- --- busca -----------------------------------------------------------------------------------

-- Português com acentos removidos antes do stemmer: "reunião" acha "reuniao" e vice-versa.
CREATE TEXT SEARCH CONFIGURATION eclume_pt (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION eclume_pt
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;

DROP INDEX segments_tsv_idx;
ALTER TABLE segments DROP COLUMN tsv;
ALTER TABLE segments
    ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('eclume_pt'::regconfig, text)) STORED;
CREATE INDEX segments_tsv_idx ON segments USING gin (tsv);

-- O operador `@@` não é LEAKPROOF: sob a RLS, o planner não o leva ao índice GIN e varre todos os
-- segmentos visíveis. Esta função usa o GIN com o papel dono, restrita à organização da transação,
-- e só devolve chaves; quem decide a visibilidade continua sendo a política de `segments`, na
-- consulta de `eclume_app` que junta estas chaves à tabela.
CREATE FUNCTION eclume_segment_matches(query tsquery)
    RETURNS TABLE (transcript_id uuid, segment_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
        SELECT s.transcript_id, s.segment_id FROM segments s
        WHERE s.org_id = eclume_org() AND s.tsv @@ query
    $$;
REVOKE ALL ON FUNCTION eclume_segment_matches(tsquery) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eclume_segment_matches(tsquery) TO eclume_app;

-- --- pessoas ---------------------------------------------------------------------------------

CREATE TABLE people (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name                      text NOT NULL CHECK (name <> ''),
    email                     text,
    notes                     text,
    -- Consentimento LGPD da impressão de voz; só armazenado aqui, a comparação é da #15.
    voice_consent_status      text NOT NULL DEFAULT 'none' CHECK (voice_consent_status IN ('none', 'granted', 'revoked')),
    voice_consent_updated_at  timestamptz,
    sort_name                 text GENERATED ALWAYS AS (lower(eclume_unaccent(name))) STORED,
    created_by                uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    -- Alvo da FK composta de `speakers`: vínculo só dentro da mesma organização.
    UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX people_email_idx ON people (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX people_sort_idx ON people (org_id, sort_name, id);

ALTER TABLE speakers
    ADD CONSTRAINT speakers_person_fk FOREIGN KEY (person_id, org_id)
    REFERENCES people (id, org_id) ON DELETE SET NULL (person_id);

-- Renomear ou excluir uma pessoa muda o nome que as transcrições mostram: sobe o `updated_at` de
-- todas em que ela fala, inclusive as que quem editou não vê, para o `?since=` dos clientes.
CREATE FUNCTION eclume_touch_person_transcripts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        UPDATE transcripts t SET updated_at = now()
        WHERE EXISTS (SELECT 1 FROM speakers s WHERE s.transcript_id = t.id AND s.person_id = OLD.id);
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END
    $$;
CREATE TRIGGER people_touch_on_rename
    AFTER UPDATE OF name ON people
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION eclume_touch_person_transcripts();
-- BEFORE: os vínculos ainda existem (o SET NULL da FK roda depois da exclusão).
CREATE TRIGGER people_touch_on_delete
    BEFORE DELETE ON people
    FOR EACH ROW EXECUTE FUNCTION eclume_touch_person_transcripts();

-- --- coleções --------------------------------------------------------------------------------

-- Do usuário. `recordings.collection_ids` segue array (sem FK possível): a API só aceita ids de
-- coleções do dono e tira o id das gravações ao excluir a coleção.
CREATE TABLE collections (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    owner_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (name <> ''),
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collections_owner_idx ON collections (owner_id, lower(name), id);

-- --- RLS -------------------------------------------------------------------------------------

ALTER TABLE people      ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY people_org ON people
    USING (org_id = eclume_org()) WITH CHECK (org_id = eclume_org());

CREATE POLICY collections_own ON collections
    USING (org_id = eclume_org() AND owner_id = eclume_user())
    WITH CHECK (org_id = eclume_org() AND owner_id = eclume_user());

-- Edição da transcrição: só o dono da gravação.
CREATE POLICY speakers_update ON speakers FOR UPDATE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );
CREATE POLICY speakers_delete ON speakers FOR DELETE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );
CREATE POLICY segments_update ON segments FOR UPDATE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );
CREATE POLICY speaker_embeddings_delete ON speaker_embeddings FOR DELETE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );

ALTER TABLE people      FORCE ROW LEVEL SECURITY;
ALTER TABLE collections FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON people             TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON collections        TO eclume_app;
GRANT UPDATE, DELETE                 ON speakers           TO eclume_app;
GRANT UPDATE                         ON segments           TO eclume_app;
GRANT DELETE                         ON speaker_embeddings TO eclume_app;
