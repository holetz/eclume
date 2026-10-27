-- 017_dispositivo_le_resumo — the device credential reads summaries (holetz/eclume#57).
--
-- The desktop app notifies when the automatic summary of a recording it sent is ready, with
-- "Copiar" the Markdown; for that the `kind: device` token gains `summaries:read`, and the ones already issued
-- too. Pattern in docs/standards/code/server-mcp-e-dispositivos.md.

UPDATE api_tokens SET scopes = array_append(scopes, 'summaries:read')
WHERE kind = 'device' AND NOT 'summaries:read' = ANY (scopes);
