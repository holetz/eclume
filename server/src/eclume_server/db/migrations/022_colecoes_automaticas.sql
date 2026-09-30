-- 022_colecoes_automaticas — o agente põe a gravação nas coleções pela regra de cada uma
-- (holetz/eclume#77).
--
-- A coleção ganha a regra ("Quando incluir") e o interruptor "Incluir automaticamente"; o
-- `fill_fields` lê as coleções automáticas com regra, o tipo de agenda e os participantes (pessoas
-- ligadas aos locutores, com empresa, área, cargo e tags de pessoa) e escolhe as coleções na mesma
-- chamada dos campos. `recordings.collections_origin` diz de quem é a lista: `auto` (o agente),
-- `edited` (o usuário mexeu; o agente não toca mais) ou nula (vinda do envio, ou ainda sem escolha:
-- o agente só soma). Padrões em docs/standards/code/processamento-automatico.md.

ALTER TABLE collections
    ADD COLUMN instructions  text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
    ADD COLUMN auto_assign   boolean NOT NULL DEFAULT false;

ALTER TABLE recordings
    ADD COLUMN collections_origin text CHECK (collections_origin IN ('auto', 'edited'));
