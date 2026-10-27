-- 011_plataforma_de_processamento — agents per purpose and preprocessing (holetz/eclume#33).
--
-- Each provider declares what it is for (`used_for`); each purpose has at most one provider. The
-- former default provider inherits all four. The `summarization` block goes (`auto_summarize` and the default
-- provider lose their meaning: the automatic summary follows the agenda type) and `preprocessing` comes in, the
-- audio treatment before transcription. Patterns in docs/standards/code/server-admin.md.

ALTER TABLE agent_providers
    ADD COLUMN used_for text[] NOT NULL DEFAULT '{}'
        CHECK (used_for <@ ARRAY['summaries', 'fields', 'chat', 'agenda_detection']);

-- The summary's default, if enabled; otherwise, the only enabled provider.
UPDATE agent_providers SET used_for = ARRAY['summaries', 'fields', 'chat', 'agenda_detection']
WHERE id = coalesce(
    (SELECT p.id FROM agent_providers p JOIN platform_settings s
        ON p.id::text = s.summarization ->> 'default_provider_id' WHERE p.enabled),
    (SELECT min(p.id::text)::uuid FROM agent_providers p WHERE p.enabled
        HAVING count(*) = 1)
);

-- `eclume_app` reads the columns without secrets (the summary resolves the provider under the user's RLS).
GRANT SELECT (used_for) ON agent_providers TO eclume_app;

ALTER TABLE platform_settings
    ADD COLUMN preprocessing jsonb NOT NULL DEFAULT
        '{"denoise": {"enabled": true, "method": "rnnoise", "strength": 0.6},
          "loudnorm": {"enabled": true, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
          "trim_silence": {"enabled": true, "min_silence_s": 3, "threshold_db": -50},
          "split_channels": {"enabled": false}}'::jsonb,
    DROP COLUMN summarization;
