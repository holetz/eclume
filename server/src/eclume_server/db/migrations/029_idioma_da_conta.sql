-- 029_idioma_da_conta — idioma de transcrição preferido da conta (holetz/eclume#121).
--
-- `users.transcription_language` é um idioma (`pt`, `en-US`), `auto` (a engine detecta) ou nulo
-- (vale o padrão do servidor, `asr.default_language`). O idioma do job sai na hora de enfileirar:
-- o do arquivo, o da conta, o do servidor, `pt`. Regras em docs/standards/api/jobs-transcricao.md.

ALTER TABLE users
    ADD COLUMN transcription_language text;
