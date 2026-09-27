---
type: standard
title: Servidor MCP e ligação de dispositivos
description: Como o server atende assistentes e aparelhos — o servidor MCP em /mcp (SDK mcp 2.x, HTTP streamable sem estado, Bearer eclp_ pelo BearerGate, ferramentas × escopos, erro de ferramenta que nomeia o escopo), os grupos de escopo da tela Conexão MCP, a credencial de dispositivo (login por e-mail e senha ou código de pareamento de 6 caracteres com o link do QR), o limite de tentativas e o descritor público /server com a impressão digital da CA raiz.
resource: server/src/eclume_server/mcp_server/**, server/src/eclume_server/devices.py, server/src/eclume_server/ratelimit.py, server/src/eclume_server/server_info.py, server/src/eclume_server/routes/devices.py, server/src/eclume_server/routes/server_info.py, server/src/eclume_server/db/migrations/015_dispositivos_e_mcp.sql
tags: [code, server, mcp, dispositivos, pareamento, tokens, escopos]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#35
maintainer: holetz
---

# Servidor MCP e ligação de dispositivos

O assistente (Claude Desktop, Claude Code, qualquer cliente MCP) e os apps (desktop e celular)
entram no eclume por um token `eclp_` do usuário. O assistente recebe um PAT pessoal criado em
"Conexão MCP"; o aparelho recebe uma **credencial de dispositivo**, emitida pelo login ou pelo
pareamento. A autenticação comum está em [server-nucleo.md](server-nucleo.md) §Autenticação, e as
rotas no [contrato v1](../api/contrato-v1.md).

## Servidor MCP

- **Onde.** No mesmo processo do server (`mcp_server/`), e não num serviço atrás do Caddy: as
  ferramentas são as operações da API (RLS por `user_tx`, storage, fila, agentes) e usam o mesmo
  `AppContext`.
- **Montagem** (`mcp_server/app.py`, SDK `mcp` 2.x): `MCPServer("eclume", instructions=…)` e
  `streamable_http_app(stateless_http=True, json_response=True, transport_security=…)` sem a
  proteção de DNS rebinding (o Host é do Caddy e toda chamada exige Bearer). O `/mcp` entra no
  roteador do FastAPI como `Route` **exata**, nunca `Mount`: `Mount("/mcp")` responde `/mcp` com
  redirect para `/mcp/`, que clientes de POST não seguem. Nenhuma rota do SPA começa com `/mcp`.
- **Lifespan.** O lifespan de um subapp nunca roda, e o session manager só existe depois de
  `streamable_http_app()`: `create_app` monta o `MCPServer` (um por app, porque o manager roda uma
  vez só) e o seu lifespan entra em `session_manager.run()` depois de criar o `AppContext`.
- **Sem estado, resposta JSON.** Cada POST é independente: nenhuma sessão MCP em memória, o
  restart não derruba o assistente e várias réplicas funcionariam. Só ferramentas: sem recursos,
  prompts, notificações, progresso ou `elicit`.
- **Autenticação.** Não se usa o `token_verifier`/`AuthSettings` do SDK: eles publicam o metadata
  de recurso protegido do OAuth, e o eclume não tem servidor de autorização. O ASGI `BearerGate`
  chama `auth.authenticate(..., bearer_only=True)`: só `Authorization: Bearer eclp_…` (pessoal ou
  de dispositivo) vale, cookie não. Sem credencial válida, 401 `application/problem+json` com
  `WWW-Authenticate: Bearer`. Com ela, grava `mcp_last_used_at` junto de `last_used_at` e põe o
  `Principal` em `scope["eclume.principal"]`.
- **Dentro da ferramenta**, `principal_of(ctx)` lê o `Principal` do scope da requisição HTTP que o
  transporte guarda em `ctx.request_context.request`, e `app_of(ctx)` o `AppContext` do app. Nada
  de contextvar: o handler roda no task group do manager, fora da task da requisição.
- **Assistentes conectados.** Sem sessão, "conectado" é um token com `mcp_last_used_at` nas
  últimas 24 h; a Saúde do admin conta os tokens distintos.

## Ferramentas

Nomes em inglês (convenção dos clientes MCP); descrições, erros e `instructions` em pt-BR. Recebem
`recording_id` como UUID em texto e devolvem JSON estruturado (`structuredContent`, com o texto
espelhado). Chamam as funções de domínio (`recordings.list_library`, `search.search`,
`summaries`, `fields`, `transcripts`), nunca os handlers das rotas.

| Ferramenta | O que faz | Escopos | Anotação |
|---|---|---|---|
| `search_recordings(query?, started_from?, started_to?, tags?, agenda_type?, status?, limit=20, cursor?)` | sem `query`, a biblioteca por `recorded_at` desc com os filtros; com `query`, a busca full-text com o trecho (no máximo uma tag) | `recordings:read` (+ `transcripts:read` com `query`) | readOnly |
| `get_recording(recording_id)` | início, tipo, tags, campos com a origem, pessoas (locutores), marcadores e o status por etapa | `recordings:read` | readOnly |
| `list_fields_and_tags()` | campos (tipo e opções), tags em uso e tipos de agenda, para editar com valores válidos | `recordings:read` | readOnly |
| `get_transcript(recording_id, start_ms?, end_ms?)` | `[mm:ss] Locutor: fala`, até 60 000 caracteres, com `next_start_ms` quando sobra | `transcripts:read` | readOnly |
| `get_summary(recording_id)` | a versão atual (Markdown, id, número, origem) e a geração em aberto | `summaries:read` | readOnly |

- **Erros.** Escopo faltando, gravação inexistente ou de outra conta e validação voltam como erro
  de ferramenta (`isError: true`), com a mensagem em pt-BR ("Falta o escopo recordings:delete
  neste token."). Os problemas da API (404, 409, 422) viram erro de ferramenta pelo
  `as_tool_error()`.
- **Listagem.** `tools/list` mostra todas as ferramentas a qualquer token (é estática no
  `MCPServer`); a recusa nomeia o escopo, e o assistente explica ao usuário o que falta.

## Grupos da tela "Conexão MCP"

| Grupo | Escopos |
|---|---|
| Buscar e ler gravações | `recordings:read`, `transcripts:read` |
| Ler e editar resumos | `summaries:read`, `summaries:write` |
| Editar campos e tags | `recordings:write` |
| Excluir gravações | `recordings:delete` |

A validade (30 dias, 90 dias ou nunca) é o `expires_at` que a web calcula; "expirado" deriva
dele. O prefixo segue `eclp_`, que o `PatStore` do desktop valida.

## Credencial de dispositivo

- **É um token `kind: device`** com `platform`, nome = nome do aparelho, escopos
  `recordings:read` e `recordings:write` (upload, marcadores e status das próprias gravações) e
  sem validade. Aparece em `GET /tokens?kind=device` ("App móvel", "App desktop"), e
  `DELETE /tokens/{id}` ("Desvincular") desliga o aparelho. `POST /tokens` nunca cria um.
- **Login** (`POST /devices/login`, público): e-mail, senha, `device_name` e `platform`; a senha
  passa por `accounts.password_login`, o mesmo caminho de tempo constante do `/auth/login`, com a
  mesma mensagem no 401. A resposta 201 `DeviceCredential` traz o token, o segredo (só ali) e o
  descritor do servidor.
- **Código de pareamento** (`POST /devices/pairing-codes`, só sessão): 6 caracteres de
  `23456789ABCDEFGHJKMNPQRSTVWXYZ` (sem `0/1/I/L/O/U`, 30⁶ combinações), 10 minutos, uso único.
  O banco guarda só o HMAC-SHA256 com `ECLUME_SECRET_KEY` (`security.sign`): um SHA-256 puro de 6
  caracteres seria revertido do banco. O código novo vence os pendentes do mesmo usuário. A
  resposta traz `display` (`K7Q-4MX`) e o `pair_url`, conteúdo do QR:
  `<url>/parear?codigo=K7Q4MX&ca=<ca_sha256>` (sem `ca` enquanto a raiz não foi publicada). Lido
  pela câmera comum, abre a web, que manda instalar o app.
- **Estado** (`GET /devices/pairing-codes/{id}`, só sessão): `pending|used|expired` e o
  `token_id` emitido, para a web trocar o QR por "Pareado".
- **Troca** (`POST /devices/pair`, público): o código é normalizado (maiúsculas, sem hífen nem
  espaço) e marcado como usado num `UPDATE … WHERE used_at IS NULL AND expires_at > now()
  RETURNING` só de conta ativa; emite a credencial do dono e grava o `token_id` no código.
  Inválido, vencido ou usado → 401 `invalid_pairing_code`. `pairing_codes` tem RLS pelo dono; a
  troca, sem conta ainda, roda com o papel de conexão.
- **Limite de tentativas** (`ratelimit.attempts`): as rotas de credencial contam por IP numa
  janela fixa de 1 minuto no Redis (`ECLUME_CREDENTIAL_ATTEMPTS_PER_MINUTE`, 10). Com 30⁶
  combinações e poucos códigos vivos, o chute não chega a um código em 10 minutos.

## Descritor do servidor

`GET /api/v1/server` (público, `server_info.py`) devolve `name` (`ECLUME_SERVER_NAME`, padrão
`eclume`), `url` (`ECLUME_PUBLIC_URL`, ou a da requisição), `mcp_url` (`<url>/mcp`), `ca_sha256`
e as versões. `ca_sha256` é o SHA-256, em hex minúsculo, do DER do primeiro certificado do PEM em
`ECLUME_CA_FILE` (em produção, `/srv/downloads/eclume-root.crt`, montado read-only). O valor fica
em cache pelo `mtime`: no primeiro deploy a CA é publicada depois de o server subir, e o
descritor passa a trazê-la sem restart. Sem arquivo (ou PEM inválido), `null`. É a fonte do mDNS,
do QR, do pareamento e do endereço embutido no instalador.
