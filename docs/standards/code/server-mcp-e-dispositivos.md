---
type: standard
title: Servidor MCP e ligação de dispositivos
description: Como o server atende assistentes e aparelhos — o servidor MCP em /mcp (SDK mcp 2.x, HTTP streamable sem estado, Bearer eclp_ pelo BearerGate, ferramentas × escopos, erro de ferramenta que nomeia o escopo), os grupos de escopo da tela Conexão MCP, a credencial de dispositivo (login por e-mail e senha ou código de pareamento de 6 caracteres com o link do QR), o limite de tentativas e o descritor público /server com a impressão digital da CA raiz.
resource: server/src/eclume_server/mcp_server/**, server/src/eclume_server/devices.py, server/src/eclume_server/ratelimit.py, server/src/eclume_server/server_info.py, server/src/eclume_server/routes/devices.py, server/src/eclume_server/routes/server_info.py, server/src/eclume_server/db/migrations/015_dispositivos_e_mcp.sql, server/src/eclume_server/db/migrations/017_dispositivo_le_resumo.sql
tags: [code, server, mcp, dispositivos, pareamento, tokens, escopos]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#35, holetz/eclume#57, holetz/eclume#144
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
espelhado). Chamam as funções de domínio (`recordings.list_library`, `recordings.delete_recording_of`,
`search.search`, `summaries`, `summary_chat.open_request`, `fields`, `transcripts`), nunca os
handlers das rotas; o que vivia só no handler desce para o módulo de domínio.

| Ferramenta | O que faz | Escopos | Anotação |
|---|---|---|---|
| `search_recordings(query?, started_from?, started_to?, tags?, agenda_type?, status?, awaiting?, limit=20, cursor?)` | sem `query`, a biblioteca por `recorded_at` desc com os filtros (`awaiting="speakers"`: só as paradas à espera dos nomes dos locutores); com `query`, a busca full-text com o trecho (no máximo uma tag). Cada gravação traz `awaiting`, como `Recording.awaiting` | `recordings:read` (+ `transcripts:read` com `query`) | readOnly |
| `get_recording(recording_id)` | início, tipo, tags, campos com a origem, pessoas (locutores), marcadores, o status por etapa (com `speakers` em `waiting`) e `awaiting` | `recordings:read` | readOnly |
| `list_fields_and_tags()` | campos (tipo e opções), tags em uso e tipos de agenda, para editar com valores válidos | `recordings:read` | readOnly |
| `get_transcript(recording_id, start_ms?, end_ms?)` | `[mm:ss] Locutor: fala`, até 60 000 caracteres, com `next_start_ms` quando sobra | `transcripts:read` | readOnly |
| `get_summary(recording_id)` | a versão atual (Markdown, id, número, origem) e a geração em aberto | `summaries:read` | readOnly |
| `update_summary(recording_id, content_md)` | versão `manual` nova sobre a atual (`summaries.edit_current`, sem `base_version`) | `summaries:read`, `summaries:write` | — |
| `request_summary(recording_id, instruction?)` | sem instrução, um resumo novo pelas instruções do tipo e o provider de resumos; com instrução, uma mensagem ao chat de ajuste; devolve o id pendente | `summaries:read`, `summaries:write` | — |
| `update_fields(recording_id, title?, tags?, fields?)` | título, tags (a lista inteira) e campos do usuário por id, validados pelo tipo do campo, com origem `edited` | `recordings:write` | idempotent |
| `delete_recording(recording_id)` | a exclusão da API (`recordings.delete_recording_of`) | `recordings:delete` | destructive |

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
  `recordings:read` e `recordings:write` (upload, marcadores, status das próprias gravações e a
  lista dos tipos de agenda, que `GET /agenda-types` aceita com `recordings:read` desde a 2.4.0)
  e, desde a 2.6.0, `summaries:read` — o app desktop lê o resumo pronto das gravações que enviou
  para avisar com "Copiar". A migration `017_dispositivo_le_resumo` estendeu os tokens já
  emitidos. Desde a 2.8.0 também `transcripts:read`, para a pasta sincronizada do desktop (resumos
  em Markdown e transcrições em JSONL, [desktop-pasta-sincronizada.md](desktop-pasta-sincronizada.md)):
  a migration `018_dispositivo_le_transcricao` estendeu os tokens já emitidos. Com ele o dispositivo também lê o resto de `/agenda-types`; escrever resumos e tipos
  de agenda segue pedindo `summaries:write`, que ele não tem. Sem validade. Aparece em `GET /tokens?kind=device` ("App móvel", "App desktop"), e
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
  troca, sem conta ainda, roda com o papel de conexão. O cron `expire_pairing_codes` do worker
  (de hora em hora) apaga os códigos vencidos sem uso há mais de um dia; os usados ficam, com o
  `token_id`.
- **Aviso no login de dispositivo:** conta que ainda não aceitou o aviso em vigor não ganha
  credencial nova por `POST /devices/login` (**403** `notice_required`; aceita na web e entra de
  novo). As credenciais já emitidas seguem valendo, como todo PAT. O código de pareamento nasce
  numa sessão, que já exige o aceite.
- **Limite de tentativas** (`ratelimit.py`): as rotas de credencial contam por IP numa janela
  fixa de 1 minuto no Redis (`ECLUME_CREDENTIAL_ATTEMPTS_PER_MINUTE`, 10). Os logins por senha
  contam também por conta (`count_login`, `eclume:rl:user_email:<e-mail>`, comum a
  `/auth/login` e `/devices/login`; o admin tem a sua), e a troca de código tem ainda um teto
  global de seis vezes o limite por IP (`PAIR_GLOBAL_FACTOR`): trocar de IP não multiplica os
  chutes. Com 30⁶ combinações e no máximo 600 trocas em 10 minutos, o chute não chega a um
  código vivo.

## Descritor do servidor

`GET /api/v1/server` (público, `server_info.py`) devolve `name` (`ECLUME_SERVER_NAME`, padrão
`eclume`), `url` (`ECLUME_PUBLIC_URL`, ou a da requisição), `mcp_url` (`<url>/mcp`), `ca_sha256`
e as versões. `ca_sha256` é o SHA-256, em hex minúsculo, do DER do primeiro certificado do PEM em
`ECLUME_CA_FILE` (em produção, `/srv/downloads/eclume-root.crt`, montado read-only). O valor fica
em cache pelo `mtime`: no primeiro deploy a CA é publicada depois de o server subir, e o
descritor passa a trazê-la sem restart. Sem arquivo (ou PEM inválido), `null`. É a fonte do mDNS,
do QR, do pareamento e do endereço embutido no instalador.

## Descoberta na rede (mDNS)

- **Registro** (`discovery.py`): tipo `_eclume._tcp.local.`, instância `<ECLUME_SERVER_NAME>`,
  host `<nome>.local.`, endereço e porta lidos de `ECLUME_PUBLIC_URL` (um nome é resolvido para
  IPv4). Nunca os IPs das interfaces: na rede do host, as bridges do Docker também são
  interfaces. O TXT tem `url` (a URL pública), `ca` (o `ca_sha256`, vazio sem CA), `v` (versão do
  contrato) e `name`. O TXT **não é autenticado**: qualquer máquina da LAN pode anunciar um
  `_eclume._tcp` com outra CA. Ele é uma dica de endereço; o app mostra a impressão digital e
  pede confirmação antes de fixar uma CA que só o mDNS trouxe (ver abaixo).
- **`eclume-server announce`** registra com `zeroconf.asyncio` só na interface do endereço
  público, relê o PEM a cada 60 s e atualiza o TXT quando a CA muda (inclusive quando ela é
  publicada depois); ao parar, manda os goodbyes. Sem `ECLUME_PUBLIC_URL`, recusa.
- **`eclume-server discover [--timeout N]`** escuta `N` segundos e imprime um JSON por servidor
  (`name`, `url`, `ca_sha256`, `contract_version`, `addresses`, `port`); nenhum → saída 1. Serve
  ao diagnóstico e à prova do deploy.
- **Onde roda.** No serviço `mdns` do compose de produção: a imagem do server, `network_mode:
  host` (o multicast não sai da bridge), a pasta de downloads montada read-only e nenhuma porta
  publicada. Não depende de sudo nem de pacote no host; o deploy o recria depois do `publish-ca`.
- **Firewall.** O multicast usa 5353/udp na rede do host e passa pelo ufw (só as portas
  publicadas pelo Docker passam por fora): `ufw allow from 192.168.15.0/24 to any port 5353 proto
  udp`, passo manual do runbook do host.

## Fixação da CA pelos apps

O Caddy `tls internal` troca o certificado folha a cada ~12 h e o intermediário a cada ~7 dias, e
não envia a raiz na cadeia; a raiz vale 10 anos e vive no volume `caddy-data`. Por isso os apps
fixam a **raiz**, nunca o folha, sem instalar a CA no sistema:

1. obter `url` e `ca_sha256` — do instalador (endereço embutido no build), do QR (`pair_url`,
   que sai da web autenticada) ou do TXT do mDNS (não autenticado: antes de mandar a senha, a
   pessoa confirma a impressão digital, como no endereço digitado);
2. baixar `<url>/downloads/eclume-root.crt` numa conexão sem verificação;
3. conferir o SHA-256 do DER; divergiu, descartar e parar;
4. gravar o PEM e usá-lo como `ca_path` (raízes do SO + esta), o caminho que o `transport.rs` e o
   updater do desktop já honram.

Com endereço digitado e sem impressão digital, o app confia na primeira CA (TOFU) e mostra a
impressão digital ao usuário. A troca do código de pareamento e o login só acontecem depois da
fixação; `GET /api/v1/server` confirma o que veio e permite trocar de servidor ("Usar outro").

**Endereço embutido no instalador.** O empacotamento Tauri de hoje embute no **build**: o
`desktop-release.yml` passa `ECLUME_SERVER_URL` e `ECLUME_SERVER_CA_SHA256` (variáveis do
repositório, ao lado de `ECLUME_DOWNLOADS_URL`), e o app os lê por `option_env!`, como o
`DEFAULT_WEB_URL`. O release já é por servidor: os manifestos têm URLs absolutas deste host.
