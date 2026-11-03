-- 035_account_locale — the account's product locale (holetz/eclume#248).
--
-- `users.locale` is `en` or `pt-BR`, or null (no choice: a request resolves `Accept-Language`, then
-- `en`; a job resolves `en`). Every account that exists now was created under the pt-BR-only
-- product, so it is backfilled to `pt-BR`; a new sign-up stores the locale its `Accept-Language`
-- resolves to, or null. Separate from `transcription_language` (the ASR language). Rules in
-- docs/standards/code/i18n.md.

ALTER TABLE users
    ADD COLUMN locale text
        CONSTRAINT users_locale_supported CHECK (locale IN ('en', 'pt-BR'));

UPDATE users SET locale = 'pt-BR';
