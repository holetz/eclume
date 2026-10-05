---
type: standard
title: Contrato de API v1
description: As convenções da API v1 do eclume — conta por usuário, sessão de usuário e PAT com escopos, sessão de admin própria para /admin/*, credencial de dispositivo e descritor público, o /mcp fora do /api/v1, erros RFC 9457, paginação por cursor, upload multipart S3 com dedup por hash, transcrição em JSON Schema — e a regra de que a v1 só evolui de forma aditiva, com a linha 2.x do redesign como exceção única.
resource: contracts/**, deploy/docker-compose.mock.yml, server/**
tags: [api, contrato, openapi, pat, upload, evolucao]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#3, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#35, holetz/eclume#41, holetz/eclume#100, holetz/eclume#93, holetz/eclume#99, holetz/eclume#98, holetz/eclume#117, holetz/eclume#118, holetz/eclume#119, holetz/eclume#116, holetz/eclume#121, holetz/eclume#142
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
  saúde); nenhuma rota de admin devolve conteúdo de usuário. Desde a 2.15.0, `AdminUser` traz o
  uso da conta (`usage`) e a sobreposição das cotas (`quotas`, só os campos sobrepostos ou `null`),
  `PATCH /admin/users/{id}` aceita `quotas` (troca a sobreposição inteira; `null` volta ao padrão)
  com `active` opcional, e `DELETE /admin/users/{id}` (204; inexistente, 404) exclui a conta como
  o `POST /me/delete`, sem a senha, e libera o e-mail. Desde a 2.18.0,
  `POST /admin/users/{id}/password-reset` (201 `PasswordResetLink`; conta desativada, **409**
  `conflict`) gera o link de redefinição de senha da conta; o admin nunca vê nem define a senha.
- **Escopos do PAT:** `recordings:read`, `recordings:write`, `recordings:delete` (2.3.0, a
  exclusão de gravação), `transcripts:read`,
  `transcripts:write`, `people:read`, `people:write`, `summaries:read`, `summaries:write`. Nenhum
  implica outro; a operação lista no requisito `pat: [...]` todos os que exige. Quando basta um de
  vários, a operação declara um requisito `pat` por escopo e a rota usa `requires_any` (desde a
  2.4.0, `GET /agenda-types` aceita `summaries:read` ou `recordings:read`, para a credencial de
  dispositivo escolher o tipo ao parar). A credencial de dispositivo tem `recordings:read`,
  `recordings:write`, `summaries:read` (2.6.0) e `transcripts:read` (2.8.0, a pasta sincronizada do
  desktop). Sessão tem todas as permissões do usuário.
- **Agente (2.21.0, `agent`):** `GET`/`POST /agent/sessions` (as conversas, por cursor, da
  última atividade para trás; criar, com título opcional), `GET`/`PATCH`/`DELETE
  /agent/sessions/{session_id}` (a conversa com as mensagens e os anexos não enviados; renomear;
  excluir), `POST /agent/sessions/{session_id}/files` (multipart, 201; .txt, .md, .csv, .pdf e .docx
  até 10 MB, 415 `unsupported_media_type` fora disso, 409 `too_many_files` acima de 20 por
  conversa), `DELETE .../files/{file_id}` (só anexo não enviado; o enviado é 409), `POST
  .../messages` (202 com `question` e `answer`; 409 com outra resposta em aberto na conversa, 429
  com duas na conta, cota de 24 h do agente), `GET .../messages/{message_id}` (consulta até `done`
  ou `failed`, com `agent_expired` depois de 15 minutos em aberto) e `GET
  /agent/files/{file_id}/content` (o arquivo como anexo). Todas com `summaries:read`, como o chat
  sobre a base; o escopo `transcripts:read` vale para as ferramentas. Outra conta é 404. Aditivo:
  `/base-chat` segue igual e passa a `deprecated`.
- **Chat sobre a base (2.7.0, `base-chat`):** `POST /base-chat` (202, com a pergunta e até 10
  mensagens de histórico, que o cliente guarda) e `GET /base-chat/{chat_id}` (consulta até `done`
  ou `failed`), ambos com `summaries:read`. O estado vive 1 h no Redis; a de outra conta é 404; a
  conta tem até 2 perguntas em aberto (429 `rate_limited`). A resposta traz `sources`, só as
  gravações que o agente consultou. É aditivo: nenhuma rota existente mudou. Desde a 2.14.0, o
  escopo vale para as **ferramentas** do agente, não para a rota: um PAT sem `transcripts:read`
  pergunta normalmente, mas o agente só busca e lê resumos (sem `search_transcripts` nem
  `read_transcript`); sessão e credencial de aparelho leem as duas fontes. Exigir
  `transcripts:read` na rota seria escopo a mais numa rota existente.
- **Rotas públicas** (sem credencial): `GET /health` (estático, sinal de vida), `GET /health/ready`
  (prontidão desde a 2.13.0: 200 ou 503 com só o nome e `ok`/`down` de Postgres, Redis e
  armazenamento), `GET /server` (descritor: nome, endereço,
  endereço MCP, impressão digital da CA raiz e versões), `GET /privacy` (desde a 2.19.0: para
  onde vai cada dado, `PrivacyInfo` com um `DataDestination` por finalidade — transcrição e as de
  agente — em `server`, `local_network`, `external` ou `disabled`, e quem processa só quando sai;
  nunca endereço, modelo, chave nem nome do provider; separada de `/server` porque muda em
  runtime e o cadastro precisa dela antes do aceite), login e cadastro, login de admin,
  `POST /devices/login` e `POST /devices/pair`. As que conferem credencial (login, cadastro, login
  de admin, `/devices/*` e, desde a 2.18.0, as duas rotas da redefinição de senha, que somam a
  mesma chave) têm limite de tentativas por IP e rota: estourado, **429**
  `rate_limited` com `Retry-After`. Desde a 2.14.0, os logins por senha (navegador, aparelho e
  admin, este com contadores próprios) contam também as **falhas** da conta: por par (conta, IP),
  10 em 15 min, e um teto da conta, 100 em 1 h, que não barra IP que entrou nela com sucesso nos
  últimos 30 dias; o sucesso zera o par. Assim as tentativas de um IP qualquer não trancam a dona
  da conta. Código de pareamento inválido, vencido ou usado é **401** `invalid_pairing_code`.
- **Troca de senha** (`POST /me/password`): desde a 2.14.0, `revoke_tokens` opcional; `true`
  revoga, além das outras sessões, as credenciais de aparelho e os PATs da conta. Ausente vale
  `false`, o comportamento anterior (os tokens continuam). O web manda `true` por padrão.
- **Redefinição de senha por link** (desde a 2.18.0): o link `<url pública>/redefinir-senha#<segredo>`
  leva o segredo no fragmento, que a página manda no corpo de `POST /auth/password-reset/check`
  (200 `PasswordResetInfo`, o e-mail e a validade, sem consumir) e de `POST /auth/password-reset`
  (204; troca a senha, consome o link e encerra todas as sessões da conta, sem abrir outra;
  aparelhos e PATs seguem valendo). Ambas são públicas (`security: []`). Link inexistente,
  vencido, usado ou de conta desativada é sempre **401** `invalid_reset_link`, a mesma resposta
  para não servir de oráculo; senha curta é **422** `validation_failed` sem consumir o link.
- **Só sessão de usuário:** gestão de PATs, o código de pareamento, o aceite do aviso e as rotas de voz (tag `voice`:
  impressão, recusa de sugestão e a atribuição automática `/me/voice-assignment`, desde a 2.9.0;
  desde a 2.19.0 ela traz `keep_samples`, `sample_count` e `voiceprint_people`, e
  `keep_samples: false` no `PATCH` apaga na hora as amostras, os vetores e as sugestões pendentes
  da conta). Um PAT vazado não cria outro PAT e não lê nem apaga dado
  biométrico. PAT numa dessas rotas é **403** `session_required` desde a 1.4.0 (antes, 401): a
  credencial é válida, só não é a aceita ali. Sem credencial, ou sessão sem o CSRF, segue 401.
- **Idioma da transcrição** (desde a 2.20.0): `GET /me/transcription` (sessão ou PAT com
  `recordings:read`) devolve o idioma preferido da conta (`null` é o padrão do servidor) e
  `platform_default`; o `PATCH` só com sessão. `language` no upload, no `PATCH` da gravação e no
  retranscrever aceita `auto` (afrouxamento de entrada, aditivo); a ordem de resolução está em
  [jobs-transcricao.md](jobs-transcricao.md).
- **Falha de job** (`Job.error`): `code`, `message` e, desde a 1.4.0, `retryable` — falha
  passageira (worker perdido, job sumido ou parado, falta de VRAM), que retranscrever ou
  `POST /api/v1/admin/jobs/{job_id}/retry` tende a resolver.
- **Erros** em `application/problem+json` (RFC 9457) com o campo estável `code`; o cliente decide
  por `code`, nunca por `title`. 404 não distingue "não existe" de "não é visível". Desde a
  2.14.0, qualquer operação pode responder **500** `internal_error` (o detalhe e o traceback ficam
  só no log, com o `X-Request-ID`).
- **Cotas por conta** (2.15.0): armazenamento total, tamanho por arquivo, uploads abertos, minutos
  de áudio e pedidos ao agente em 24 h (janela móvel); a cota efetiva é a sobreposição da conta
  sobre o padrão da plataforma, `null` é sem limite. `GET /me/usage` (qualquer credencial, sem
  escopo) devolve `{usage, quotas}`. Estourada, **403** `quota_exceeded` com `quota`, `limit` e
  `used` — no `POST /uploads` novo (armazenamento, tamanho, abertos; deduplicar e retomar não
  contam) e nos pedidos ao agente (gerar resumo, chat do resumo, chat da base, pré-visualizações).
  Os minutos de áudio nunca recusam: a gravação espera na fila até a janela abrir. A conta tem no
  máximo 3 resumos na fila ou rodando; além disso, **429** `rate_limited`.
- **Espera na fila** (2.16.0): enquanto o job está `queued`, `Job.queue` (`JobQueue`) diz por que
  a gravação espera — `reason` em `processor_queue` (já na fila do processador, com `ahead`, os
  jobs que começam antes, contando o que roda), `account_turn` (retida pela fila justa, com
  `account_ahead`, as gravações da própria conta antes) ou `quota_window` (minutos de 24 h
  esgotados, com `resumes_at`) — e `processor` (`online`, `offline_since`). `estimated_start_at` é
  previsão pela duração real das últimas transcrições, `null` sem histórico ou com o processador
  fora do ar, e todo cliente a rotula como estimativa. Fora de `queued`, `queue` é `null`. Só
  contagens e horários: nada de outra conta. `reason` é enum aberto.
- **Teto do corpo** (2.14.0): **413** `payload_too_large` em qualquer operação com corpo, com
  `limit` (bytes), recusado pelo `Content-Length` antes de ler ou contado enquanto chega quando o
  cabeçalho falta. Tetos: 64 KiB nas rotas públicas de credencial (`/auth/*`, `/admin/auth/*`,
  `/devices/*`), os bytes da parte no `PUT` de parte e 1 MiB no resto da API e no `/mcp`. O Caddy
  de borda recusa acima de 9 MiB (sem problem+json, porque só dispara acima do maior teto do app).
- **Paginação** por cursor opaco: `?cursor=&limit=` (1–200), resposta `{items, next_cursor}`,
  `next_cursor: null` na última página. Listagem incremental por `?since=` compara
  `updated_at >= since` (inclusivo) e o cliente deduplica por `id` + `revision`. Desde a 2.8.0, um
  resumo que termina ou é editado também move o `updated_at` da gravação e da transcrição, então
  `?since=` percebe resumo novo ou refeito. Desde a 2.17.0, a etapa `summary` que termina `failed`
  ou `skipped` move o `updated_at` **só da gravação** (o da transcrição só se move com resumo novo,
  para não acordar o importador do lumea), e o `?since=` de `GET /recordings` é a leitura do aviso
  do fim do processamento no desktop e no web (holetz/eclume#118). Um cursor vale
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
  `GET /uploads/{id}` mais `POST /uploads/{id}/part-urls`. Desde a 2.14.0, um `complete` com outro
  do mesmo upload em andamento responde **409** `upload_completing` com `Retry-After`: é
  passageiro, o cliente tenta de novo (o desktop no próximo ciclo; o web, ao reenviar, cai na
  deduplicação por hash). O navegador sobe o áudio já convertido
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
- **Campo obsoleto dentro da v1 é anotação, não remoção.** A propriedade ganha `deprecated: true`
  (OpenAPI 3.1 e JSON Schema 2020-12) e uma descrição que diz o que ela vale hoje e onde sai; segue
  em `required` e preenchida, e o minor sobe como em toda mudança. `contracts/tests` fixa a lista
  (`DEPRECATED_V1`) e falha se um obsoleto sair de `required` ou perder a marca. Os clientes não
  leem campo obsoleto em código novo (o `schema.gen.ts` do web os marca `@deprecated`).
- **O que a `/api/v2` remove** (obsoletos desde a 2.11.0 e o schema 1.2 da transcrição,
  holetz/eclume#100): `Recording.owner`, `TranscriptSummary.owner`, `Transcript.owner`,
  `VoiceSample.created_by`, `Summary.created_by` e `SummaryChatMessage.created_by` — resquícios do
  modelo com organização; com cada conta isolada, valem sempre o próprio usuário.
  Também sai o chat sobre a base (`/base-chat`, obsoleto desde a 2.21.0), que o Agente substitui.
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
