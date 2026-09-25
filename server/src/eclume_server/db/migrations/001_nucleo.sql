-- 001_nucleo — núcleo do eclume: organizações, usuários, sessões, PATs, grupos, gravações,
-- uploads, jobs e transcrições, com isolamento por RLS.
--
-- Padrão (docs/standards/code/server-nucleo.md): toda tabela de domínio tem `org_id`; as
-- políticas leem `app.org_id` e `app.user_id`, fixados por transação com `set_config(..., true)`
-- depois de `SET LOCAL ROLE eclume_app`. O papel de conexão (dono do schema) roda as operações
-- de sistema: lookup de credencial, bootstrap, worker CPU e esta migration.
--
-- Regra anti-recursão: as políticas de `recording_shares` e `group_members` filtram só por
-- organização; nenhuma política dessas duas volta a consultar `recordings`.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eclume_app') THEN
        CREATE ROLE eclume_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
END
$$;

-- Um papel de conexão não superusuário precisa ser membro para `SET ROLE eclume_app`.
DO $$
BEGIN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        EXECUTE format('GRANT eclume_app TO %I', current_user);
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO eclume_app;

CREATE OR REPLACE FUNCTION eclume_org() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION eclume_user() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- --- identidade -------------------------------------------------------------------------------

CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email          text NOT NULL,
    name           text NOT NULL,
    password_hash  text NOT NULL,
    role           text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    active         boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz
);
-- O login é por e-mail, sem organização: o e-mail é único na instância.
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id, created_at DESC, id DESC);

-- Sessões só são lidas e escritas pelo papel de sistema.
CREATE TABLE sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  text NOT NULL UNIQUE,
    csrf_token  text NOT NULL,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    text NOT NULL UNIQUE,
    prefix        text NOT NULL,
    scopes        text[] NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    expires_at    timestamptz,
    revoked_at    timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at DESC, id DESC);

CREATE TABLE groups (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name         text NOT NULL,
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX groups_name_idx ON groups (org_id, lower(name));

CREATE TABLE group_members (
    group_id  uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    org_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id);

-- Configuração em runtime da organização; a API de leitura e escrita é do painel admin (#12).
CREATE TABLE org_settings (
    org_id                uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    asr                   jsonb NOT NULL,
    diarization           jsonb NOT NULL,
    summarization         jsonb NOT NULL,
    voice_identification  jsonb NOT NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES users (id) ON DELETE SET NULL
);

-- --- gravações --------------------------------------------------------------------------------

CREATE TABLE recordings (
    id              uuid PRIMARY KEY,
    org_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    owner_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title           text NOT NULL,
    status          text NOT NULL CHECK (status IN ('uploading', 'queued', 'processing', 'transcribed', 'failed')),
    source          text NOT NULL CHECK (source IN ('desktop', 'upload', 'api')),
    recorded_at     timestamptz NOT NULL,
    duration_ms     bigint,
    language        text,
    size_bytes      bigint NOT NULL,
    content_type    text NOT NULL,
    content_hash    text NOT NULL,
    audio_key       text NOT NULL,
    tags            text[] NOT NULL DEFAULT '{}',
    collection_ids  uuid[] NOT NULL DEFAULT '{}',
    metadata        jsonb NOT NULL DEFAULT '{}',
    capture         jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, content_hash)
);
CREATE INDEX recordings_org_idx ON recordings (org_id, created_at DESC, id DESC);

CREATE TABLE recording_shares (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    recording_id  uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
    target_type   text NOT NULL CHECK (target_type IN ('group', 'organization')),
    group_id      uuid REFERENCES groups (id) ON DELETE CASCADE,
    created_by    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK ((target_type = 'group') = (group_id IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT (recording_id, target_type, group_id)
);

CREATE TABLE uploads (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    owner_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status            text NOT NULL CHECK (status IN ('in_progress', 'completed', 'aborted', 'expired', 'deduplicated')),
    filename          text NOT NULL,
    content_type      text NOT NULL,
    size_bytes        bigint NOT NULL,
    sha256            text NOT NULL,
    part_size         bigint NOT NULL,
    part_count        integer NOT NULL,
    -- Id que a gravação recebe no `complete` (a chave do áudio já o usa); `recording_id` só é
    -- preenchido depois do `complete` ou num `deduplicated`.
    new_recording_id  uuid NOT NULL,
    recording_id      uuid,
    audio_key         text,
    s3_upload_id      text,
    request           jsonb NOT NULL DEFAULT '{}',
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz
);
-- Retomada por hash: um único upload em andamento por dono e arquivo.
CREATE UNIQUE INDEX uploads_in_progress_idx ON uploads (owner_id, sha256) WHERE status = 'in_progress';
CREATE INDEX uploads_expiry_idx ON uploads (expires_at) WHERE status = 'in_progress';

CREATE TABLE transcription_jobs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    recording_id   uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
    revision       integer NOT NULL,
    state          text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    attempts       integer NOT NULL DEFAULT 0,
    error_code     text,
    error_message  text,
    options        jsonb NOT NULL DEFAULT '{}',
    engine_info    jsonb,
    queued_at      timestamptz NOT NULL DEFAULT now(),
    started_at     timestamptz,
    finished_at    timestamptz,
    UNIQUE (recording_id, revision)
);

-- --- transcrições -----------------------------------------------------------------------------

CREATE TABLE transcripts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    recording_id  uuid NOT NULL UNIQUE REFERENCES recordings (id) ON DELETE CASCADE,
    revision      integer NOT NULL,
    language      text NOT NULL,
    duration_ms   bigint NOT NULL,
    engine        jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_updated_idx ON transcripts (org_id, updated_at, id);

CREATE TABLE speakers (
    transcript_id  uuid NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    speaker_id     text NOT NULL,
    position       integer NOT NULL,
    label          text NOT NULL,
    -- A tabela de pessoas nasce na spec pessoas-organizacao-e-busca (#11), que acrescenta a FK.
    person_id      uuid,
    talk_ms        bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (transcript_id, speaker_id)
);
CREATE INDEX speakers_person_idx ON speakers (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE segments (
    transcript_id  uuid NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    segment_id     text NOT NULL,
    position       integer NOT NULL,
    speaker_id     text NOT NULL,
    start_ms       bigint NOT NULL,
    end_ms         bigint NOT NULL,
    text           text NOT NULL,
    confidence     double precision,
    words          jsonb,
    tsv            tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', text)) STORED,
    PRIMARY KEY (transcript_id, segment_id)
);
CREATE INDEX segments_order_idx ON segments (transcript_id, position);
CREATE INDEX segments_tsv_idx ON segments USING gin (tsv);

-- Impressão de voz (dado biométrico, LGPD): só chega com o opt-in da organização. A dimensão
-- depende do modelo, por isso `vector` sem dimensão fixa; a comparação é da #15.
CREATE TABLE speaker_embeddings (
    transcript_id  uuid NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
    org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    speaker_id     text NOT NULL,
    model          text NOT NULL,
    embedding      vector NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (transcript_id, speaker_id)
);

-- --- RLS --------------------------------------------------------------------------------------

ALTER TABLE organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens         ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_shares   ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE speakers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE speaker_embeddings ENABLE ROW LEVEL SECURITY;
-- `sessions` fica sem RLS e sem GRANT: eclume_app não a enxerga.

CREATE POLICY organizations_org ON organizations
    USING (id = eclume_org());

CREATE POLICY users_org ON users
    USING (org_id = eclume_org()) WITH CHECK (org_id = eclume_org());

CREATE POLICY api_tokens_own ON api_tokens
    USING (user_id = eclume_user())
    WITH CHECK (user_id = eclume_user() AND org_id = eclume_org());

CREATE POLICY groups_org ON groups
    USING (org_id = eclume_org()) WITH CHECK (org_id = eclume_org());

CREATE POLICY group_members_org ON group_members
    USING (org_id = eclume_org()) WITH CHECK (org_id = eclume_org());

CREATE POLICY org_settings_org ON org_settings
    USING (org_id = eclume_org());

-- Leitura: dono, ou compartilhamento com a organização, ou com um grupo de que o usuário é membro.
CREATE POLICY recordings_read ON recordings FOR SELECT
    USING (
        org_id = eclume_org()
        AND (
            owner_id = eclume_user()
            OR EXISTS (
                SELECT 1 FROM recording_shares s
                WHERE s.recording_id = recordings.id
                  AND (
                      s.target_type = 'organization'
                      OR EXISTS (
                          SELECT 1 FROM group_members m
                          WHERE m.group_id = s.group_id AND m.user_id = eclume_user()
                      )
                  )
            )
        )
    );
CREATE POLICY recordings_insert ON recordings FOR INSERT
    WITH CHECK (org_id = eclume_org() AND owner_id = eclume_user());
CREATE POLICY recordings_update ON recordings FOR UPDATE
    USING (org_id = eclume_org() AND owner_id = eclume_user())
    WITH CHECK (org_id = eclume_org() AND owner_id = eclume_user());
CREATE POLICY recordings_delete ON recordings FOR DELETE
    USING (org_id = eclume_org() AND owner_id = eclume_user());

CREATE POLICY recording_shares_read ON recording_shares FOR SELECT
    USING (org_id = eclume_org());
CREATE POLICY recording_shares_insert ON recording_shares FOR INSERT
    WITH CHECK (
        org_id = eclume_org()
        AND created_by = eclume_user()
        AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id AND r.owner_id = eclume_user())
    );
CREATE POLICY recording_shares_delete ON recording_shares FOR DELETE
    USING (
        org_id = eclume_org()
        AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id AND r.owner_id = eclume_user())
    );

CREATE POLICY uploads_own ON uploads
    USING (org_id = eclume_org() AND owner_id = eclume_user())
    WITH CHECK (org_id = eclume_org() AND owner_id = eclume_user());

-- Conteúdo derivado herda a visibilidade da gravação (a política de `recordings` se aplica no EXISTS).
CREATE POLICY transcription_jobs_read ON transcription_jobs FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id));
CREATE POLICY transcription_jobs_write ON transcription_jobs FOR INSERT
    WITH CHECK (
        org_id = eclume_org()
        AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id AND r.owner_id = eclume_user())
    );

CREATE POLICY transcripts_read ON transcripts FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id));

-- Só o dono edita a transcrição (hoje: `updated_at` ao editar metadados da gravação).
CREATE POLICY transcripts_update ON transcripts FOR UPDATE
    USING (
        org_id = eclume_org()
        AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id AND r.owner_id = eclume_user())
    );

CREATE POLICY speakers_read ON speakers FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM transcripts t WHERE t.id = transcript_id));

CREATE POLICY segments_read ON segments FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM transcripts t WHERE t.id = transcript_id));

CREATE POLICY speaker_embeddings_read ON speaker_embeddings FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM transcripts t WHERE t.id = transcript_id));

ALTER TABLE organizations      FORCE ROW LEVEL SECURITY;
ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE api_tokens         FORCE ROW LEVEL SECURITY;
ALTER TABLE groups             FORCE ROW LEVEL SECURITY;
ALTER TABLE group_members      FORCE ROW LEVEL SECURITY;
ALTER TABLE org_settings       FORCE ROW LEVEL SECURITY;
ALTER TABLE recordings         FORCE ROW LEVEL SECURITY;
ALTER TABLE recording_shares   FORCE ROW LEVEL SECURITY;
ALTER TABLE uploads            FORCE ROW LEVEL SECURITY;
ALTER TABLE transcription_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE transcripts        FORCE ROW LEVEL SECURITY;
ALTER TABLE speakers           FORCE ROW LEVEL SECURITY;
ALTER TABLE segments           FORCE ROW LEVEL SECURITY;
ALTER TABLE speaker_embeddings FORCE ROW LEVEL SECURITY;

GRANT SELECT                         ON organizations      TO eclume_app;
GRANT SELECT, UPDATE                 ON users              TO eclume_app;
GRANT SELECT, INSERT, UPDATE         ON api_tokens         TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON groups             TO eclume_app;
GRANT SELECT, INSERT, DELETE         ON group_members      TO eclume_app;
GRANT SELECT                         ON org_settings       TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recordings         TO eclume_app;
GRANT SELECT, INSERT, DELETE         ON recording_shares   TO eclume_app;
GRANT SELECT, INSERT, UPDATE         ON uploads            TO eclume_app;
GRANT SELECT, INSERT                 ON transcription_jobs TO eclume_app;
GRANT SELECT, UPDATE                 ON transcripts        TO eclume_app;
GRANT SELECT                         ON speakers           TO eclume_app;
GRANT SELECT                         ON segments           TO eclume_app;
GRANT SELECT                         ON speaker_embeddings TO eclume_app;
