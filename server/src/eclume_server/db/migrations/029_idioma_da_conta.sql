-- 029_idioma_da_conta — the account's preferred transcription language (holetz/eclume#121).
--
-- `users.transcription_language` is a language (`pt`, `en-US`), `auto` (the engine detects) or null
-- (the server default applies, `asr.default_language`). The job's language is set at enqueue time:
-- the file's, the account's, the server's, `pt`. Rules in docs/standards/api/jobs-transcricao.md.

ALTER TABLE users
    ADD COLUMN transcription_language text;
