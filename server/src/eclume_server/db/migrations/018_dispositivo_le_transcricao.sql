-- 018_dispositivo_le_transcricao — the device credential reads transcripts.
--
-- The desktop app mirrors the library into a local folder (summaries in Markdown and transcripts in
-- JSONL); to read `GET /transcripts` the `kind: device` token gains `transcripts:read`, and the ones already
-- issued too. Pattern in docs/standards/code/server-mcp-e-dispositivos.md.

UPDATE api_tokens SET scopes = array_append(scopes, 'transcripts:read')
WHERE kind = 'device' AND NOT 'transcripts:read' = ANY (scopes);
