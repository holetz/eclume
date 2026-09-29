-- 018_dispositivo_le_transcricao — a credencial de dispositivo lê transcrições.
--
-- O app desktop espelha a biblioteca numa pasta local (resumos em Markdown e transcrições em
-- JSONL); para ler `GET /transcripts` o token `kind: device` ganha `transcripts:read`, e os já
-- emitidos também. Padrão em docs/standards/code/server-mcp-e-dispositivos.md.

UPDATE api_tokens SET scopes = array_append(scopes, 'transcripts:read')
WHERE kind = 'device' AND NOT 'transcripts:read' = ANY (scopes);
