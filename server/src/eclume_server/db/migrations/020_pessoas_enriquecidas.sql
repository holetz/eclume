-- 020_pessoas_enriquecidas — the person gains company, department, job title, phone and person tags
-- (holetz/eclume#75).
--
-- They are the directory data that filter the library by participants ("someone from company X,
-- department Y, with tag Z spoke in the recording") and that collection assignment reads. All optional; the
-- person tags are labels of the person, separate from the recordings' tags. Rules in
-- docs/standards/code/frontend-web.md (`Pessoas`) and in contract v1.

ALTER TABLE people
    ADD COLUMN company       text CHECK (company IS NULL OR company <> ''),
    ADD COLUMN department    text CHECK (department IS NULL OR department <> ''),
    ADD COLUMN job_title     text CHECK (job_title IS NULL OR job_title <> ''),
    ADD COLUMN phone         text CHECK (phone IS NULL OR phone <> ''),
    ADD COLUMN tags          text[] NOT NULL DEFAULT '{}';

-- The library filter and the facets compare accent- and case-insensitively, like the name.
CREATE INDEX people_company_idx ON people (owner_id, lower(eclume_unaccent(company)))
    WHERE company IS NOT NULL;
CREATE INDEX people_department_idx ON people (owner_id, lower(eclume_unaccent(department)))
    WHERE department IS NOT NULL;
CREATE INDEX people_tags_idx ON people USING gin (tags);
