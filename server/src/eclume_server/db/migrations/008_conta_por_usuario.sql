-- 008_conta_por_usuario — cada usuário tem o próprio espaço (holetz/eclume#32). Sai a organização
-- e, com ela, grupos, compartilhamento, convites, consentimento de voz por pessoa e a auditoria de
-- voz. A RLS passa a isolar por dono (`owner_id = eclume_user()`), a configuração e os segredos
-- viram da plataforma, e o admin ganha conta e sessão próprias (`admins`, `admin_sessions`).
--
-- Preserva os dados: cada usuário vira uma conta independente, dona do que já era dela; os admins
-- ganham conta de admin com o mesmo e-mail e hash; pessoas e templates da organização ficam com o
-- dono e, para os outros usuários que os usavam, viram cópias. Padrões em
-- docs/standards/code/server-nucleo.md. Uma transação só, como toda migration do runner.

-- --- 1. solta as amarras -----------------------------------------------------------------------

DO $$
DECLARE
    p record;
BEGIN
    FOR p IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP POLICY %I ON %I', p.policyname, p.tablename);
    END LOOP;
END
$$;

DROP TRIGGER voice_samples_audit_delete ON voice_samples;
DROP FUNCTION eclume_voice_sample_removed();
DROP FUNCTION eclume_voice_forget(uuid);
DROP FUNCTION eclume_purge_speaker_embeddings();
-- Repontar locutores para a cópia da pessoa (passo 5) não pode apagar as amostras deles.
ALTER TABLE speakers DISABLE TRIGGER speakers_voice_relink;

-- Organização de origem da configuração da plataforma: a mais antiga (em produção, a única).
CREATE TEMP TABLE _origin ON COMMIT DROP AS
SELECT id FROM organizations ORDER BY created_at, id LIMIT 1;

-- --- 2. contas de admin ------------------------------------------------------------------------

-- Sem RLS e sem GRANT para `eclume_app`, como `sessions`: só o papel de conexão as lê.
CREATE TABLE admins (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email          text NOT NULL,
    name           text NOT NULL,
    password_hash  text NOT NULL,
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz
);
CREATE UNIQUE INDEX admins_email_idx ON admins (lower(email));

CREATE TABLE admin_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  text NOT NULL UNIQUE,
    csrf_token  text NOT NULL,
    admin_id    uuid NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

-- O mesmo e-mail segue em `users`: são contas distintas, e a sessão de usuário dele continua valendo.
INSERT INTO admins (email, name, password_hash, active, created_at, last_login_at)
SELECT email, name, password_hash, active, created_at, last_login_at
FROM users WHERE role = 'admin'
ORDER BY created_at, id;

-- Conta de admin que corresponde a um usuário (mesmo e-mail), para os `updated_by`.
CREATE TEMP TABLE _admin_of ON COMMIT DROP AS
SELECT u.id AS user_id, a.id AS admin_id
FROM users u JOIN admins a ON lower(a.email) = lower(u.email);

-- --- 3. plataforma -----------------------------------------------------------------------------

CREATE TABLE platform_settings (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    asr                   jsonb NOT NULL,
    diarization           jsonb NOT NULL,
    summarization         jsonb NOT NULL,
    voice_identification  jsonb NOT NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES admins (id) ON DELETE SET NULL
);

INSERT INTO platform_settings (asr, diarization, summarization, voice_identification, updated_at, updated_by)
SELECT
    s.asr,
    s.diarization,
    s.summarization - 'default_template_id',
    s.voice_identification - 'consent_term_version' - 'consent_term_text',
    s.updated_at,
    (SELECT a.admin_id FROM _admin_of a WHERE a.user_id = s.updated_by)
FROM org_settings s JOIN _origin o ON o.id = s.org_id;

-- Banco novo (sem organização): os padrões. A identificação por voz nasce desligada.
INSERT INTO platform_settings (asr, diarization, summarization, voice_identification)
SELECT
    '{"engine": "whisperx-local", "model": "large-v3-turbo", "compute_type": "int8_float16",
      "batch_size": null, "default_language": "pt", "fallback_model": "medium",
      "endpoint_url": null}'::jsonb,
    '{"enabled": true, "model": "pyannote/speaker-diarization-community-1",
      "min_speakers": null, "max_speakers": null}'::jsonb,
    '{"default_provider_id": null, "auto_summarize": false}'::jsonb,
    '{"enabled": false, "suggestion_threshold": 0.55}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM platform_settings);

-- `crypto.encrypt` (AES-GCM) sem dado associado à organização: o texto cifrado passa como está.
CREATE TABLE platform_secrets (
    name             text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{1,63}$'),
    value_encrypted  text NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       uuid REFERENCES admins (id) ON DELETE SET NULL
);

INSERT INTO platform_secrets (name, value_encrypted, updated_at, updated_by)
SELECT s.name, s.value_encrypted, s.updated_at, (SELECT a.admin_id FROM _admin_of a WHERE a.user_id = s.updated_by)
FROM org_secrets s JOIN _origin o ON o.id = s.org_id;

-- --- 4. dono no conteúdo -----------------------------------------------------------------------

ALTER TABLE transcription_jobs  ADD COLUMN owner_id uuid;
ALTER TABLE transcripts         ADD COLUMN owner_id uuid;
ALTER TABLE speakers            ADD COLUMN owner_id uuid;
ALTER TABLE segments            ADD COLUMN owner_id uuid;
ALTER TABLE speaker_embeddings  ADD COLUMN owner_id uuid;
ALTER TABLE summaries           ADD COLUMN owner_id uuid;
ALTER TABLE voice_samples       ADD COLUMN owner_id uuid;
ALTER TABLE speaker_suggestions ADD COLUMN owner_id uuid;

UPDATE transcription_jobs x SET owner_id = r.owner_id FROM recordings r WHERE r.id = x.recording_id;
UPDATE transcripts x        SET owner_id = r.owner_id FROM recordings r WHERE r.id = x.recording_id;
UPDATE speakers x            SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;
UPDATE segments x            SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;
UPDATE speaker_embeddings x  SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;
UPDATE summaries x           SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;
UPDATE voice_samples x       SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;
UPDATE speaker_suggestions x SET owner_id = t.owner_id FROM transcripts t WHERE t.id = x.transcript_id;

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'transcription_jobs', 'transcripts', 'speakers', 'segments', 'speaker_embeddings',
        'summaries', 'voice_samples', 'speaker_suggestions'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN owner_id SET NOT NULL', tbl);
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE',
            tbl, tbl || '_owner_fk'
        );
    END LOOP;
END
$$;

-- --- 5. pessoas --------------------------------------------------------------------------------

-- O dono é quem criou a pessoa; sem ele, o admin mais antigo da organização, ou o usuário mais
-- antigo. Sem nenhum usuário na organização, a pessoa sai.
ALTER TABLE people ADD COLUMN owner_id uuid;
UPDATE people p SET owner_id = coalesce(
    (SELECT u.id FROM users u WHERE u.id = p.created_by AND u.org_id = p.org_id),
    (SELECT u.id FROM users u WHERE u.org_id = p.org_id AND u.role = 'admin' ORDER BY u.created_at, u.id LIMIT 1),
    (SELECT u.id FROM users u WHERE u.org_id = p.org_id ORDER BY u.created_at, u.id LIMIT 1)
);
DELETE FROM people WHERE owner_id IS NULL;

-- Cópias ficam na mesma organização que a original até o passo 7: o e-mail único por organização
-- deixaria de valer. O índice volta por dono no passo 8.
DROP INDEX people_email_idx;

-- Cada (pessoa, outro usuário) em que um locutor, uma amostra ou uma sugestão das transcrições desse
-- usuário aponta para ela ganha uma cópia da pessoa, dona desse usuário.
CREATE TEMP TABLE _person_copies (
    person_id  uuid NOT NULL,
    user_id    uuid NOT NULL,
    copy_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    PRIMARY KEY (person_id, user_id)
) ON COMMIT DROP;

INSERT INTO _person_copies (person_id, user_id)
SELECT DISTINCT x.person_id, x.owner_id
FROM (
    SELECT person_id, owner_id FROM speakers WHERE person_id IS NOT NULL
    UNION
    SELECT person_id, owner_id FROM voice_samples
    UNION
    SELECT person_id, owner_id FROM speaker_suggestions
) x
JOIN people p ON p.id = x.person_id
WHERE p.owner_id <> x.owner_id;

INSERT INTO people (id, org_id, owner_id, name, email, notes, created_by, created_at, updated_at)
SELECT c.copy_id, p.org_id, c.user_id, p.name, p.email, p.notes, c.user_id, p.created_at, now()
FROM _person_copies c JOIN people p ON p.id = c.person_id;

ALTER TABLE speakers            DROP CONSTRAINT speakers_person_fk;
ALTER TABLE voice_samples       DROP CONSTRAINT voice_samples_person_id_org_id_fkey;
ALTER TABLE speaker_suggestions DROP CONSTRAINT speaker_suggestions_person_id_org_id_fkey;

UPDATE speakers x SET person_id = c.copy_id
FROM _person_copies c WHERE x.person_id = c.person_id AND x.owner_id = c.user_id;
UPDATE voice_samples x SET person_id = c.copy_id
FROM _person_copies c WHERE x.person_id = c.person_id AND x.owner_id = c.user_id;
UPDATE speaker_suggestions x SET person_id = c.copy_id
FROM _person_copies c WHERE x.person_id = c.person_id AND x.owner_id = c.user_id;

-- O nome mostrado não muda, mas o id da pessoa sim: o `?since=` dos clientes busca de novo.
UPDATE transcripts t SET updated_at = now()
WHERE EXISTS (
    SELECT 1 FROM speakers s JOIN _person_copies c ON c.copy_id = s.person_id WHERE s.transcript_id = t.id
) OR EXISTS (
    SELECT 1 FROM speaker_suggestions s JOIN _person_copies c ON c.copy_id = s.person_id WHERE s.transcript_id = t.id
);

ALTER TABLE people ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE people ADD CONSTRAINT people_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE voice_consents DROP CONSTRAINT voice_consents_person_id_org_id_fkey;
ALTER TABLE people DROP CONSTRAINT people_id_org_id_key;
-- Alvo das FKs compostas: um locutor só se liga a uma pessoa da mesma conta.
ALTER TABLE people ADD CONSTRAINT people_id_owner_id_key UNIQUE (id, owner_id);
ALTER TABLE speakers
    ADD CONSTRAINT speakers_person_fk FOREIGN KEY (person_id, owner_id)
    REFERENCES people (id, owner_id) ON DELETE SET NULL (person_id);
ALTER TABLE voice_samples
    ADD CONSTRAINT voice_samples_person_fk FOREIGN KEY (person_id, owner_id)
    REFERENCES people (id, owner_id) ON DELETE CASCADE;
ALTER TABLE speaker_suggestions
    ADD CONSTRAINT speaker_suggestions_person_fk FOREIGN KEY (person_id, owner_id)
    REFERENCES people (id, owner_id) ON DELETE CASCADE;

-- As amostras existentes ficam: só existem de quem consentiu.
ALTER TABLE people
    DROP COLUMN voice_consent_status,
    DROP COLUMN voice_consent_updated_at,
    DROP COLUMN voice_consent_term_version,
    DROP COLUMN voice_consent_by;

-- --- 6. templates ------------------------------------------------------------------------------

CREATE TEMP TABLE _first_user ON COMMIT DROP AS
SELECT DISTINCT ON (org_id) org_id, id AS user_id FROM users ORDER BY org_id, created_at, id;

-- Os demais usuários da organização recebem uma cópia de cada template dela, com id novo e o
-- mesmo `created_at` (a ordem da lista).
CREATE TEMP TABLE _template_copies ON COMMIT DROP AS
SELECT tpl.id AS template_id, u.id AS user_id, gen_random_uuid() AS copy_id
FROM summary_templates tpl
JOIN users u ON u.org_id = tpl.org_id
JOIN _first_user f ON f.org_id = tpl.org_id
WHERE tpl.owner_id IS NULL AND u.id <> f.user_id;

INSERT INTO summary_templates (id, org_id, owner_id, name, description, instructions, is_default, created_at, updated_at)
SELECT c.copy_id, tpl.org_id, c.user_id, tpl.name, tpl.description, tpl.instructions, false, tpl.created_at, tpl.updated_at
FROM _template_copies c JOIN summary_templates tpl ON tpl.id = c.template_id;

-- O template da organização passa, com o mesmo id, ao usuário mais antigo dela.
UPDATE summary_templates tpl SET owner_id = f.user_id
FROM _first_user f WHERE tpl.owner_id IS NULL AND tpl.org_id = f.org_id;
DELETE FROM summary_templates WHERE owner_id IS NULL;

-- O padrão da organização (ou a cópia dele) vira o padrão de quem ainda não tinha um pessoal.
UPDATE summary_templates tpl SET is_default = true
FROM users u
JOIN org_settings s ON s.org_id = u.org_id
WHERE tpl.owner_id = u.id
  AND NOT EXISTS (SELECT 1 FROM summary_templates d WHERE d.owner_id = u.id AND d.is_default)
  AND (
      tpl.id = (s.summarization ->> 'default_template_id')::uuid
      OR tpl.id IN (
          SELECT c.copy_id FROM _template_copies c
          WHERE c.user_id = u.id AND c.template_id = (s.summarization ->> 'default_template_id')::uuid
      )
  );

ALTER TABLE summary_templates ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE summary_templates DROP CONSTRAINT summary_templates_check;

-- Semeia os três templates padrão de um usuário sem nenhum (a ata é o padrão do resumo
-- automático). Roda com o papel de conexão: no cadastro e nesta migration.
DROP FUNCTION eclume_seed_summary_templates(uuid);
CREATE FUNCTION eclume_seed_summary_templates(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM summary_templates WHERE owner_id = target) THEN
        RETURN;
    END IF;
    -- Instantes distintos: a listagem ordena por `created_at` e os três nascem na mesma transação.
    INSERT INTO summary_templates (owner_id, name, description, instructions, is_default, created_at, updated_at)
    VALUES
        (
            target,
            'Ata de reunião',
            'Decisões e encaminhamentos com responsável.',
            'Escreva a ata da reunião em Markdown, com as seções Contexto (uma ou duas frases), '
            'Participantes, Pontos discutidos, Decisões e Encaminhamentos. Cada encaminhamento é uma '
            'caixa de seleção (`- [ ]`) com responsável e prazo, quando ditos. Use os nomes dos '
            'locutores como aparecem na transcrição. Não invente o que não foi dito.',
            true,
            now(),
            now()
        ),
        (
            target,
            'Resumo executivo',
            'Até cinco tópicos para a diretoria.',
            'Resuma a reunião para a diretoria em até cinco tópicos: objetivo, principais '
            'conclusões, riscos, decisões e próximos passos. Frases curtas, sem detalhes '
            'operacionais. Não invente o que não foi dito.',
            false,
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
            false,
            now() + interval '2 milliseconds',
            now() + interval '2 milliseconds'
        );
END
$$;
REVOKE ALL ON FUNCTION eclume_seed_summary_templates(uuid) FROM PUBLIC;

-- --- 7. remoções -------------------------------------------------------------------------------

DROP TABLE recording_shares, group_members, groups, invitations, voice_consents, voice_audit,
    org_settings, org_secrets;

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'users', 'api_tokens', 'recordings', 'uploads', 'transcription_jobs', 'transcripts',
        'speakers', 'segments', 'speaker_embeddings', 'agent_providers', 'summary_templates',
        'summaries', 'people', 'collections', 'voice_samples', 'speaker_suggestions'
    ] LOOP
        EXECUTE format('ALTER TABLE %I DROP COLUMN org_id', tbl);
    END LOOP;
END
$$;

ALTER TABLE users DROP COLUMN role;
DROP TABLE organizations;
DROP FUNCTION eclume_org();
DROP FUNCTION eclume_admin();
DROP FUNCTION eclume_actor();

-- Aceite do aviso do cadastro: a conta migrada nasce sem, a do cadastro nasce com.
ALTER TABLE users
    ADD COLUMN notice_version      text,
    ADD COLUMN notice_accepted_at  timestamptz,
    ADD CONSTRAINT users_notice_check CHECK ((notice_version IS NULL) = (notice_accepted_at IS NULL));

SELECT eclume_seed_summary_templates(id) FROM users;

-- --- 8. índices, políticas e GRANTs por dono ---------------------------------------------------

CREATE INDEX users_created_idx ON users (created_at DESC, id DESC);
CREATE INDEX recordings_owner_idx ON recordings (owner_id, created_at DESC, id DESC);
CREATE INDEX transcripts_updated_idx ON transcripts (owner_id, updated_at, id);
CREATE INDEX summary_templates_owner_idx ON summary_templates (owner_id, created_at, id);
CREATE INDEX people_sort_idx ON people (owner_id, sort_name, id);
CREATE UNIQUE INDEX people_email_idx ON people (owner_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX voice_samples_person_idx ON voice_samples (owner_id, person_id, model);

-- O único contexto da RLS é `app.user_id`; nenhuma política consulta outra tabela.
CREATE POLICY users_self ON users
    USING (id = eclume_user()) WITH CHECK (id = eclume_user());
CREATE POLICY api_tokens_own ON api_tokens
    USING (user_id = eclume_user()) WITH CHECK (user_id = eclume_user());

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'recordings', 'uploads', 'collections', 'summary_templates', 'people', 'transcription_jobs',
        'transcripts', 'speakers', 'segments', 'speaker_embeddings', 'summaries', 'voice_samples',
        'speaker_suggestions'
    ] LOOP
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user())',
            tbl || '_own', tbl
        );
    END LOOP;
END
$$;

-- O que cada tabela permite fica nos GRANTs de antes, mais o DELETE das amostras e das sugestões:
-- esquecer a voz de uma pessoa é um DELETE comum do dono.
GRANT DELETE ON voice_samples       TO eclume_app;
GRANT DELETE ON speaker_suggestions TO eclume_app;

-- Providers são da plataforma: sem RLS, e `eclume_app` só lê as colunas sem segredo (o resumo
-- resolve o provider sob a RLS do usuário; quem abre a chave é o worker, com o papel de conexão).
ALTER TABLE agent_providers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_providers DISABLE ROW LEVEL SECURITY;
CREATE INDEX agent_providers_created_idx ON agent_providers (created_at, id);
REVOKE ALL ON agent_providers FROM eclume_app;
GRANT SELECT (id, name, kind, base_url, model, enabled, options, created_at, updated_at)
    ON agent_providers TO eclume_app;

-- `eclume_app` lê a configuração da plataforma (voz, resumo automático); os segredos, nunca.
GRANT SELECT ON platform_settings TO eclume_app;

-- Busca: o GIN com o papel dono, restrito ao usuário da transação.
CREATE OR REPLACE FUNCTION eclume_segment_matches(query tsquery)
    RETURNS TABLE (transcript_id uuid, segment_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
        SELECT s.transcript_id, s.segment_id FROM segments s
        WHERE s.owner_id = eclume_user() AND s.tsv @@ query
    $$;

ALTER TABLE speakers ENABLE TRIGGER speakers_voice_relink;

-- --- 9. papel de conexão -----------------------------------------------------------------------

-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON admins, admin_sessions, platform_settings, platform_secrets
    TO eclume_server;
