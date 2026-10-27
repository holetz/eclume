-- 003_pessoas_e_busca — the organization's people directory, user collections, transcript
-- editing by the owner and accent-insensitive Portuguese full-text search (holetz/eclume#11).
--
-- Follows the 001_nucleo pattern: `org_id` in every table, policies over `eclume_org()` and
-- `eclume_user()`, `ENABLE` + `FORCE ROW LEVEL SECURITY` and GRANT of only what `eclume_app` needs.
-- The new write policies on `speakers`, `segments` and `speaker_embeddings` query
-- `transcripts` and `recordings`, never `recording_shares` or `group_members` (anti-recursion rule).

CREATE EXTENSION IF NOT EXISTS unaccent;

-- `unaccent()` is STABLE (it depends on the search_path); with the dictionary pinned, the result is immutable
-- and can go into a generated column.
CREATE OR REPLACE FUNCTION eclume_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- --- search ----------------------------------------------------------------------------------

-- Portuguese with accents removed before the stemmer: "reunião" finds "reuniao" and vice versa.
CREATE TEXT SEARCH CONFIGURATION eclume_pt (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION eclume_pt
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;

DROP INDEX segments_tsv_idx;
ALTER TABLE segments DROP COLUMN tsv;
ALTER TABLE segments
    ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('eclume_pt'::regconfig, text)) STORED;
CREATE INDEX segments_tsv_idx ON segments USING gin (tsv);

-- The `@@` operator is not LEAKPROOF: under RLS, the planner does not take it to the GIN index and scans every
-- visible segment. This function uses the GIN with the owner role, restricted to the transaction's organization,
-- and only returns keys; visibility is still decided by the `segments` policy, in the
-- `eclume_app` query that joins these keys to the table.
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

-- --- people ----------------------------------------------------------------------------------

CREATE TABLE people (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name                      text NOT NULL CHECK (name <> ''),
    email                     text,
    notes                     text,
    -- LGPD consent for the voiceprint; only stored here, the comparison belongs to #15.
    voice_consent_status      text NOT NULL DEFAULT 'none' CHECK (voice_consent_status IN ('none', 'granted', 'revoked')),
    voice_consent_updated_at  timestamptz,
    sort_name                 text GENERATED ALWAYS AS (lower(eclume_unaccent(name))) STORED,
    created_by                uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    -- Target of the composite FK of `speakers`: a link only within the same organization.
    UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX people_email_idx ON people (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX people_sort_idx ON people (org_id, sort_name, id);

ALTER TABLE speakers
    ADD CONSTRAINT speakers_person_fk FOREIGN KEY (person_id, org_id)
    REFERENCES people (id, org_id) ON DELETE SET NULL (person_id);

-- Renaming or deleting a person changes the name the transcripts show: bumps the `updated_at` of
-- every one they speak in, including those the editor cannot see, for the clients' `?since=`.
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
-- BEFORE: the links still exist (the FK's SET NULL runs after the deletion).
CREATE TRIGGER people_touch_on_delete
    BEFORE DELETE ON people
    FOR EACH ROW EXECUTE FUNCTION eclume_touch_person_transcripts();

-- --- collections -----------------------------------------------------------------------------

-- The user's. `recordings.collection_ids` stays an array (no FK possible): the API only accepts ids of
-- the owner's collections and removes the id from the recordings when the collection is deleted.
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

-- Transcript editing: only the recording's owner.
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
