-- 024_exclusao_no_armazenamento — fila de exclusão no bucket, gravada com o DELETE (holetz/eclume#97).
--
-- Excluir gravação ou conta nunca deixa objeto para trás: gatilhos `AFTER DELETE` enfileiram, na
-- mesma transação do `DELETE` (e da cascata), o áudio, o prefixo dos artefatos do worker GPU e o
-- multipart em andamento. O cron `drain_storage_deletions` do worker CPU esvazia a fila com
-- retentativa e nunca desiste. Sem RLS e sem GRANT para `eclume_app`: só o papel de conexão e as
-- funções `SECURITY DEFINER` a alcançam. Padrões em docs/standards/code/server-nucleo.md.

CREATE TABLE storage_deletions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exatamente um: uma chave, um prefixo (tudo sob ele) ou o multipart `(key, s3_upload_id)`.
    key              text,
    prefix           text,
    s3_upload_id     text,
    attempts         integer NOT NULL DEFAULT 0,
    last_error       text,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((key IS NULL) <> (prefix IS NULL)),
    CHECK (s3_upload_id IS NULL OR key IS NOT NULL)
);
CREATE INDEX storage_deletions_due_idx ON storage_deletions (next_attempt_at);
-- Já coberto pelo ALTER DEFAULT PRIVILEGES da 006 (mesmo migrador); repetido por clareza.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage_deletions TO eclume_server;

-- A gravação que sai leva o áudio e `recordings/{id}/` (todas as revisões). SECURITY DEFINER: quem
-- exclui é o dono, sob a RLS, sem acesso à fila.
CREATE FUNCTION eclume_recording_storage_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF OLD.audio_key IS NOT NULL THEN
            INSERT INTO storage_deletions (key) VALUES (OLD.audio_key);
        END IF;
        INSERT INTO storage_deletions (prefix) VALUES ('recordings/' || OLD.id || '/');
        RETURN OLD;
    END
    $$;
CREATE TRIGGER recordings_storage_delete
    AFTER DELETE ON recordings
    FOR EACH ROW EXECUTE FUNCTION eclume_recording_storage_deleted();

-- O upload em andamento que sai (exclusão da conta) aborta o multipart dele.
CREATE FUNCTION eclume_upload_storage_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF OLD.status = 'in_progress' AND OLD.s3_upload_id IS NOT NULL AND OLD.audio_key IS NOT NULL THEN
            INSERT INTO storage_deletions (key, s3_upload_id) VALUES (OLD.audio_key, OLD.s3_upload_id);
        END IF;
        RETURN OLD;
    END
    $$;
CREATE TRIGGER uploads_storage_delete
    AFTER DELETE ON uploads
    FOR EACH ROW EXECUTE FUNCTION eclume_upload_storage_deleted();
