-- 020_pessoas_enriquecidas — a pessoa ganha organização, área, cargo, telefone e tags de pessoa
-- (holetz/eclume#75).
--
-- São os dados de cadastro que filtram a biblioteca pelos participantes ("alguém da organização X,
-- da área Y, com a tag Z falou na gravação") e que a atribuição de coleções lê. Todos opcionais; as
-- tags de pessoa são rótulos da pessoa, separados das tags das gravações. Regras em
-- docs/standards/code/frontend-web.md (Pessoas) e no contrato v1.

ALTER TABLE people
    ADD COLUMN organization  text CHECK (organization IS NULL OR organization <> ''),
    ADD COLUMN department    text CHECK (department IS NULL OR department <> ''),
    ADD COLUMN job_title     text CHECK (job_title IS NULL OR job_title <> ''),
    ADD COLUMN phone         text CHECK (phone IS NULL OR phone <> ''),
    ADD COLUMN tags          text[] NOT NULL DEFAULT '{}';

-- O filtro da biblioteca e as facetas comparam sem acento e sem caixa, como o nome.
CREATE INDEX people_organization_idx ON people (owner_id, lower(eclume_unaccent(organization)))
    WHERE organization IS NOT NULL;
CREATE INDEX people_department_idx ON people (owner_id, lower(eclume_unaccent(department)))
    WHERE department IS NOT NULL;
CREATE INDEX people_tags_idx ON people USING gin (tags);
