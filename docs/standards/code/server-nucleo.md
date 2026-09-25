---
type: standard
title: Núcleo do server — persistência, isolamento, autenticação, upload, pessoas e busca
description: Como o pacote eclume_server guarda e isola os dados (migrations SQL, RLS por organização e dono sob o papel eclume_app), autentica (sessão com CSRF, PAT com escopos), recebe uploads (URL de parte assinada pela própria API, dedup e retomada por hash), organiza (pessoas da organização, coleções do usuário, edição da transcrição pelo dono), busca (full-text eclume_pt sob a RLS) e é testado (serviços reais, conformidade com o OpenAPI bundled).
resource: server/**, deploy/docker-compose.test.yml
tags: [code, server, postgres, rls, auth, upload, pessoas, busca, testes]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#5
maintainer: holetz
---

# Núcleo do server — persistência, isolamento, autenticação, upload, pessoas e busca

O pacote `eclume_server` (`server/`) implementa o [contrato v1](../api/contrato-v1.md) com
FastAPI, SQLAlchemy 2 async (asyncpg), arq/Redis e boto3 contra o MinIO. As consultas são SQL
Core explícito: o isolamento mora nas políticas do banco, e o SQL que as exercita precisa ser
legível. O acordo com o worker GPU está em [jobs-transcricao.md](../api/jobs-transcricao.md).

## Configuração

Tudo por ambiente (`eclume_server/config.py`):

| Variável | Padrão (dev) | Para quê |
|---|---|---|
| `ECLUME_DATABASE_URL` | `postgresql+asyncpg://eclume:eclume@127.0.0.1:5432/eclume` | papel dono do schema, superusuário ou com `BYPASSRLS` |
| `ECLUME_REDIS_URL` | `redis://127.0.0.1:6379/0` | filas arq e progresso |
| `ECLUME_S3_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`, `_BUCKET`, `_REGION` | MinIO do compose de dev | áudio e artefatos |
| `ECLUME_SECRET_KEY` | inseguro, de dev | assina as URLs de parte e de áudio |
| `ECLUME_PUBLIC_URL` | a da requisição | base absoluta das URLs devolvidas ao cliente |
| `ECLUME_COOKIE_SECURE` | `true` | `false` só em dev por HTTP puro |

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

## Isolamento por RLS

- Toda tabela de domínio tem `org_id`; as de conteúdo são do dono (`owner_id`) ou herdam a
  gravação. As políticas leem `eclume_org()` e `eclume_user()` — `current_setting('app.org_id')`
  e `app.user_id` — e toda tabela tem `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- **Toda transação de requisição** roda `SET LOCAL ROLE eclume_app` (papel `NOLOGIN`, sem
  `BYPASSRLS`) e fixa os dois settings com `set_config(..., true)` — `db.session.user_tx`. Sem
  contexto, `eclume_app` não enxerga nada.
- **Operações de sistema** — lookup de credencial, bootstrap, worker CPU, migrations — rodam com o
  papel de conexão (`system_tx`), que precisa ser superusuário ou ter `BYPASSRLS`, porque o
  `FORCE` submete até o dono às políticas. `sessions` não tem `GRANT` para `eclume_app`.
- **Visibilidade de gravação:** dono, ou compartilhamento com a organização, ou com um grupo de
  que o usuário é membro. Escrita é só do dono. Transcrição, locutores, segmentos, embeddings e
  jobs herdam a visibilidade por `EXISTS` em `recordings`.
- **Regra anti-recursão:** as políticas de `recording_shares` e `group_members` filtram só por
  organização e nunca consultam `recordings`; `recordings` consulta as duas. Uma política nova
  que feche esse ciclo quebra com "infinite recursion detected in policy".
- A API responde **404** para o que a política esconde; quem vê por compartilhamento e tenta
  escrever recebe **403**.
- **Operador não `LEAKPROOF` não chega ao índice sob a RLS.** O planner aplica antes as quals da
  política e só leva a um índice a qual do usuário que for `LEAKPROOF`: igualdade de `uuid` e
  `text` serve, `@@` (tsvector) e `@>`/`ANY` de array não. Quando o índice importa, uma função
  `SECURITY DEFINER` (com `SET search_path = public, pg_temp`) usa o índice restrita a
  `eclume_org()` e devolve **só chaves**; a consulta de `eclume_app` junta essas chaves à tabela, e
  a política continua decidindo o que o usuário vê. É o caso de `eclume_segment_matches`.
- **Efeito que atravessa a visibilidade** (renomear uma pessoa muda o nome em transcrições que
  quem editou não vê) mora num gatilho `SECURITY DEFINER`, nunca num `system_tx` dentro da rota.

## Autenticação

- **Senha** com argon2id. **Sessão:** token aleatório no cookie `eclume_session` (HttpOnly,
  Secure, SameSite=Lax, 14 dias) e `eclume_csrf` legível; o banco guarda o SHA-256 do token e o
  CSRF. Método mutável com sessão exige `X-CSRF-Token` igual ao CSRF da sessão.
- **PAT** `eclp_` + 40 caracteres base62, guardado como SHA-256 (segredo de alta entropia
  dispensa hash lento); `prefix` = os 9 primeiros caracteres. Um `Authorization: Bearer` presente
  nunca cai para o cookie.
- **Status de erro, alinhados ao que cada operação declara:**
  - sem credencial, credencial inválida, CSRF ausente ou errado, e PAT numa rota só de sessão
    (PATs, grupos, admin, logout) → **401** `unauthorized`: nessas rotas o PAT não é credencial
    aceita, e a sessão sem double-submit está incompleta;
  - escopo faltando → **403** `insufficient_scope` com `required_scopes`;
  - papel `admin` faltando ou escrita de não dono → **403** `forbidden`;
  - requisição fora do contrato (parâmetro, corpo ou regra de negócio) → **422**
    `validation_failed` com `errors[]`, em qualquer operação, como o mock;
  - operação do contrato ainda sem implementação → **501** `not_implemented`, com a spec dona no
    `detail` (`routes/not_implemented.py`). A lista sai quando a spec implementa a rota.
- Desativar um usuário apaga as sessões e revoga os PATs dele; a organização nunca fica sem admin
  ativo (422).

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
  `part-urls`. Upload vale 7 dias; o worker CPU aborta os vencidos a cada 30 min.
- **Dedup e retomada por hash:** mesmo `sha256` de uma gravação do usuário → 200 `deduplicated`;
  de um upload `in_progress` dele → o mesmo upload, com URLs das partes que faltam.
- **`complete`** fecha o multipart, relê o objeto em streaming para conferir o SHA-256 e cria
  gravação e job. Hash divergente → gravação `failed` com `job.error.code = hash_mismatch`, e a
  gravação guarda o hash **real**, deixando o declarado livre para um novo upload. `complete`
  repetido devolve a mesma gravação.
- **Chaves:** áudio em `orgs/{org}/users/{dono}/recordings/{gravação}/audio`; artefatos do worker
  em `recordings/{gravação}/…`, como o contrato de jobs fixa.
- `GET /recordings/{id}/audio` redireciona (302) para `/media/recordings/{id}/audio?expires=&sig=`,
  servido pela API com `Range` a partir do MinIO — fora de `/api/v1`, opaco para o cliente.

## Pessoas, coleções e edição da transcrição

- **Pessoas são da organização** (`people`, política `org_id = eclume_org()`): todo membro lê e
  escreve, com `people:read`/`people:write` no PAT. E-mail único por organização
  (`lower(email)`): 409 na criação, 422 em `email` no `PATCH` (que não declara 409).
  `sort_name = lower(eclume_unaccent(name))` ordena o diretório e atende `q` por prefixo do nome,
  de qualquer palavra do nome ou do e-mail; cursor `(sort_name, id)`. `eclume_unaccent` é o
  `unaccent` com dicionário fixo, `IMMUTABLE`, para caber em coluna gerada.
- **Locutor ↔ pessoa** por FK composta `speakers (person_id, org_id) → people (id, org_id)` com
  `ON DELETE SET NULL (person_id)`: vínculo entre organizações é impossível no banco, e excluir a
  pessoa só desliga os locutores (o `label` fica). `transcript_count` e `last_seen_at` contam só
  transcrições visíveis a quem pergunta. Renomear ou excluir a pessoa sobe o `updated_at` (não a
  `revision`) de toda transcrição em que ela fala, pelo gatilho `eclume_touch_person_transcripts`.
- **`voice_consent`** é só armazenado (`status` `none` ao nascer); o contrato v1 não tem campo de
  escrita, e a comparação de voz é da spec de identificação por voz.
- **Edição da transcrição** — `PATCH` de locutor (`label`, `person_id`), `POST .../speakers/merge`
  e `PATCH` de segmento — é só do dono da gravação, com `transcripts:write`; quem vê por
  compartilhamento recebe 403. Toda edição sobe `revision` e `updated_at`. Ligar sem `label` usa o
  nome da pessoa; pessoa inexistente ou de outra organização → 422 em `person_id`. A mesclagem
  apaga os locutores de origem e as impressões de voz deles e recalcula `talk_ms`; corrigir o
  texto descarta `words` e reindexa o `tsv` (coluna gerada).
- **Coleções são do usuário** (`collections`, política de dono). `recordings.collection_ids`
  segue array: a API só aceita ids de coleções do próprio usuário (422 em `collection_ids`, no
  `PATCH /recordings` e no `POST /uploads`, que as aplica no `complete`), deduplica, e excluir a
  coleção a tira das gravações (`array_remove`) subindo o `updated_at` delas. `recording_count`
  conta gravações visíveis. `GET /tags` agrega `unnest(tags)` das gravações visíveis.

## Busca full-text

- Config `eclume_pt`: cópia de `portuguese` com `unaccent` antes do `portuguese_stem`, então
  "liderancas" acha "lideranças". `segments.tsv` é coluna gerada `to_tsvector('eclume_pt', text)`
  com índice GIN.
- `GET /search` roda sob a RLS. Com `q`: `websearch_to_tsquery('eclume_pt', q)` (frase entre aspas,
  `-exclusão`), junção com `eclume_segment_matches(tsquery)` para usar o GIN, ordem `ts_rank_cd`
  desc, depois `recorded_at` desc e a posição da fala. Só com `person`: as falas da pessoa em ordem
  cronológica, `rank` 0. Sem `q` nem `person` → 422. Filtros `person`, `from`/`to` (`recorded_at`),
  `tag` e `collection` combinam com qualquer um dos modos.
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
  headers obrigatórios e corpo. Um teste confere que implementadas + pendentes = o contrato.
- **Isolamento** é provado pela API e por SQL direto sob `eclume_app` (`test_isolation.py`); a
  busca tem o próprio: nunca devolve segmento de gravação inacessível, antes e depois de
  compartilhar e de desfazer o compartilhamento (`test_search.py`).
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
uv run eclume-server admin bootstrap --org "EK Consultoria" --email admin@exemplo.com.br --name "Admin" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
```
