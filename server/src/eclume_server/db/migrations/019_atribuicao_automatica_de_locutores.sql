-- 019_atribuicao_automatica_de_locutores — the voice links the speaker to the person on its own, above a threshold
-- each user chooses.
--
-- `users` keeps the preference: on by default, but it only applies with voice identification on in the
-- platform. `speakers.auto_score` marks the link the voice made (its score) and stays `NULL`
-- on a link a person made or confirmed: only the confirmed one reinforces the voiceprint.
-- Rules in docs/standards/code/identificacao-por-voz.md.

ALTER TABLE users
    ADD COLUMN voice_auto_assign    boolean NOT NULL DEFAULT true,
    ADD COLUMN voice_auto_threshold double precision NOT NULL DEFAULT 0.75
        CONSTRAINT users_voice_auto_threshold_check CHECK (voice_auto_threshold BETWEEN 0.5 AND 0.99);

ALTER TABLE speakers
    ADD COLUMN auto_score double precision
        CONSTRAINT speakers_auto_score_check CHECK (auto_score IS NULL OR (auto_score BETWEEN 0 AND 1 AND person_id IS NOT NULL));
