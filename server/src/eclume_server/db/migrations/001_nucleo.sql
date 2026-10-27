-- 001_nucleo — eclume's core: organizations, users, sessions, PATs, groups, recordings,
-- uploads, jobs and transcripts, isolated by RLS.
--
-- Pattern (docs/standards/code/server-nucleo.md): every domain table has `org_id`; the
-- policies read `app.org_id` and `app.user_id`, set per transaction with `set_config(..., true)`
-- after `SET LOCAL ROLE eclume_app`. The connection role (schema owner) runs the system
-- operations: credential lookup, bootstrap, CPU worker and this migration.
--
-- Anti-recursion rule: the policies of `recording_shares` and `group_members` filter by
-- organization only; no policy of those two queries `recordings` back.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eclume_app') THEN
        CREATE ROLE eclume_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
END
$$;

-- A non-superuser connection role must be a member to `SET ROLE eclume_app`.
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

-- --- identity ---------------------------------------------------------------------------------

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
-- Login is by e-mail, with no organization: the e-mail is unique in the instance.
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id, created_at DESC, id DESC);

-- Sessions are only read and written by the system role.
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

-- The organization's runtime settings; the read and write API belongs to the admin panel (#12).
CREATE TABLE org_settings (
    org_id                uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    asr                   jsonb NOT NULL,
    diarization           jsonb NOT NULL,
    summarization         jsonb NOT NULL,
    voice_identification  jsonb NOT NULL,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid REFERENCES users (id) ON DELETE SET NULL
);

-- --- recordings -------------------------------------------------------------------------------

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
    -- Id the recording receives on `complete` (the audio key already uses it); `recording_id` is only
    -- filled after `complete` or on a `deduplicated`.
    new_recording_id  uuid NOT NULL,
    recording_id      uuid,
    audio_key         text,
    s3_upload_id      text,
    request           jsonb NOT NULL DEFAULT '{}',
    expires_at        timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz
);
-- Resume by hash: a single upload in progress per owner and file.
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

-- --- transcripts ------------------------------------------------------------------------------

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
    -- The people table is born in the people-organization-and-search spec (#11), which adds the FK.
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

-- Voiceprint (biometric data, LGPD): only arrives with the organization's opt-in. The dimension
-- depends on the model, hence `vector` with no fixed dimension; the comparison belongs to #15.
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
-- `sessions` stays without RLS and without GRANT: eclume_app cannot see it.

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

-- Read: owner, or shared with the organization, or with a group the user is a member of.
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

-- Derived content inherits the recording's visibility (the `recordings` policy applies in the EXISTS).
CREATE POLICY transcription_jobs_read ON transcription_jobs FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id));
CREATE POLICY transcription_jobs_write ON transcription_jobs FOR INSERT
    WITH CHECK (
        org_id = eclume_org()
        AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id AND r.owner_id = eclume_user())
    );

CREATE POLICY transcripts_read ON transcripts FOR SELECT
    USING (org_id = eclume_org() AND EXISTS (SELECT 1 FROM recordings r WHERE r.id = recording_id));

-- Only the owner edits the transcript (today: `updated_at` when editing the recording's metadata).
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
