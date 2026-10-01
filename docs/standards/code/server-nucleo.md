---
type: standard
title: Núcleo do server — persistência, isolamento, autenticação, upload, pessoas e busca
description: Como o pacote eclume_server guarda e isola os dados (migrations SQL pelo migrador, conexão da aplicação como eclume_server sem superusuário, RLS por dono sob o papel eclume_app, tabelas da plataforma fora da RLS), autentica (sessão de usuário com CSRF e aceite do aviso, PAT pessoal ou de dispositivo com escopos, limite de tentativas, sessão de admin separada), recebe uploads (URL de parte assinada pela própria API, dedup e retomada por hash, natureza, origem da data e marcadores), serve a biblioteca (intervalo de tempo e filtros repetíveis), organiza (pessoas, coleções e edição da transcrição, tudo do dono), exclui em cascata, busca (full-text eclume_pt sob a RLS) e é testado (serviços reais, conformidade com o OpenAPI bundled).
resource: server/**, deploy/docker-compose.test.yml
tags: [code, server, postgres, rls, auth, upload, pessoas, busca, admin, testes]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#5, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#34, holetz/eclume#35, holetz/eclume#37, holetz/eclume#86, holetz/eclume#97, holetz/eclume#100, holetz/eclume#92
maintainer: holetz
---

# Núcleo do server — persistência, isolamento, autenticação, upload, pessoas e busca

O pacote `eclume_server` (`server/`) implementa o [contrato v1](../api/contrato-v1.md) com
FastAPI, SQLAlchemy 2 async (asyncpg), arq/Redis e boto3 contra o MinIO. As consultas são SQL
Core explícito: o isolamento mora nas políticas do banco, e o SQL que as exercita precisa ser
legível. O acordo com o worker GPU está em [jobs-transcricao.md](../api/jobs-transcricao.md); os
resumos e providers de agente, em [server-agentes.md](server-agentes.md); tipos de agenda, campos e
etapas do processamento, em [processamento-automatico.md](processamento-automatico.md); o painel
admin (conta de admin, configuração, segredos, usuários e saúde), em [server-admin.md](server-admin.md).

## Configuração

Tudo por ambiente (`eclume_server/config.py`):

| Variável | Padrão (dev) | Para quê |
|---|---|---|
| `ECLUME_DATABASE_URL` | `postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume` | papel de conexão: `eclume_server` em produção, o migrador (superusuário) só no `migrate`; no dev, o superusuário serve aos dois |
| `ECLUME_RUNTIME_DB_PASSWORD` | — | com valor, `eclume-server migrate` liga o `LOGIN` de `eclume_server` com essa senha |
| `ECLUME_JOB_GRACE_SECONDS`, `ECLUME_JOB_STALL_SECONDS` | `120`, `1800` | detecção de job morto ([jobs-transcricao.md](../api/jobs-transcricao.md#job-morto)) |
| `ECLUME_REDIS_URL` | `redis://127.0.0.1:6379/0` | filas arq e progresso |
| `ECLUME_S3_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`, `_BUCKET`, `_REGION` | MinIO do compose de dev | áudio e artefatos |
| `ECLUME_SECRET_KEY` | inseguro, de dev | assina as URLs de parte e de áudio |
| `ECLUME_PUBLIC_URL` | a da requisição | base absoluta das URLs devolvidas ao cliente |
| `ECLUME_COOKIE_SECURE` | `true` | `false` só em dev por HTTP puro |
| `ECLUME_SESSION_TTL_DAYS`, `ECLUME_ADMIN_SESSION_TTL_HOURS` | `14`, `12` | validade da sessão de usuário e da sessão de admin |
| `ECLUME_SIGNUP_OPEN` | `true` | cadastro aberto; `false` fecha o `POST /auth/signup` (403 `signup_closed`) sem deploy de código |
| `ECLUME_ENCRYPTION_KEY` | derivada de `ECLUME_SECRET_KEY` | cifra das chaves de API ([server-agentes.md](server-agentes.md)) |
| `ECLUME_CLAUDE_BIN` | `claude` | CLI do provider `claude-cli` |

## Persistência

- **Migrations em SQL versionado**, `eclume_server/db/migrations/NNN_nome.sql`, aplicadas em ordem
  por `eclume-server migrate` (tabela `schema_migrations`, `pg_advisory_lock`). Uma mudança de
  schema é um arquivo novo; um arquivo aplicado em algum ambiente não muda mais. Não há Alembic:
  RLS, papéis e `GRANT` são DDL que o autogenerate não expressa.
- `eclume_server/db/tables.py` descreve as tabelas em SQLAlchemy Core **só para tipar** as
  consultas (jsonb, arrays, uuid); nunca cria nada.
- Uma migration nova ganha o próximo número livre **na `main`**, não na branch: duas specs em
  paralelo não disputam o mesmo `NNN`. O runner aplica toda migration ainda não aplicada, então a
  ordem de chegada entre branches não importa.
- **Expandir ou contrair, nunca as duas.** Toda migration é uma das duas (holetz/eclume#92):
  *expandir* só acrescenta (tabela, coluna anulável ou com default, índice, função nova) e entra
  junto com o código que a usa; *contrair* (remover, renomear, apertar restrição) só entra num
  deploy **posterior** ao do código que deixou de depender do objeto. Assim o código do deploy
  anterior roda sobre o schema novo: o `migrate` com server e workers antigos de pé é seguro e o
  `deploy.sh --voltar` de um passo dispensa restaurar o banco. Não há `down`: além de um passo, o
  caminho é o dump pré-deploy (`restaurar-backup.sh --banco`).
- `eclume-server migrate --pendentes` lista as migrations que a árvore conhece e o banco não
  aplicou, uma por linha, sem aplicar nada (`migrate.pending`).

## Papéis do banco

Três papéis, cada um com um motivo:

| Papel | Atributos | Quem usa | Para quê |
|---|---|---|---|
| migrador (o superusuário `eclume` da imagem) | superusuário, dono de todo objeto | só o one-shot `migrate` (e `admin create`, o backup) | DDL, extensões, papéis, `GRANT` |
| `eclume_server` | `LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`, dono de nada, membro de `eclume_app` | server e worker CPU | `SELECT/INSERT/UPDATE/DELETE` em toda tabela, `USAGE` nas sequências, `EXECUTE` nas funções; só leitura em `schema_migrations` |
| `eclume_app` | `NOLOGIN NOBYPASSRLS` | toda transação de requisição, por `SET LOCAL ROLE` | as políticas de RLS |

- A migration `006_papel_de_conexao.sql` cria `eclume_server` (`NOLOGIN`, idempotente) com os
  `GRANT`s e `ALTER DEFAULT PRIVILEGES` do migrador, de modo que as migrations seguintes já nascem
  acessíveis. A senha não mora em SQL: `eclume-server migrate` com `ECLUME_RUNTIME_DB_PASSWORD`
  liga o `LOGIN` e fixa a senha (`ALTER ROLE ... PASSWORD` montado por `format(%L)`).
- O `BYPASSRLS` de `eclume_server` é deliberado: as operações de sistema (resolver credencial,
  ingestão, resumos, painel admin, expiração de upload, mídia assinada) atravessam contas por
  desenho. O que o papel perde é o poder de dono — DDL, `ALTER`, `DROP`, papéis — e o de
  superusuário. Tirar também o `BYPASSRLS` exigiria cada `system_tx` como função `SECURITY
  DEFINER`.
- `migrate` só cria `schema_migrations` quando falta (`to_regclass`): com o schema em dia, o
  `admin create` roda também sob `eclume_server`, que não tem `CREATE` no schema. Para os testes,
  `migrate(engine, until="NNN_nome")` para numa versão, e o teste da migration seguinte semeia o
  banco no formato da anterior.
- A suíte do server aplica as migrations como superusuário e roda inteira como `eclume_server`
  (`harness.provision`); um teste confere os atributos do papel, que ele não é dono de nada e que
  `CREATE TABLE` e escrita em `schema_migrations` são negados.

## Isolamento por RLS

- **Cada conta é dona do que é dela.** Toda tabela de conteúdo tem `owner_id` (FK para `users`,
  `ON DELETE CASCADE`): `recordings`, `uploads`, `collections`, `agenda_types`, `fields`,
  `field_values`, `pipeline_steps`, `people`, `transcription_jobs`, `transcripts`, `speakers`, `segments`, `speaker_embeddings`, `summaries`,
  `voice_samples` e `speaker_suggestions`. Nas derivadas, o `owner_id` é desnormalizado da
  gravação na escrita (a ingestão e a criação de job e resumo o copiam).
- **O único contexto é `app.user_id`** (`eclume_user()`). Toda política é uma igualdade
  `LEAKPROOF` sobre a própria linha: `<tabela>_own` com `USING` e `WITH CHECK`
  `owner_id = eclume_user()`; `users_self` com `id = eclume_user()`; `api_tokens_own` com
  `user_id = eclume_user()`; `pairing_codes_own` idem. Nenhuma política consulta outra tabela, então não há regra
  anti-recursão a manter. O que cada tabela permite fica nos `GRANT`s de `eclume_app`.
- **Toda transação de requisição de usuário** roda `SET LOCAL ROLE eclume_app` (papel `NOLOGIN`,
  sem `BYPASSRLS`) e fixa `app.user_id` com `set_config(..., true)` —
  `db.session.user_tx(engine, user_id)`. Sem contexto, `eclume_app` não enxerga nada.
- **Tabelas da plataforma ficam fora da RLS** e fora do alcance de escrita de `eclume_app`:
  `platform_settings` (uma linha; `eclume_app` só lê, para o liga-desliga da voz e o resumo),
  `platform_secrets`, `admins`, `admin_sessions` e `sessions` (sem `GRANT` nenhum), e
  `agent_providers` (sem RLS; `eclume_app` lê só as colunas sem segredo, com `GRANT SELECT` coluna
  a coluna, e a chave cifrada fica para o papel de conexão).
- **Operações de sistema** — lookup de credencial, painel admin, worker CPU — rodam com o papel de
  conexão (`system_tx`), que precisa de `BYPASSRLS` (`eclume_server`), porque o `FORCE` submete até
  o dono às políticas.
- A API responde **404** para o que não é do usuário: não há leitor que não seja o dono, então
  não há 403 de "vê mas não escreve".
- **Vínculo com pessoa só na mesma conta:** `people` tem `UNIQUE (id, owner_id)`, e as FKs de
  `speakers`, `voice_samples` e `speaker_suggestions` são por `(person_id, owner_id)`.
- **Operador não `LEAKPROOF` não chega ao índice sob a RLS.** O planner aplica antes as quals da
  política e só leva a um índice a qual do usuário que for `LEAKPROOF`: igualdade de `uuid` e
  `text` serve, `@@` (tsvector) e `@>`/`ANY` de array não. Quando o índice importa, uma função
  `SECURITY DEFINER` (com `SET search_path = public, pg_temp`) usa o índice restrita a
  `eclume_user()` e devolve **só chaves**; a consulta de `eclume_app` junta essas chaves à tabela, e
  a política continua decidindo o que o usuário vê. É o caso de `eclume_segment_matches`.
- **Efeito colateral no banco** que a própria linha não carrega (renomear uma pessoa sobe o
  `updated_at` das transcrições em que ela fala) mora num gatilho, nunca num `system_tx` dentro da
  rota.

## Autenticação

Duas contas distintas, com credenciais que não se cruzam: a **conta de usuário** (`users`), com
sessão e PAT, e a **conta de admin** (`admins`), com sessão própria. O mesmo e-mail pode existir
nas duas.

- **Senha** com argon2id nas duas contas. **Sessão de usuário:** token aleatório no cookie
  `eclume_session` (HttpOnly, Secure, SameSite=Lax, 14 dias) e `eclume_csrf` legível; o banco
  guarda o SHA-256 do token e o CSRF (`sessions`). Método mutável com sessão exige `X-CSRF-Token`
  igual ao CSRF da sessão.
- **PAT** `eclp_` + 40 caracteres base62, guardado como SHA-256 (segredo de alta entropia
  dispensa hash lento); `prefix` = os 9 primeiros caracteres. Um `Authorization: Bearer` presente
  nunca cai para o cookie.
- **Tipo do token** (`api_tokens.kind`, migration 015): `personal`, o PAT de `POST /tokens`
  (sempre desse tipo), ou `device`, a credencial de um aparelho (`platform` preenchida), que só
  nasce de `POST /devices/login` ou `POST /devices/pair`
  ([server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md)). Os dois autenticam igual, pelo
  mesmo `Bearer eclp_`; `GET /tokens?kind=` separa as listas e `DELETE /tokens/{id}` revoga
  qualquer um. O uso pelo servidor MCP grava `mcp_last_used_at` junto de `last_used_at`.
- **Escopos:** `ALL_SCOPES` em `auth.py`. A exclusão de gravação tem escopo próprio,
  `recordings:delete` (a 015 o concedeu a todo token que tinha `recordings:write`, que antes
  excluía).
- **Aceite do aviso na sessão:** a sessão de uma conta que não aceitou o aviso em vigor recebe
  **403** `notice_required` em toda rota, menos as marcadas `requires(before_notice=True)`
  (`GET /me`, `POST /me/notice`, logout); as rotas públicas de `/auth/*` não pedem credencial. O
  PAT não é barrado (ver [Cadastro e aviso](#cadastro-e-aviso)).
- **Limite de tentativas** (`ratelimit.py`): janela fixa de 1 minuto no Redis
  (`INCR` + `EXPIRE` em `eclume:rl:<rota>:<ip>`), 10 tentativas por IP em `/auth/login`,
  `/auth/signup`, `/admin/auth/login`, `/devices/login` e `/devices/pair`; os logins contam
  também por conta, e a troca de código tem um teto global (ver
  [server-mcp-e-dispositivos](server-mcp-e-dispositivos.md)). Estourado, **429**
  `rate_limited` com `Retry-After` (segundos até a janela reabrir). O IP é o do uvicorn com
  `--proxy-headers`, que confia no `X-Forwarded-For` do Caddy.
- **Sessão de admin:** `POST /admin/auth/login` abre `eclume_admin_session` (HttpOnly, Secure,
  SameSite=Strict, `Path=/api/v1/admin`, `ECLUME_ADMIN_SESSION_TTL_HOURS`) e `eclume_admin_csrf`
  legível (`Path=/`), guardados em `admin_sessions`. `auth.require_admin` é a dependência de toda
  rota de admin: aceita **só** esse cookie, e `Authorization` presente, cookie de usuário ou nada
  dão 401. Fora de `/admin/*`, o cookie de admin é ignorado (`auth.requires` nem o lê). O
  `Principal` do usuário não tem papel: nenhuma credencial de usuário tem poder de admin.
- **Status de erro, alinhados ao que cada operação declara:**
  - sem credencial, credencial inválida, CSRF ausente ou errado, ou credencial de usuário em
    `/admin/*` → **401** `unauthorized`: a sessão sem double-submit está incompleta, e o web
    responde a 401 com um login novo, que recupera o cookie;
  - PAT numa rota só de sessão (PATs, código de pareamento, voz, logout) → **403**
    `session_required` (contrato 1.4.0): a credencial é válida, só não é a aceita ali;
  - sessão de conta sem o aceite do aviso em vigor → **403** `notice_required` (2.3.0);
  - escopo faltando → **403** `insufficient_scope` com `required_scopes`;
  - requisição fora do contrato (parâmetro, corpo ou regra de negócio) → **422**
    `validation_failed` com `errors[]`, em qualquer operação, como o mock;
- Desativar um usuário (`PATCH /admin/users/{id}`) apaga as sessões e revoga os PATs dele.

## Cadastro e aviso

- **Cadastro aberto**, sem convite e sem confirmação de e-mail: `POST /auth/signup` (público) com
  nome, e-mail, senha (12+) e `notice_version`. A conta nasce com o aceite do aviso em vigor
  ("Sou responsável por pedir o consentimento das pessoas que gravo"), os tipos de agenda padrão
  marcados para contas novas e os campos embutidos, título e tags (`accounts.create_user`, que
  chama `eclume_seed_user_defaults`), e a sessão aberta,
  com os cookies do login. `GET /auth/signup` diz se o cadastro está aberto e devolve o aviso.
- **Erros:** cadastro fechado (`ECLUME_SIGNUP_OPEN=false`) → 403 `signup_closed`; e-mail já
  cadastrado (sem distinção de caixa, inclusive na corrida, pelo índice único) → 409 `email_taken`;
  aviso ausente ou fora da versão em vigor, senha curta, e-mail ou nome inválidos → 422.
- **O aviso tem versão** (`accounts.NOTICE_VERSION`, `NOTICE_TEXT`). `users.notice_version` e
  `notice_accepted_at` são os dois nulos (conta migrada, ainda sem aceite) ou os dois preenchidos
  (`CHECK`). `GET /me` devolve `notice_required` quando a conta não aceitou a versão em vigor, e
  `POST /me/notice` (só sessão) registra o aceite. Um texto novo do aviso é uma versão nova: as
  contas voltam a ver `notice_required`.
- **O aceite pendente barra só a sessão** (2.3.0): o web não passa de `/me` e do aceite enquanto
  ele falta, e o server garante isso também para quem chama a API com o cookie. O PAT não é
  barrado: o desktop e o lumea usam PAT de contas migradas, e quem pede o aceite é o web.
- As fábricas dos testes (`make_user()`) criam a conta **com** o aceite;
  `make_user(notice_version=None)` é a conta migrada, sem ele.

## A conta pelo próprio usuário

Só pela sessão (o PAT não serve) e com o limite de tentativas das credenciais (`attempts`):

- **Trocar a senha:** `POST /me/password` com `current_password` e `new_password`
  (`accounts.change_password`). Senha atual errada → 422 em `current_password`; nova com menos de
  12 caracteres → 422 em `new_password`. Grava o hash novo e apaga as outras sessões da conta; a
  corrente continua. Os PATs continuam valendo.
- **Excluir a conta:** `POST /me/delete` com `password` (`accounts.delete_user`). Senha errada →
  422 em `password`, e nada muda. Apaga o usuário, e as FKs levam em cascata tudo o que é dele;
  depois do commit, a rota apaga os objetos de cada gravação no armazenamento
  (`storage.delete_recording`) e responde 204 com os cookies da sessão apagados, como o logout.

## Upload e áudio

- **A URL de parte é o `PUT /api/v1/uploads/{id}/parts/{n}` da própria API**, assinada como um
  pré-assinado do S3 (`?expires=&sig=`, HMAC-SHA256 de `ECLUME_SECRET_KEY`, 1 h, nunca além do
  upload). A URL se autoriza sozinha: o navegador não ecoa CSRF e o desktop não manda credencial.
  A API grava a parte no MinIO (`UploadPart`). Escolhida contra Caddy → MinIO com `Host`
  preservado por manter um só origin, sem CORS e sem expor o MinIO; o volume real (Opus a
  ~15 MB/h) cabe na API. A URL é opaca para o cliente: trocar por pré-assinada depois não quebra
  ninguém.
- Partes de `ECLUME_UPLOAD_PART_SIZE` (8 MiB; última menor), no máximo 10 000; tamanho errado →
  409. `parts_received` vem do `ListParts`. As primeiras 100 URLs vêm na criação; o resto por
  `part-urls`. Upload vale 7 dias; o worker CPU aborta os vencidos a cada 30 min. O MinIO de todo
  compose guarda o multipart incompleto por `MINIO_API_STALE_UPLOADS_EXPIRY=192h` (8 dias, acima
  dos 7), para a retomada valer até o fim.
- **Multipart sumido nunca é 500.** O `Storage` traduz `NoSuchUpload` em `MultipartGoneError`:
  `GET /uploads/{id}` marca o upload `expired` e responde com ele; a retomada por hash marca o
  antigo `expired` e abre outro; o `PUT` da parte e o `complete` marcam `expired` e respondem 409
  `upload_expired`. No `complete`, multipart sumido com o objeto presente (`head_object`) é o
  `complete` anterior cujo commit falhou: segue para o hash e a gravação sem remontar. O desktop e
  o celular (`eclume-sync`) recomeçam o upload uma vez ao receber esse 409.
- **Dedup e retomada por hash:** mesmo `sha256` de uma gravação do usuário → 200 `deduplicated`;
  de um upload `in_progress` dele → o mesmo upload, com URLs das partes que faltam.
- **`complete`** fecha o multipart, relê o objeto em streaming para conferir o SHA-256 e cria
  gravação e job. Hash divergente → gravação `failed` com `job.error.code = hash_mismatch`, e a
  gravação guarda o hash **real**, deixando o declarado livre para um novo upload. `complete`
  repetido devolve a mesma gravação.
- **Chaves:** áudio em `users/{dono}/recordings/{gravação}/audio`; artefatos do worker em
  `recordings/{gravação}/…`, como o contrato de jobs fixa. `recordings.audio_key` guarda a chave
  inteira e é sempre a fonte. As gravações de antes da conta por usuário estavam em
  `orgs/{org}/users/{dono}/…`; `eclume-server storage relocate-legacy [--dry-run]` as move uma
  vez (idempotente): copia para a chave nova (pula a cópia se o destino já tem o mesmo tamanho),
  troca `audio_key` e põe a antiga na fila de exclusão na mesma transação, pulando a gravação com
  job `queued`/`running` (o `transcribe` na fila carrega a chave antiga).
- **Campos obsoletos** `owner`/`created_by` (contrato 2.11.0): sem join com `users`; o nome é o do
  usuário da transação (`serialize.requester_name`), o único que a RLS deixa ver.
- `GET /recordings/{id}/audio` redireciona (302) para `/media/recordings/{id}/audio?expires=&sig=`,
  servido pela API com `Range` a partir do MinIO — fora de `/api/v1`, opaco para o cliente.

## Gravação: data, natureza e marcadores

- **`recorded_at` é o início da gravação**, e o fim do evento no calendário é
  `recorded_at + duration_ms`. Não há `started_at`: o desktop já mandava o início da captura em
  `recorded_at`, obrigatório em `Recording`, `Transcript` e `SearchHit`, e renomear quebraria três
  clientes sem ganho.
- **`recorded_at_source`** diz de onde veio a data: `capture` (relógio do app que gravou),
  `file_metadata` (lida do arquivo no navegador, antes da conversão para Opus, e confirmada na
  importação), `user` (digitada ou corrigida) ou `upload` (sem data; vale a hora do envio). Sem ela
  no upload, o servidor decide: com `recorded_at` e `source: desktop`, `capture`; com `recorded_at`
  e outra origem, `user`; sem `recorded_at`, `upload` (outra origem sem data → 422). Corrigir
  `recorded_at` no `PATCH` passa a origem a `user`. A migration 014 marcou `capture` nas
  gravações do desktop e `upload` no resto: o import web de antes não mandava data.
- **`kind`**: `meeting` (padrão) ou `note` (nota de voz), no upload e no `PATCH`. A nota passa
  pelo mesmo pipeline da reunião (detecção de tipo e resumo incluídos); a
  [processamento-automatico.md](processamento-automatico.md) não distingue as duas.
- **Tipo escolhido no upload** (`agenda_type_id`, a folha "Agenda type" ao parar a gravação no
  celular): vira o tipo do usuário, origem `edited`, com o padrão de título e as tags padrão
  aplicados já no `complete`; a detecção o respeita (`set_by_user`). Tipo inexistente → 422.
- **Marcadores** (`markers`): um instante `at_ms` com nota opcional (até 500 caracteres) e o
  `device_name` de quem marcou, ligados à gravação por FK composta com o dono. Idempotentes por
  `UNIQUE (recording_id, client_id)`: o `client_id` é gerado pelo app, e reenviar o mesmo marcador
  só atualiza a nota (`ON CONFLICT DO UPDATE`; no mesmo lote, o último vale); um reenvio sem nota
  mantém a que já existe, editada na web. Chegam de dois
  jeitos: no `UploadCreate.markers` (até 1 000, gravados no `complete` com o `device_name` da
  captura e, num upload deduplicado — na criação ou no `complete` —, mesclados na gravação
  existente, porque o app pode ter caído depois de subir o áudio), ou depois em
  `POST /recordings/{id}/markers` (lote, `device_name` do corpo). `PATCH /markers/{id}` troca a
  nota e `DELETE` exclui; `GET` lista em ordem de `at_ms` numa página só. `at_ms` além da duração
  é aceito: a duração só se conhece depois da transcrição. `Recording.marker_count` é uma
  subconsulta lateral de `recording_select`. Escopos `recordings:read`/`recordings:write`.

## Biblioteca

- `GET /recordings` é a biblioteca da semana, do mês e da lista: `from` (inclusivo) e `to`
  (exclusivo) sobre `recorded_at`, com o índice `recordings_owner_recorded_idx (owner_id,
  recorded_at, id)`, e `sort` `created_desc` (padrão), `recorded_asc` ou `recorded_desc`. O cursor
  é a posição `(chave do sort, id)`: vale só para o `sort` que o gerou. A semana e o mês pedem
  `limit=200` e seguem o cursor.
- **Filtros repetíveis:** OU entre os valores do mesmo filtro, E entre filtros diferentes.
  `kind`, `status` (`processing` é o `queued` com o worker reportando progresso, refinado depois
  da consulta), `tag` (`tags && :tags`), `collection` (`collection_ids && :ids`), `person`
  (`EXISTS` num locutor da transcrição ligado a uma das pessoas) e `field=<field_id>:<valor>`. No
  `field`, cada campo é um filtro: valores do mesmo campo por OU, campos diferentes por E; texto
  e escolha comparam o valor, lista aceita um dos itens (`value @> [valor]`), e título e tags, que
  são embutidos, comparam `recordings.title` e `recordings.tags`. Um campo que a conta não tem não
  encontra nada; `field` sem `:` → 422.

## Exclusão

- `DELETE /recordings/{id}` apaga a linha da gravação e deixa o resto às FKs em cascata:
  transcrição, segmentos, locutores, embeddings, amostras de voz, versões do resumo, chat de
  ajuste, marcadores, valores de campo e etapas do pipeline. Um job ainda na fila (`summarize`,
  `summary_chat`, as etapas por agente, `ingest_transcript`) encontra a linha apagada e termina
  sem efeito.
- **Fila de exclusão no bucket** (`storage_deletions`, migration 024, sem RLS e sem GRANT para
  `eclume_app`). Gatilhos `AFTER DELETE` `SECURITY DEFINER` enfileiram, na mesma transação do
  `DELETE` (e da cascata): de `recordings`, o `audio_key` e o prefixo `recordings/{id}/`; de
  `uploads` `in_progress`, o abort do multipart. Assim a rota, a ferramenta do MCP e a exclusão
  da conta cobrem tudo sem tocar o S3 depois do commit. A ingestão enfileira o
  `speaker_embeddings.json` da revisão na transação dela (biometria só no banco).
- **Dreno** (`drain_storage_deletions`, cron de minuto, `unique`, worker de `eclume:default`): até
  100 linhas vencidas com `FOR UPDATE SKIP LOCKED`; apaga a chave, lista e apaga o prefixo, aborta
  o multipart (`NoSuchUpload` = feito) e tira a linha. Falha soma `attempts`, guarda `last_error`
  e adia (1 min dobrando até 1 h). Nunca desiste: a linha parada é o sinal para a observabilidade.
- **Reconciliação** (`reconcile_storage`, domingo 04:00, `unique`): enfileira todo objeto de
  `users/`, `orgs/` e `recordings/` com mais de 24 h cuja chave não é `audio_key` de gravação
  nenhuma (ou cujo `recordings/{id}/` não tem gravação), e todo multipart com mais de 24 h sem
  upload `in_progress` com aquele `s3_upload_id`. A margem cobre o `complete` ainda sem commit.
- **Retenção mínima** (`purge_expired`, diário): sessões de usuário e de admin vencidas há mais de
  1 dia e uploads terminais (`completed`, `deduplicated`, `aborted`, `expired`) com mais de 30
  dias. Um app que retome depois disso recebe 404, abre outro upload e cai no dedup por hash.
  `api_tokens` ficam: o usuário vê os revogados.

## Pessoas, coleções e edição da transcrição

- **Pessoas são do usuário** (`people`, política de dono), com `people:read`/`people:write` no
  PAT. E-mail único entre as pessoas do usuário (`(owner_id, lower(email))`): 409 na criação, 422
  em `email` no `PATCH` (que não declara 409). `sort_name = lower(eclume_unaccent(name))` ordena o
  diretório e atende `q` por prefixo do nome, de qualquer palavra do nome ou do e-mail; cursor
  `(sort_name, id)`. `eclume_unaccent` é o `unaccent` com dicionário fixo, `IMMUTABLE`, para caber
  em coluna gerada.
- **Locutor ↔ pessoa** por FK composta `speakers (person_id, owner_id) → people (id, owner_id)` com
  `ON DELETE SET NULL (person_id)`: vínculo com pessoa de outra conta é impossível no banco, e
  excluir a pessoa só desliga os locutores (o `label` fica). `transcript_count` e `last_seen_at`
  contam as transcrições do usuário. Renomear ou excluir a pessoa sobe o `updated_at` (não a
  `revision`) de toda transcrição em que ela fala, pelo gatilho `eclume_touch_person_transcripts`.
- **Voz:** a pessoa não guarda consentimento; o aceite do aviso no cadastro o substitui. Amostras,
  comparação, sugestões e o esquecimento da voz estão em
  [identificacao-por-voz.md](identificacao-por-voz.md).
- **Edição da transcrição** — `PATCH` de locutor (`label`, `person_id`), `POST .../speakers/merge`
  e `PATCH` de segmento — com `transcripts:write`. Toda edição sobe `revision` e `updated_at`.
  Ligar sem `label` usa o nome da pessoa; pessoa inexistente ou de outra conta → 422 em
  `person_id`. A mesclagem apaga os locutores de origem e as impressões de voz deles e recalcula
  `talk_ms`; corrigir o texto descarta `words` e reindexa o `tsv` (coluna gerada).
- **Coleções são do usuário** (`collections`, política de dono). `recordings.collection_ids`
  segue array: a API só aceita ids de coleções do próprio usuário (422 em `collection_ids`, no
  `PATCH /recordings` e no `POST /uploads`, que as aplica no `complete`), deduplica, e excluir a
  coleção a tira das gravações (`array_remove`) subindo o `updated_at` delas. `recording_count`
  conta as gravações do usuário. `GET /tags` agrega `unnest(tags)` das gravações do usuário.

## Busca full-text

- Config `eclume_pt`: cópia de `portuguese` com `unaccent` antes do `portuguese_stem`, então
  "liderancas" acha "lideranças". `segments.tsv` é coluna gerada `to_tsvector('eclume_pt', text)`
  com índice GIN.
- `GET /search` roda sob a RLS. Com `q`: `websearch_to_tsquery('eclume_pt', q)` (frase entre aspas,
  `-exclusão`), junção com `eclume_segment_matches(tsquery)` para usar o GIN, ordem `ts_rank_cd`
  desc, depois `recorded_at` desc e a posição da fala. Só com `person`: as falas da pessoa em ordem
  cronológica, `rank` 0. Sem `q` nem `person` → 422. Filtros `person`, `from`/`to` (`recorded_at`),
  `tag`, `collection` e `field` combinam com qualquer um dos modos.
- `field=<field_id>:<valor>` (repetível) tem a semântica da biblioteca: OU no mesmo campo, E entre
  campos, lista por item, título e tags como os embutidos. O predicado é um só,
  `fields.field_filters`, sobre `recordings`, usado por `GET /recordings` e por `GET /search`; o
  campo é lido sob a RLS, então o `field_id` de outra conta não encontra nada.
- `highlight` = `ts_headline` com `HighlightAll` e marcadores sentinela (`\x02`/`\x03`, tirados
  antes do texto); o Python escapa o texto e só então troca os marcadores por `<mark>`/`</mark>`.
  Nenhum outro HTML chega ao cliente.
- Cursor = deslocamento opaco (`encode_position`): o ranking em `real` não dá keyset estável.
- Medida (240 mil segmentos, pg16 do host): termo raro 14 ms pela função contra 956 ms do `@@`
  direto sob a RLS; termo comum (24 mil trechos) 217 ms contra 457 ms.

## Testes

- Postgres, Redis e MinIO reais, de `deploy/docker-compose.test.yml` (projeto `eclume-test`,
  portas `127.0.0.1:55532/56479/59100`, dados em `tmpfs`). Cada sessão de teste cria um banco
  migrado, um bucket e limpa um banco do Redis. Sem os serviços, os testes do server **pulam**;
  com `ECLUME_TEST_REQUIRE_SERVICES=1` (a CI), a ausência **falha**.
- **Conformidade:** um hook de resposta no `TestClient` valida toda resposta de `/api/v1` contra
  `contracts/openapi-v1.bundled.yaml` com os objetos fechados (`strictify`): status declarado,
  headers obrigatórios e corpo. Um teste confere que as rotas implementadas são exatamente as operações do contrato.
- **Isolamento** é provado pela API e por SQL direto sob `eclume_app` entre duas contas, em toda
  tabela de conteúdo (`test_isolation.py`); a busca tem o próprio: nunca devolve segmento de outra
  conta, nem pela função do GIN (`test_search.py`).
- **A plataforma é uma só no banco da sessão de testes.** O teste que muda configuração,
  segredos ou providers usa a fixture `platform` (a `admin` já a usa), que devolve a plataforma
  aos padrões da migration antes e depois. `make_user()` cria a conta com os tipos de agenda e os campos semeados;
  `admin` abre a sessão de uma conta de admin nova.
- **A migration que transforma dados** tem teste sobre o formato anterior: `test_migration_008.py`
  aplica até a 007, semeia o banco como a 007 o guardava e confere o que a 008 preserva e remove.
- `eclume_server_testing.fakes.transcribed(api, settings, **campos)` sobe um áudio e roda os dois
  workers: devolve a gravação já com a transcrição de 3 locutores da fixture do contrato.
- Rodando em paralelo com outra suíte no mesmo host, suba o compose com projeto e portas próprios
  (`ECLUME_TEST_PG_PORT`, `ECLUME_TEST_REDIS_PORT`, `ECLUME_TEST_MINIO_PORT`) e aponte
  `ECLUME_TEST_DATABASE_URL`, `ECLUME_TEST_REDIS_URL` e `ECLUME_TEST_S3_ENDPOINT` para elas.
- O ciclo de transcrição roda com o worker GPU fake (`eclume_server_testing/fakes.py`) e o worker
  CPU real. Um `arq.Worker` guarda o loop corrente ao nascer: crie-o dentro do loop que o roda.

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email admin@exemplo.com.br --name "Admin" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
uv run arq eclume_server.worker.AgentWorkerSettings
```
