-- 022_colecoes_automaticas — the agent puts the recording into collections by each one's rule
-- (holetz/eclume#77).
--
-- The collection gains the rule ("Quando incluir") and the "Incluir automaticamente" switch; the
-- `fill_fields` reads the automatic collections with a rule, the agenda type and the participants (people
-- linked to the speakers, with company, department, job title and person tags) and chooses the collections in the same
-- call as the fields. `recordings.collections_origin` says whose list it is: `auto` (the agent),
-- `edited` (the user changed it; the agent no longer touches it) or null (from the upload, or no choice yet:
-- the agent only adds). Patterns in docs/standards/code/processamento-automatico.md.

ALTER TABLE collections
    ADD COLUMN instructions  text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
    ADD COLUMN auto_assign   boolean NOT NULL DEFAULT false;

ALTER TABLE recordings
    ADD COLUMN collections_origin text CHECK (collections_origin IN ('auto', 'edited'));
