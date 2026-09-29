-- 017_dispositivo_le_resumo — a credencial de dispositivo lê resumos (holetz/eclume#57).
--
-- O app desktop avisa quando o resumo automático de uma gravação que ele enviou fica pronto, com
-- "Copiar" o Markdown; para isso o token `kind: device` ganha `summaries:read`, e os já emitidos
-- também. Padrão em docs/standards/code/server-mcp-e-dispositivos.md.

UPDATE api_tokens SET scopes = array_append(scopes, 'summaries:read')
WHERE kind = 'device' AND NOT 'summaries:read' = ANY (scopes);
