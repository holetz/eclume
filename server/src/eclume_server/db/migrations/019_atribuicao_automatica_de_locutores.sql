-- 019_atribuicao_automatica_de_locutores — a voz liga o locutor à pessoa sozinha, acima de um limiar
-- que cada usuário escolhe.
--
-- `users` guarda a preferência: ligada por padrão, mas só vale com a identificação por voz ligada na
-- plataforma. `speakers.auto_score` marca o vínculo que a voz fez (a pontuação dele) e fica `NULL`
-- no vínculo que uma pessoa fez ou confirmou: só o confirmado reforça a impressão de voz.
-- Regras em docs/standards/code/identificacao-por-voz.md.

ALTER TABLE users
    ADD COLUMN voice_auto_assign    boolean NOT NULL DEFAULT true,
    ADD COLUMN voice_auto_threshold double precision NOT NULL DEFAULT 0.75
        CONSTRAINT users_voice_auto_threshold_check CHECK (voice_auto_threshold BETWEEN 0.5 AND 0.99);

ALTER TABLE speakers
    ADD COLUMN auto_score double precision
        CONSTRAINT speakers_auto_score_check CHECK (auto_score IS NULL OR (auto_score BETWEEN 0 AND 1 AND person_id IS NOT NULL));
