-- 011_plataforma_de_processamento — agentes por finalidade e pré-processamento (holetz/eclume#33).
--
-- Cada provider declara para que serve (`used_for`); cada finalidade tem no máximo um provider. O
-- antigo provider padrão herda as quatro. O bloco `summarization` sai (`auto_summarize` e o provider
-- padrão perdem o sentido: o resumo automático segue o tipo de agenda) e entra `preprocessing`, o
-- tratamento do áudio antes da transcrição. Padrões em docs/standards/code/server-admin.md.

ALTER TABLE agent_providers
    ADD COLUMN used_for text[] NOT NULL DEFAULT '{}'
        CHECK (used_for <@ ARRAY['summaries', 'fields', 'chat', 'agenda_detection']);

-- O padrão do resumo, se habilitado; senão, o único provider habilitado.
UPDATE agent_providers SET used_for = ARRAY['summaries', 'fields', 'chat', 'agenda_detection']
WHERE id = coalesce(
    (SELECT p.id FROM agent_providers p JOIN platform_settings s
        ON p.id::text = s.summarization ->> 'default_provider_id' WHERE p.enabled),
    (SELECT min(p.id::text)::uuid FROM agent_providers p WHERE p.enabled
        HAVING count(*) = 1)
);

-- `eclume_app` lê as colunas sem segredo (o resumo resolve o provider sob a RLS do usuário).
GRANT SELECT (used_for) ON agent_providers TO eclume_app;

ALTER TABLE platform_settings
    ADD COLUMN preprocessing jsonb NOT NULL DEFAULT
        '{"denoise": {"enabled": true, "method": "rnnoise", "strength": 0.6},
          "loudnorm": {"enabled": true, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
          "trim_silence": {"enabled": true, "min_silence_s": 3, "threshold_db": -50},
          "split_channels": {"enabled": false}}'::jsonb,
    DROP COLUMN summarization;
