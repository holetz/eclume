-- 013_revisao_do_processamento — correções da revisão do processamento automático (holetz/eclume#33).
--
-- `recordings.subject` guarda o assunto de antes do primeiro padrão de título: reaplicar um tipo
-- renderiza o padrão sobre ele, nunca sobre o título já renderizado. Nulo até o primeiro padrão
-- aplicado. Padrões em docs/standards/code/processamento-automatico.md.

ALTER TABLE recordings ADD COLUMN subject text;
