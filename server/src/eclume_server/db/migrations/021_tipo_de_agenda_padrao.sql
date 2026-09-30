-- 021_tipo_de_agenda_padrao — todo usuário tem um tipo de agenda de reserva, e o título passa a ser
-- definido só pelos tipos (holetz/eclume#76).
--
-- O tipo de reserva ("Geral", com o selo "Padrão" na tela) não pode ser excluído e é aplicado
-- quando nenhum outro tipo se encaixa com confiança, quando só ele existe, sem agente de detecção ou
-- quando a detecção falha: toda gravação processada ganha um tipo e, com ele, o resumo automático.
-- Cada tipo ganha a regra do assunto do título (`title_instructions`); vazia, vale a do tipo de
-- reserva. A regra do título embutido, que era editada em "Campos e regras", vira a regra do tipo de
-- reserva da conta. Padrões em docs/standards/code/processamento-automatico.md.

ALTER TABLE agenda_types
    ADD COLUMN is_fallback         boolean NOT NULL DEFAULT false,
    ADD COLUMN title_instructions  text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX agenda_types_fallback_idx ON agenda_types (owner_id) WHERE is_fallback;

-- O admin também escreve a regra do assunto dos tipos que distribui.
ALTER TABLE default_agenda_types ADD COLUMN title_instructions text NOT NULL DEFAULT '';

-- O tipo de reserva de uma conta, com a regra do título embutido dela. Idempotente. "Geral" já usado
-- por um tipo do usuário vira "Geral (padrão)", como na migration 009.
CREATE FUNCTION eclume_seed_fallback_type(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM agenda_types WHERE owner_id = target AND is_fallback) THEN
        RETURN;
    END IF;
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, title_instructions, is_fallback)
    VALUES (
        target,
        CASE WHEN EXISTS (SELECT 1 FROM agenda_types WHERE owner_id = target AND name = 'Geral')
             THEN 'Geral (padrão)' ELSE 'Geral' END,
        0,
        '{assunto}',
        '',
        '{}',
        E'## Resumo\nDe duas a quatro frases sobre o que a conversa tratou.\n\n' ||
        E'## Decisões\nUm item por decisão tomada. Sem decisões, escreva "Nenhuma decisão registrada."\n\n' ||
        E'## Próximos passos\nUm item por tarefa combinada: responsável, o quê e quando, quando ditos.',
        coalesce(
            (SELECT instructions FROM fields WHERE owner_id = target AND builtin = 'title'),
            'Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas.'
        ),
        true
    );
END
$$;
REVOKE ALL ON FUNCTION eclume_seed_fallback_type(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eclume_seed_fallback_type(uuid) TO eclume_server;

-- A semeadura da conta nova cria também o tipo de reserva, depois dos embutidos (ele lê a regra do
-- título).
CREATE OR REPLACE FUNCTION eclume_seed_user_defaults(target uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO agenda_types (owner_id, name, position, title_pattern, identify, default_tags,
                              summary_instructions, title_instructions, from_default_id)
    SELECT target, d.name, d.position, d.title_pattern, d.identify, d.default_tags, d.summary_instructions,
           d.title_instructions, d.id
    FROM default_agenda_types d
    WHERE d.include_for_new_users
    ON CONFLICT (owner_id, name) DO NOTHING;
    PERFORM eclume_seed_builtin_fields(target);
    PERFORM eclume_seed_fallback_type(target);
END
$$;

SELECT eclume_seed_fallback_type(id) FROM users;

-- O título deixa de ter regra e interruptor próprios na tela: o assunto é sempre preenchido, pela
-- regra do tipo da gravação.
UPDATE fields SET auto_fill = true, updated_at = now() WHERE builtin = 'title' AND NOT auto_fill;
