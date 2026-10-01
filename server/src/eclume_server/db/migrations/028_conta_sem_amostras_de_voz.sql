-- 028_conta_sem_amostras_de_voz — a conta pode deixar de guardar amostras de voz (holetz/eclume#116).
--
-- `users.voice_keep_samples` (padrão `true`) é a escolha do titular. Desligar apaga, na mesma
-- transação e sob a RLS do dono, as amostras, os `speaker_embeddings` e as sugestões pendentes da
-- conta; daí em diante a ingestão não grava vetor da conta e o job não pede o embedding.
-- Regras em docs/standards/code/identificacao-por-voz.md.

ALTER TABLE users
    ADD COLUMN voice_keep_samples boolean NOT NULL DEFAULT true;
