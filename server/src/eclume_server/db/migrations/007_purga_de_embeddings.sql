-- 007_purga_de_embeddings — desligar o opt-in de identificação por voz apaga a impressão de voz
-- por gravação (LGPD): `speaker_embeddings` guarda o vetor de todo locutor diarizado, inclusive de
-- quem nunca consentiu. As amostras (`voice_samples`) são de quem consentiu e ficam: revogá-las é o
-- fluxo de consentimento. Regras em docs/standards/code/identificacao-por-voz.md §Purga ao desligar.
--
-- SECURITY DEFINER: a purga atravessa a visibilidade de gravação do admin (gravações privadas de
-- outros membros), restrita a `eclume_org()` e a admin, no molde de `eclume_voice_forget`.
-- Devolve `(embeddings, sugestões)` apagados; os `speaker_embeddings.json` do bucket saem pelo job
-- `purge_embedding_objects` do worker CPU.
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
