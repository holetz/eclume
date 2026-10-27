-- 014_gravacao_resumo — the recording centred on the summary (holetz/eclume#34).
--
-- The recording gains its nature (`kind`: meeting or voice note) and the source of its date
-- (`recorded_at_source`). The summary becomes a sequence of versions per transcript, generated, edited
-- by hand or adjusted by the chat with the agent (`summary_chat_messages`). The apps' markers
-- (`markers`) are instants with an optional note. Patterns in docs/standards/code/server-agentes.md and
-- docs/standards/code/server-nucleo.md.

-- --- 1. nature and date source of the recording --------------------------------------------------

ALTER TABLE recordings
    ADD COLUMN kind text NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'note')),
    ADD COLUMN recorded_at_source text NOT NULL DEFAULT 'upload'
        CHECK (recorded_at_source IN ('capture', 'file_metadata', 'user', 'upload'));

-- The desktop always sent the capture start; the web import sent no date, and the `recorded_at`
-- of those recordings is the upload time.
UPDATE recordings SET recorded_at_source = 'capture' WHERE source = 'desktop';

-- The library by range (week, month) over the recording's start.
CREATE INDEX recordings_owner_recorded_idx ON recordings (owner_id, recorded_at, id);

-- --- 2. summary versions ---------------------------------------------------------------------------

-- Numbering becomes per transcript (changing the agenda type continues the history).
DO $$
DECLARE
    old_key text;
BEGIN
    SELECT conname INTO STRICT old_key FROM pg_constraint
    WHERE conrelid = 'summaries'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (transcript_id, agenda_type_id, version)';
    EXECUTE format('ALTER TABLE summaries DROP CONSTRAINT %I', old_key);
END
$$;

UPDATE summaries s SET version = n.version
FROM (
    SELECT id, row_number() OVER (PARTITION BY transcript_id ORDER BY created_at, id) AS version
    FROM summaries
) n
WHERE n.id = s.id;

ALTER TABLE summaries ADD CONSTRAINT summaries_transcript_version_key UNIQUE (transcript_id, version);

-- A `manual` version has no generator; a `chat` one has the chat's provider, not the type's instructions.
ALTER TABLE summaries
    ADD COLUMN origin text NOT NULL DEFAULT 'generated' CHECK (origin IN ('generated', 'manual', 'chat')),
    ADD COLUMN restored_from_id uuid REFERENCES summaries (id) ON DELETE SET NULL,
    ADD COLUMN chat_message_id uuid,
    ALTER COLUMN agenda_type_id DROP NOT NULL,
    ALTER COLUMN agenda_type_name DROP NOT NULL,
    ALTER COLUMN instructions DROP NOT NULL,
    ALTER COLUMN provider_id DROP NOT NULL,
    ALTER COLUMN provider_name DROP NOT NULL,
    ALTER COLUMN provider_kind DROP NOT NULL,
    ALTER COLUMN model DROP NOT NULL,
    ADD CONSTRAINT summaries_generator_check CHECK (origin <> 'generated' OR provider_id IS NOT NULL);

-- --- 3. adjustment chat --------------------------------------------------------------------------

CREATE TABLE summary_chat_messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recording_id     uuid NOT NULL,
    transcript_id    uuid NOT NULL,
    role             text NOT NULL CHECK (role IN ('user', 'assistant')),
    content          text,
    -- The user's message is born `done`; the agent's goes from `queued` to `done` or `failed`.
    status           text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    reply_to         uuid REFERENCES summary_chat_messages (id) ON DELETE CASCADE,
    -- The current version when the request arrived, and the `chat` version the answer created.
    base_summary_id  uuid REFERENCES summaries (id) ON DELETE SET NULL,
    summary_id       uuid REFERENCES summaries (id) ON DELETE SET NULL,
    -- The agent's lookups in the transcript: [{"tool": "read_transcript", "from_ms", "to_ms", "clipped"}, ...].
    reads            jsonb NOT NULL DEFAULT '[]',
    provider_id      uuid,
    provider_name    text,
    provider_kind    text,
    model            text,
    error_code       text,
    error_message    text,
    attempts         integer NOT NULL DEFAULT 0,
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    completed_at     timestamptz,
    CHECK (role = 'assistant' OR (status = 'done' AND content IS NOT NULL)),
    FOREIGN KEY (recording_id, owner_id) REFERENCES recordings (id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (transcript_id, owner_id) REFERENCES transcripts (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX summary_chat_messages_recording_idx ON summary_chat_messages (recording_id, created_at, id);
-- One open request per recording.
CREATE UNIQUE INDEX summary_chat_messages_open_idx ON summary_chat_messages (recording_id)
    WHERE role = 'assistant' AND status IN ('queued', 'running');

ALTER TABLE summaries
    ADD CONSTRAINT summaries_chat_message_fk FOREIGN KEY (chat_message_id)
    REFERENCES summary_chat_messages (id) ON DELETE SET NULL;

-- --- 4. markers ------------------------------------------------------------------------------------

CREATE TABLE markers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recording_id  uuid NOT NULL,
    -- Generated by the app: resending after a network failure does not duplicate.
    client_id     uuid NOT NULL,
    at_ms         bigint NOT NULL CHECK (at_ms >= 0),
    note          text CHECK (length(note) <= 500),
    device_name   text,
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (recording_id, client_id),
    FOREIGN KEY (recording_id, owner_id) REFERENCES recordings (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX markers_recording_idx ON markers (recording_id, at_ms, id);

-- --- 5. RLS and GRANTs -----------------------------------------------------------------------------

ALTER TABLE summary_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE markers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE markers               FORCE ROW LEVEL SECURITY;
CREATE POLICY summary_chat_messages_own ON summary_chat_messages
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY markers_own ON markers
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());

-- The API writes the request and the open answer; the worker (connection role) completes the answer.
GRANT SELECT, INSERT, DELETE ON summary_chat_messages TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON markers TO eclume_app;
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON summary_chat_messages, markers TO eclume_server;
