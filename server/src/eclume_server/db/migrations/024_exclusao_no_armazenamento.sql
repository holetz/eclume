-- 024_exclusao_no_armazenamento — bucket deletion queue, written with the DELETE (holetz/eclume#97).
--
-- Deleting a recording or an account never leaves an object behind: `AFTER DELETE` triggers enqueue, in the
-- same transaction as the `DELETE` (and the cascade), the audio, the GPU worker's artefact prefix and the
-- in-progress multipart. The CPU worker's `drain_storage_deletions` cron empties the queue with
-- retries and never gives up. No RLS and no GRANT to `eclume_app`: only the connection role and the
-- `SECURITY DEFINER` functions reach it. Patterns in docs/standards/code/server-nucleo.md.

CREATE TABLE storage_deletions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exactly one: a key, a prefix (everything under it) or the multipart `(key, s3_upload_id)`.
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
-- Already covered by the ALTER DEFAULT PRIVILEGES of 006 (same migrator); repeated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage_deletions TO eclume_server;

-- The recording that goes takes the audio and `recordings/{id}/` (every revision). SECURITY DEFINER: the
-- deleter is the owner, under RLS, with no access to the queue.
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

-- The in-progress upload that goes (account deletion) aborts its multipart.
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
