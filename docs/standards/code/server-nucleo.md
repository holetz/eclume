---
type: standard
title: Núcleo do server — persistência, isolamento, autenticação e upload
description: Como o pacote eclume_server guarda e isola os dados (migrations SQL, RLS por organização e dono sob o papel eclume_app), autentica (sessão com CSRF, PAT com escopos), recebe uploads (URL de parte assinada pela própria API, dedup e retomada por hash) e é testado (serviços reais, conformidade com o OpenAPI bundled).
resource: server/**, deploy/docker-compose.test.yml
tags: [code, server, postgres, rls, auth, upload, testes]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#5
maintainer: holetz
---

# Núcleo do server — persistência, isolamento, autenticação e upload

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
- Pessoas (`speakers.person_id`) e coleções (`recordings.collection_ids`) já têm coluna, mas as
  tabelas e FKs chegam com a spec `pessoas-organizacao-e-busca`.

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

## Testes

- Postgres, Redis e MinIO reais, de `deploy/docker-compose.test.yml` (projeto `eclume-test`,
  portas `127.0.0.1:55532/56479/59100`, dados em `tmpfs`). Cada sessão de teste cria um banco
  migrado, um bucket e limpa um banco do Redis. Sem os serviços, os testes do server **pulam**;
  com `ECLUME_TEST_REQUIRE_SERVICES=1` (a CI), a ausência **falha**.
- **Conformidade:** um hook de resposta no `TestClient` valida toda resposta de `/api/v1` contra
  `contracts/openapi-v1.bundled.yaml` com os objetos fechados (`strictify`): status declarado,
  headers obrigatórios e corpo. Um teste confere que implementadas + pendentes = o contrato.
- **Isolamento** é provado pela API e por SQL direto sob `eclume_app` (`test_isolation.py`).
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
