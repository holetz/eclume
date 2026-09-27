-- 014_gravacao_resumo — a gravação centrada no resumo (holetz/eclume#34).
--
-- A gravação ganha a natureza (`kind`: reunião ou nota por voz) e a origem da data
-- (`recorded_at_source`). O resumo vira uma sequência de versões por transcrição, geradas, editadas
-- à mão ou ajustadas pelo chat com o agente (`summary_chat_messages`). Os marcadores dos apps
-- (`markers`) são instantes com nota opcional. Padrões em docs/standards/code/server-agentes.md e
-- docs/standards/code/server-nucleo.md.

-- --- 1. natureza e origem da data da gravação ----------------------------------------------------

ALTER TABLE recordings
    ADD COLUMN kind text NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'note')),
    ADD COLUMN recorded_at_source text NOT NULL DEFAULT 'upload'
        CHECK (recorded_at_source IN ('capture', 'file_metadata', 'user', 'upload'));

-- O desktop sempre mandou o início da captura; o import web não mandava data, e o `recorded_at`
-- dessas gravações é a hora do envio.
UPDATE recordings SET recorded_at_source = 'capture' WHERE source = 'desktop';

-- A biblioteca por intervalo (semana, mês) sobre o início da gravação.
CREATE INDEX recordings_owner_recorded_idx ON recordings (owner_id, recorded_at, id);

-- --- 2. versões do resumo --------------------------------------------------------------------------

-- A numeração passa a ser por transcrição (trocar o tipo de agenda continua o histórico).
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

-- Uma versão `manual` não tem gerador; a `chat` tem o provider do chat, não as instruções do tipo.
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

-- --- 3. chat de ajuste ---------------------------------------------------------------------------

CREATE TABLE summary_chat_messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recording_id     uuid NOT NULL,
    transcript_id    uuid NOT NULL,
    role             text NOT NULL CHECK (role IN ('user', 'assistant')),
    content          text,
    -- A mensagem do usuário nasce `done`; a do agente vai de `queued` a `done` ou `failed`.
    status           text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    reply_to         uuid REFERENCES summary_chat_messages (id) ON DELETE CASCADE,
    -- A versão atual quando o pedido chegou, e a versão `chat` que a resposta criou.
    base_summary_id  uuid REFERENCES summaries (id) ON DELETE SET NULL,
    summary_id       uuid REFERENCES summaries (id) ON DELETE SET NULL,
    -- As consultas do agente à transcrição: [{"tool": "read_transcript", "from_ms", "to_ms", "clipped"}, ...].
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
-- Um pedido em aberto por gravação.
CREATE UNIQUE INDEX summary_chat_messages_open_idx ON summary_chat_messages (recording_id)
    WHERE role = 'assistant' AND status IN ('queued', 'running');

ALTER TABLE summaries
    ADD CONSTRAINT summaries_chat_message_fk FOREIGN KEY (chat_message_id)
    REFERENCES summary_chat_messages (id) ON DELETE SET NULL;

-- --- 4. marcadores ---------------------------------------------------------------------------------

CREATE TABLE markers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    recording_id  uuid NOT NULL,
    -- Gerado pelo app: reenviar depois de uma falha de rede não duplica.
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

-- --- 5. RLS e GRANTs -------------------------------------------------------------------------------

ALTER TABLE summary_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE markers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE markers               FORCE ROW LEVEL SECURITY;
CREATE POLICY summary_chat_messages_own ON summary_chat_messages
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());
CREATE POLICY markers_own ON markers
    USING (owner_id = eclume_user()) WITH CHECK (owner_id = eclume_user());

-- A API grava o pedido e a resposta em aberto; quem conclui a resposta é o worker (papel de conexão).
GRANT SELECT, INSERT, DELETE ON summary_chat_messages TO eclume_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON markers TO eclume_app;
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON summary_chat_messages, markers TO eclume_server;
