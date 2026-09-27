-- 013_revisao_do_processamento — correções da revisão do processamento automático (holetz/eclume#33).
--
-- `recordings.subject` guarda o assunto de antes do primeiro padrão de título: reaplicar um tipo
-- renderiza o padrão sobre ele, nunca sobre o título já renderizado. Nulo até o primeiro padrão
-- aplicado. Padrões em docs/standards/code/processamento-automatico.md.
--
-- `agent_providers` ganha a garantia, no banco, de uma finalidade por provider (server-agentes.md).

ALTER TABLE recordings ADD COLUMN subject text;

-- Cada finalidade tem no máximo um provider, garantido no banco: toda escrita de `used_for`
-- serializa no mesmo advisory lock de transação que as rotas do admin tomam, e a sobreposição com
-- outro provider é recusada.
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
