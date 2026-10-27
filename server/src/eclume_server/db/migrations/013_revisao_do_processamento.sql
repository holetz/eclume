-- 013_revisao_do_processamento — fixes from the automatic processing review (holetz/eclume#33).
--
-- `recordings.subject` keeps the subject from before the first title pattern: reapplying a type
-- renders the pattern over it, never over the already rendered title. Null until the first pattern
-- is applied. Patterns in docs/standards/code/processamento-automatico.md.
--
-- `agent_providers` gets the guarantee, in the database, of one purpose per provider (server-agentes.md).

ALTER TABLE recordings ADD COLUMN subject text;

-- Each purpose has at most one provider, guaranteed in the database: every write of `used_for`
-- serializes on the same transaction advisory lock the admin routes take, and an overlap with
-- another provider is refused.
CREATE FUNCTION eclume_agent_providers_one_per_purpose() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('agent_providers.used_for'));
    IF EXISTS (SELECT 1 FROM agent_providers p WHERE p.id <> NEW.id AND p.used_for && NEW.used_for) THEN
        RAISE EXCEPTION 'finalidade já declarada por outro provider: %', NEW.used_for
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER agent_providers_one_per_purpose
    BEFORE INSERT OR UPDATE OF used_for ON agent_providers
    FOR EACH ROW EXECUTE FUNCTION eclume_agent_providers_one_per_purpose();
