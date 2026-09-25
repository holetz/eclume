-- 005_identificacao_por_voz — impressão de voz por pessoa, sugestões por voz, consentimento LGPD e
-- trilha de auditoria (holetz/eclume#15). Regras em docs/standards/code/identificacao-por-voz.md.
--
-- A impressão de uma pessoa é o conjunto das suas AMOSTRAS: uma por locutor confirmado como ela,
-- com o vetor copiado de `speaker_embeddings`. A amostra vive enquanto o vínculo existir (FK para
-- `speakers` com cascata, e o gatilho de troca de `person_id`), então desligar, religar, mesclar,
-- retranscrever ou excluir a gravação tiram a contribuição exata.

-- --- pessoas: consentimento corrente ------------------------------------------------------------

ALTER TABLE people
    ADD COLUMN voice_consent_term_version text,
    ADD COLUMN voice_consent_by           uuid REFERENCES users (id) ON DELETE SET NULL;

-- Histórico de consentimento, só de inserção: quem registrou, quando e o texto exato do termo.
CREATE TABLE voice_consents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    person_id     uuid NOT NULL,
    status        text NOT NULL CHECK (status IN ('granted', 'revoked')),
    term_version  text NOT NULL,
    term_text     text NOT NULL,
    notes         text,
    recorded_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    recorded_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (person_id, org_id) REFERENCES people (id, org_id) ON DELETE CASCADE
);
CREATE INDEX voice_consents_person_idx ON voice_consents (person_id, recorded_at);

-- --- amostras da impressão ----------------------------------------------------------------------

CREATE TABLE voice_samples (
    transcript_id  uuid NOT NULL,
    speaker_id     text NOT NULL,
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    person_id      uuid NOT NULL,
    model          text NOT NULL,
    embedding      vector NOT NULL,
    talk_ms        bigint NOT NULL,
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (transcript_id, speaker_id),
    FOREIGN KEY (transcript_id, speaker_id) REFERENCES speakers (transcript_id, speaker_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, org_id) REFERENCES people (id, org_id) ON DELETE CASCADE
);
CREATE INDEX voice_samples_person_idx ON voice_samples (org_id, person_id, model);

-- --- sugestões ----------------------------------------------------------------------------------

CREATE TABLE speaker_suggestions (
    transcript_id  uuid NOT NULL,
    speaker_id     text NOT NULL,
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    person_id      uuid NOT NULL,
    score          double precision NOT NULL CHECK (score BETWEEN 0 AND 1),
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    decided_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (transcript_id, speaker_id, person_id),
    FOREIGN KEY (transcript_id, speaker_id) REFERENCES speakers (transcript_id, speaker_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, org_id) REFERENCES people (id, org_id) ON DELETE CASCADE
);
CREATE INDEX speaker_suggestions_person_idx ON speaker_suggestions (person_id) WHERE status = 'pending';

-- --- auditoria ----------------------------------------------------------------------------------

-- Nunca guarda vetores. `person_id` sem FK: o evento sobrevive à exclusão da pessoa.
CREATE TABLE voice_audit (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    person_id      uuid,
    person_name    text,
    actor_id       uuid REFERENCES users (id) ON DELETE SET NULL,
    event          text NOT NULL,
    transcript_id  uuid,
    speaker_id     text,
    score          double precision,
    details        jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX voice_audit_org_idx ON voice_audit (org_id, created_at DESC, id DESC);
CREATE INDEX voice_audit_person_idx ON voice_audit (person_id, created_at DESC);

-- Quem age na transação corrente (`app.user_id`), ou `NULL` no papel de sistema.
CREATE FUNCTION eclume_actor() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Toda amostra que sai deixa um evento, qualquer que seja o caminho (desligar, religar, mesclar,
-- retranscrever, excluir). Uma exclusão em lote liga `eclume.voice_quiet` e audita um evento só.
CREATE FUNCTION eclume_voice_sample_removed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF coalesce(current_setting('eclume.voice_quiet', true), '') <> 'on' THEN
            INSERT INTO voice_audit (org_id, person_id, person_name, actor_id, event, transcript_id, speaker_id)
            SELECT OLD.org_id, OLD.person_id, p.name, eclume_actor(), 'sample_removed', OLD.transcript_id, OLD.speaker_id
            FROM (SELECT 1) one LEFT JOIN people p ON p.id = OLD.person_id;
        END IF;
        RETURN OLD;
    END
    $$;
CREATE TRIGGER voice_samples_audit_delete
    AFTER DELETE ON voice_samples
    FOR EACH ROW EXECUTE FUNCTION eclume_voice_sample_removed();

-- Trocar ou tirar a pessoa de um locutor tira a amostra dele, e as sugestões pendentes deixam de
-- valer. SECURITY DEFINER: a amostra é da organização, e quem edita a transcrição é o dono dela.
CREATE FUNCTION eclume_voice_relink() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        DELETE FROM voice_samples
        WHERE transcript_id = NEW.transcript_id AND speaker_id = NEW.speaker_id
          AND person_id IS DISTINCT FROM NEW.person_id;
        RETURN NEW;
    END
    $$;
CREATE TRIGGER speakers_voice_relink
    AFTER UPDATE OF person_id ON speakers
    FOR EACH ROW WHEN (OLD.person_id IS DISTINCT FROM NEW.person_id)
    EXECUTE FUNCTION eclume_voice_relink();

-- Esquecer a voz de uma pessoa (revogar, excluir a impressão) ou de toda a organização (purga):
-- atravessa a visibilidade de gravação de quem pede, por isso é SECURITY DEFINER, restrita a
-- `eclume_org()`; a purga exige admin. Devolve `(amostras, sugestões)` apagadas.
CREATE FUNCTION eclume_voice_forget(target uuid, OUT samples bigint, OUT suggestions bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF target IS NULL AND NOT eclume_admin() THEN
            RAISE EXCEPTION 'só admin apaga as impressões da organização' USING ERRCODE = '42501';
        END IF;
        PERFORM set_config('eclume.voice_quiet', 'on', true);
        DELETE FROM voice_samples WHERE org_id = eclume_org() AND (target IS NULL OR person_id = target);
        GET DIAGNOSTICS samples = ROW_COUNT;
        DELETE FROM speaker_suggestions
        WHERE org_id = eclume_org() AND status = 'pending' AND (target IS NULL OR person_id = target);
        GET DIAGNOSTICS suggestions = ROW_COUNT;
        PERFORM set_config('eclume.voice_quiet', 'off', true);
    END
    $$;

-- --- RLS ----------------------------------------------------------------------------------------

ALTER TABLE voice_consents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_samples       ENABLE ROW LEVEL SECURITY;
ALTER TABLE speaker_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_audit         ENABLE ROW LEVEL SECURITY;

CREATE POLICY voice_consents_org ON voice_consents
    USING (org_id = eclume_org())
    WITH CHECK (org_id = eclume_org() AND recorded_by = eclume_user());

-- A impressão é da organização (a página da pessoa mostra as amostras a qualquer membro, e o
-- título só da gravação que ele vê); só o dono da gravação cria a amostra, ao confirmar o locutor.
CREATE POLICY voice_samples_read ON voice_samples FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY voice_samples_insert ON voice_samples FOR INSERT
    WITH CHECK (
        org_id = eclume_org()
        AND created_by = eclume_user()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );

CREATE POLICY speaker_suggestions_read ON speaker_suggestions FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM transcripts t WHERE t.id = transcript_id));
CREATE POLICY speaker_suggestions_update ON speaker_suggestions FOR UPDATE
    USING (
        org_id = eclume_org()
        AND EXISTS (
            SELECT 1 FROM transcripts t JOIN recordings r ON r.id = t.recording_id
            WHERE t.id = transcript_id AND r.owner_id = eclume_user()
        )
    );

CREATE POLICY voice_audit_read ON voice_audit FOR SELECT
    USING (org_id = eclume_org() AND eclume_admin());
CREATE POLICY voice_audit_insert ON voice_audit FOR INSERT
    WITH CHECK (org_id = eclume_org());

ALTER TABLE voice_consents      FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_samples       FORCE ROW LEVEL SECURITY;
ALTER TABLE speaker_suggestions FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_audit         FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON voice_consents      TO eclume_app;
GRANT SELECT, INSERT ON voice_samples       TO eclume_app;
GRANT SELECT, UPDATE ON speaker_suggestions TO eclume_app;
GRANT SELECT, INSERT ON voice_audit         TO eclume_app;
GRANT EXECUTE ON FUNCTION eclume_voice_forget(uuid) TO eclume_app;

-- --- limiar calibrado ---------------------------------------------------------------------------

-- O padrão antigo (0,75) era um palpite; o calibrado está em docs/project/calibracao-voz.md.
-- Só muda organização que nunca mexeu no limiar.
UPDATE org_settings
SET voice_identification = jsonb_set(voice_identification, '{suggestion_threshold}', to_jsonb(0.55::numeric))
WHERE (voice_identification ->> 'suggestion_threshold')::numeric = 0.75;
