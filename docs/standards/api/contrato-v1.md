---
type: standard
title: Contrato de API v1
description: As convenções da API v1 do eclume — conta por usuário, sessão de usuário e PAT com escopos, sessão de admin própria para /admin/*, credencial de dispositivo e descritor público, o /mcp fora do /api/v1, erros RFC 9457, paginação por cursor, upload multipart S3 com dedup por hash, transcrição em JSON Schema — e a regra de que a v1 só evolui de forma aditiva, com a linha 2.x do redesign como exceção única.
resource: contracts/**, deploy/docker-compose.mock.yml, server/**
tags: [api, contrato, openapi, pat, upload, evolucao]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#3, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#35, holetz/eclume#41
maintainer: holetz
---

# Contrato de API v1

O contrato fica em `contracts/`: `openapi-v1.yaml` e `transcript.schema.json` são a fonte da
verdade, `fixtures/` traz os exemplos e `openapi-v1.bundled.yaml` é o derivado de arquivo único
que o mock (Prism) e os geradores de tipos leem. O servidor **conforma** ao contrato; o contrato
nunca é gerado do código. O manual de uso (mock, lumea, desktop, mapeamento para
`transcricao.md`) está em [contracts/README.md](/contracts/README.md).

## Convenções

- **Prefixo e formatos.** Tudo sob `/api/v1`, menos o servidor MCP em `/mcp` (JSON-RPC do Model
  Context Protocol, fora do OpenAPI; ver
  [server-mcp-e-dispositivos.md](../code/server-mcp-e-dispositivos.md)). Datas em RFC 3339 UTC, durações em milissegundos
  inteiros (`*_ms`), ids em UUID; locutores têm id `S<n>` único na transcrição.
- **Conta por usuário.** Não há organização: cada conta vê e muda só o que é dela. A conta nasce
  no cadastro aberto (`POST /auth/signup`), com o aceite do aviso em vigor; uma conta sem o
  aceite vigente recebe `notice_required: true` em `GET /me` e aceita por `POST /me/notice`.
  Desde a 2.3.0, a **sessão** dessa conta recebe **403** `notice_required` em toda rota de
  usuário, menos `GET /me`, `POST /me/notice` e `/auth/*`; o PAT não é barrado (o desktop e o
  lumea de contas migradas seguem funcionando, e quem pede o aceite é o web).
- **Autenticação.** Três esquemas.
  - **Sessão de usuário** (`sessionCookie`): cookie `eclume_session` (HttpOnly, Secure,
    SameSite=Lax) com CSRF por double-submit (`X-CSRF-Token` = cookie `eclume_csrf`) em método
    mutável.
  - **PAT** (`pat`) em `Authorization: Bearer eclp_<segredo>`, guardado só como hash e mostrado
    uma vez. `Token.kind` distingue o PAT **pessoal** (`personal`, criado em `POST /tokens`) da
    **credencial de dispositivo** (`device`, com `platform`), que só nasce de
    `POST /devices/login` (e-mail e senha) ou `POST /devices/pair` (código de pareamento) e
    responde como qualquer PAT; `GET /tokens?kind=` separa as duas listas.
  - **Sessão de admin** (`adminSessionCookie`): conta de admin separada das contas de usuário,
    aberta por `POST /admin/auth/login`. Cookie `eclume_admin_session` (HttpOnly, Secure,
    SameSite=Strict, `Path=/api/v1/admin`) e CSRF por `X-CSRF-Token` = cookie `eclume_admin_csrf`.
- **Fronteira do admin.** `/api/v1/admin/*` (menos o login) declara só `adminSessionCookie`:
  sessão de usuário, PAT ou nada ali dão **401** `unauthorized`. A sessão de admin é ignorada em
  qualquer outra rota. O admin vê só a plataforma (configuração, segredos, agentes, contas,
  saúde); nenhuma rota de admin devolve conteúdo de usuário.
- **Escopos do PAT:** `recordings:read`, `recordings:write`, `recordings:delete` (2.3.0, a
  exclusão de gravação), `transcripts:read`,
  `transcripts:write`, `people:read`, `people:write`, `summaries:read`, `summaries:write`. Nenhum
  implica outro; a operação lista no requisito `pat: [...]` todos os que exige. Quando basta um de
  vários, a operação declara um requisito `pat` por escopo e a rota usa `requires_any` (desde a
  2.4.0, `GET /agenda-types` aceita `summaries:read` ou `recordings:read`, para a credencial de
  dispositivo escolher o tipo ao parar). A credencial de dispositivo tem `recordings:read`,
  `recordings:write`, `summaries:read` (2.6.0) e `transcripts:read` (2.7.0, a pasta sincronizada do
  desktop). Sessão tem todas as permissões do usuário.
- **Rotas públicas** (sem credencial): `GET /health`, `GET /server` (descritor: nome, endereço,
  endereço MCP, impressão digital da CA raiz e versões), login e cadastro, login de admin,
  `POST /devices/login` e `POST /devices/pair`. As que conferem credencial (login, cadastro, login
  de admin e `/devices/*`) têm limite de tentativas por IP (os logins também por conta):
  estourado, **429** `rate_limited` com `Retry-After`. Código de pareamento inválido, vencido
  ou usado é **401** `invalid_pairing_code`.
- **Só sessão de usuário:** gestão de PATs, o código de pareamento, o aceite do aviso e as rotas de voz (tag `voice`:
  impressão e recusa de sugestão). Um PAT vazado não cria outro PAT e não lê nem apaga dado
  biométrico. PAT numa dessas rotas é **403** `session_required` desde a 1.4.0 (antes, 401): a
  credencial é válida, só não é a aceita ali. Sem credencial, ou sessão sem o CSRF, segue 401.
- **Falha de job** (`Job.error`): `code`, `message` e, desde a 1.4.0, `retryable` — falha
  passageira (worker perdido, job sumido ou parado, falta de VRAM), que retranscrever ou
  `POST /api/v1/admin/jobs/{job_id}/retry` tende a resolver.
- **Erros** em `application/problem+json` (RFC 9457) com o campo estável `code`; o cliente decide
  por `code`, nunca por `title`. 404 não distingue "não existe" de "não é visível".
- **Paginação** por cursor opaco: `?cursor=&limit=` (1–200), resposta `{items, next_cursor}`,
  `next_cursor: null` na última página. Listagem incremental por `?since=` compara
  `updated_at >= since` (inclusivo) e o cliente deduplica por `id` + `revision`. Desde a 2.7.0, um
  resumo que termina ou é editado também move o `updated_at` da gravação e da transcrição, então
  `?since=` percebe resumo novo ou refeito. Um cursor vale
  só para a ordenação (`sort`) que o gerou.
- **Filtros repetíveis.** Um filtro de listagem declarado como array (`?tag=a&tag=b`) combina os
  valores repetidos por OU, e filtros diferentes combinam por E: `?tag=a&tag=b&kind=note` é nota
  com a tag `a` ou `b`. Intervalo de tempo é `from` (inclusivo) e `to` (exclusivo) sobre
  `recorded_at`, como na busca.
- **Exportação** por `GET /recordings/{id}/export?format=`: `txt` (`text/plain`, cabeçalho e uma
  linha `[HH:MM:SS] Nome: texto` por segmento), `srt` (`application/x-subrip`, uma legenda por
  segmento), `md` (`text/markdown`, título, data e o resumo atual; sem resumo, 409
  `summary_missing`) e `docx` (Word, com o resumo e a transcrição). O nome do arquivo vem em
  `Content-Disposition`, em slug do título. `GET /transcripts/{id}/export?format=md` segue como o
  export da transcrição com frontmatter, que o lumea lê.
- **Concorrência otimista.** Uma escrita sobre um estado que o cliente leu leva a versão lida
  (`base_version` na edição do resumo); se o estado mudou, a resposta é 409 com um `code` próprio
  (`summary_changed`) e nada é sobrescrito.
- **Upload** resumível em partes (multipart S3 orquestrado pela API): `POST /uploads` com o
  `sha256` do arquivo → partes por `PUT` em URLs opacas que expiram → `POST /uploads/{id}/complete`.
  Mesmo hash de uma gravação do usuário responde 200 `deduplicated` sem transferir nada. Retomar é
  `GET /uploads/{id}` mais `POST /uploads/{id}/part-urls`. O navegador sobe o áudio já convertido
  ([formato-audio-upload.md](../code/formato-audio-upload.md)): `audio/ogg; codecs=opus` e o
  `sha256` em hex minúsculo que a biblioteca de conversão devolve.
- **Origem do áudio** (`source`): `desktop` e `mobile` são os apps que gravam, `upload` é o import
  pela web e `api` é o PAT. Sem `recorded_at_source`, um upload com `recorded_at` vindo de
  `desktop` ou `mobile` fica com `capture` (o relógio do app que gravou); de outra origem, `user`;
  sem `recorded_at`, `upload`.
- **Transcrição** no schema de `contracts/transcript.schema.json`: segmentos
  `{id, speaker_id, start_ms, end_ms, text}` (palavras só com `?include=words`), locutores
  `{id, label, person, suggestions}`, `content_hash` do áudio e `revision`, que sobe a cada edição.
  Sugestão por voz nunca é identidade até alguém confirmar: aceitar é o `PATCH` do locutor com
  `person_id`, recusar é o `DELETE` da sugestão
  ([identificacao-por-voz.md](../code/identificacao-por-voz.md)).

## Evolução: a v1 só cresce

- **Permitido:** rota nova; campo ou parâmetro de requisição novo e opcional; campo de resposta
  novo; valor de enum novo em resposta; `code` de erro novo; formato de export novo.
- **Proibido:** remover ou renomear; mudar tipo ou significado; tornar obrigatório o que era
  opcional; apertar validação de entrada existente; exigir escopo ou papel a mais numa rota
  existente; trocar o status de sucesso.
- **Clientes toleram o desconhecido:** ignoram propriedades novas e valores de enum novos em
  respostas. Por isso nenhum schema de resposta fecha `additionalProperties`.
- **Cada mudança** sobe `info.version` (e `schema_version` se tocar a transcrição), atualiza as
  fixtures, regenera o bundle e passa em `uv run pytest contracts/tests`, que a CI roda no job
  `contracts` junto com o smoke do mock.
- **Quebra** vira `/api/v2` num `openapi-v2.yaml` próprio; a v1 segue servida na transição,
  anunciando o fim com `Deprecation` e `Sunset`.
- **Exceção do redesign: a linha 2.x sob `/api/v1`.** O fim da organização (2.0.0, holetz/eclume#32)
  removeu grupos, compartilhamento, convites, consentimento de voz por pessoa e a auditoria de voz,
  e tirou `organization`, `groups`, `role`, `visibility` e `scope` das respostas. As specs seguintes
  do redesign (holetz/eclume#33 a #41) ainda quebram rotas que só o web do próprio repositório usa
  (a 2.1.0 tira os templates de resumo e o bloco de resumo das configurações; a 2.2.0 torna
anuláveis `agenda_type`, `provider` e `model` do `Summary`, que passa a ter versões editadas à
mão, e troca os filtros de `GET /recordings` por listas repetíveis, compatíveis com um valor só;
a 2.3.0 exige `recordings:delete` no `DELETE /recordings/{id}`, com a migração concedendo o escopo
a todo token que tinha `recordings:write`, e barra a sessão sem o aceite do aviso). Os dois clientes de
  fora do repositório (desktop e lumea) só usam uploads, gravações, transcrições e `/me`, que seguem
  compatíveis; manter a v1 antiga em paralelo exigiria duas RLS. Por isso a linha 2.x evolui no
  mesmo prefixo até o redesign terminar, e os contract tests exigem a 2.x. Depois dele a 2.x
  congela, e a **próxima** quebra vai para `/api/v2`, sem outra exceção.

## Por quê

O contrato existe antes do backend para que o servidor, o frontend, o desktop e o importador do
lumea desenvolvam em paralelo contra o mesmo mock. Isso só funciona se ninguém precisar acompanhar
mudanças do contrato: daí a regra aditiva e a tolerância obrigatória do cliente. O upload é
multipart S3 e não tus porque o MinIO já fala o protocolo, a API fica fora do caminho dos bytes e
o cliente Rust e o navegador só precisam de `PUT` HTTP.
