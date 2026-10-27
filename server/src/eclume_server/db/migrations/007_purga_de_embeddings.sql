-- 007_purga_de_embeddings — turning off the voice identification opt-in deletes the voiceprint
-- per recording (LGPD): `speaker_embeddings` keeps the vector of every diarized speaker, including
-- those who never consented. The samples (`voice_samples`) belong to those who consented and stay: revoking them is the
-- consent flow. Rules in docs/standards/code/identificacao-por-voz.md `§Purga ao desligar`.
--
-- SECURITY DEFINER: the purge crosses the admin's recording visibility (private recordings of
-- other members), restricted to `eclume_org()` and to admins, on the model of `eclume_voice_forget`.
-- Returns the deleted `(embeddings, suggestions)`; the bucket's `speaker_embeddings.json` leave through the CPU
-- worker's `purge_embedding_objects` job.
CREATE FUNCTION eclume_purge_speaker_embeddings(OUT embeddings bigint, OUT suggestions bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    BEGIN
        IF NOT eclume_admin() THEN
            RAISE EXCEPTION 'só admin apaga as impressões de voz por gravação' USING ERRCODE = '42501';
        END IF;
        DELETE FROM speaker_embeddings WHERE org_id = eclume_org();
        GET DIAGNOSTICS embeddings = ROW_COUNT;
        DELETE FROM speaker_suggestions WHERE org_id = eclume_org() AND status = 'pending';
        GET DIAGNOSTICS suggestions = ROW_COUNT;
    END
    $$;
REVOKE EXECUTE ON FUNCTION eclume_purge_speaker_embeddings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eclume_purge_speaker_embeddings() TO eclume_app;
