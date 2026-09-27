---
type: standard
title: Painel admin no server — conta de admin, configuração, segredos, usuários e saúde
description: Como o server atende o painel de administração — a conta e a sessão de admin separadas das contas de usuário, a configuração em runtime da plataforma (platform_settings, merge por campo, validação e entrega ao worker pelas options do transcribe), segredos cifrados só de escrita (platform_secrets; o token do HF vai cifrado ao worker GPU), usuários com ativar e desativar, a saúde montada das filas arq, do heartbeat do worker GPU e dos jobs da plataforma, e o CLI de contas de admin.
resource: server/src/eclume_server/settings_admin.py, server/src/eclume_server/health.py, server/src/eclume_server/accounts.py, server/src/eclume_server/cli.py, server/src/eclume_server/routes/admin*.py, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql, worker-gpu/src/eclume_worker/health.py, worker-gpu/src/eclume_worker/secrets.py
tags: [code, server, admin, configuracao, segredos, usuarios, saude, cli]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#12, holetz/eclume#26, holetz/eclume#29, holetz/eclume#32
maintainer: holetz
---

# Painel admin no server — conta de admin, configuração, segredos, usuários e saúde

O painel admin é da **plataforma**, não de um usuário: a conta de admin é separada das contas de
usuário e vê e muda só o que é da plataforma. Os providers de agente (`/admin/agent-providers`)
estão em [server-agentes.md](server-agentes.md); o acordo com o worker GPU, em
[jobs-transcricao.md](../api/jobs-transcricao.md).

Na tela **Admin → Agentes**, o segredo de cada provider tem o rótulo do seu tipo: o `claude-cli`
("Claude Code do servidor") pede **"Token do Claude"**, com a explicação de como obtê-lo
(`claude setup-token` num computador logado na assinatura, token `sk-ant-oat01-…` de 1 ano); os
demais pedem "Chave de API". Os dois vão no mesmo campo cifrado `api_key`, e o server escolhe a
variável do `claude -p` pelo prefixo ([server-agentes.md](server-agentes.md)).

## Conta e sessão de admin

- **`admins`** (`id`, `email` único por `lower(email)`, `name`, `password_hash`, `active`,
  `created_at`, `last_login_at`) e **`admin_sessions`** (SHA-256 do token, CSRF, `admin_id` com
  `CASCADE`, `expires_at`) ficam sem RLS e sem `GRANT` para `eclume_app`, como `sessions`. O mesmo
  e-mail pode existir em `users` e em `admins`: são contas distintas, com senhas e sessões próprias.
- **Login** `POST /admin/auth/login` (público): argon2id, `last_login_at` e rehash como no login de
  usuário; define `eclume_admin_session` (HttpOnly, Secure, SameSite=Strict,
  `Path=/api/v1/admin`, `ECLUME_ADMIN_SESSION_TTL_HOURS`, padrão 12 h) e `eclume_admin_csrf`
  (legível, `Path=/`). `POST /admin/auth/logout` apaga a sessão; `GET /admin/me` devolve a conta.
- **Fronteira:** toda rota de `/admin/*` depende de `auth.require_admin`, que aceita só o cookie de
  admin, com double-submit `X-CSRF-Token` = `eclume_admin_csrf` em método mutável. PAT, sessão de
  usuário ou nada → 401 `unauthorized`. Admin desativado não entra nem mantém a sessão. As regras
  de credencial comuns estão em [server-nucleo.md](server-nucleo.md#autenticação).
- **As rotas de admin rodam em `system_tx`** (papel de conexão) e só tocam `platform_*`,
  `agent_providers`, `admins`, `admin_sessions`, `users` (lista, contagem de gravações por dono e
  `active`), `sessions` e `api_tokens` (ao desativar), além da fila e dos jobs para Saúde e
  retentativa. **Nenhuma rota de admin devolve conteúdo de usuário:** título, transcrição ou pessoa.

## CLI de contas de admin

- `eclume-server admin create --email --name [--password-stdin]` aplica as migrations e cria uma
  conta de admin; e-mail já existente ou senha com menos de 12 caracteres saem com código 2.
- `eclume-server admin set-password --email [--password-stdin]` troca a senha e encerra as sessões
  do admin; admin inexistente sai com código 2.
- Criar admin e trocar senha não têm rota no painel. O usuário nasce pelo cadastro
  ([server-nucleo.md](server-nucleo.md)); os testes usam `accounts.create_user`.

## Configuração em runtime (`/admin/settings`)

- **Fonte única:** `platform_settings`, **uma linha** (`id boolean PRIMARY KEY DEFAULT true
  CHECK (id)`), com os blocos `asr`, `diarization`, `summarization` (`default_provider_id`,
  `auto_summarize`) e `voice_identification` (`enabled`, `suggestion_threshold`), mais
  `updated_at` e `updated_by` (FK para `admins`). Os padrões moram só na migration 008.
  `eclume_app` lê a linha (o liga-desliga da voz e o resumo precisam); só o admin escreve.
- O `PATCH` mescla **campo a campo** dentro de cada bloco, grava `updated_at` e `updated_by` e
  devolve a configuração resultante, com `updated_by` apontando a conta de admin (`{id, name}`).
- **Validação (422 `validation_failed`, campo `bloco.campo`):** campo desconhecido é recusado
  (inclusive os que saíram, como `summarization.default_template_id` e
  `voice_identification.consent_term_text`); `null` só onde o schema aceita; `compute_type` em
  `int8_float16`, `int8`, `int8_float32` ou `float32` — `float16` é recusado aqui, porque a GTX
  16xx dá NaN nele ([worker-gpu.md](/docs/project/worker-gpu.md)); `diarization.model` só
  `pyannote/speaker-diarization-community-1`, o único pipeline que a engine carrega;
  `min_speakers ≤ max_speakers`; `endpoint_url` obrigatória com `engine: openai-compatible`;
  `default_provider_id` precisa ser provider **habilitado**. As regras entre campos valem sobre o
  estado mesclado, não só sobre o que foi enviado.
- **Vale para os próximos jobs.** O worker não lê o banco: `transcribe_options` monta as
  `options` do `transcribe` a partir de `platform_settings` num lugar só (`recordings.insert_job`),
  usado pelo upload completo, pela retranscrição e pela retentativa. Transcrições prontas não mudam.
- **Bloco `voice_identification`:** o liga-desliga e o limiar da plataforma. Desligar apaga, na
  mesma transação do `PATCH`, os `speaker_embeddings` e as sugestões pendentes de toda a
  plataforma, e depois enfileira o `purge_embedding_objects`. As regras estão em
  [identificacao-por-voz.md](identificacao-por-voz.md).

## Segredos (`/admin/secrets`)

- `platform_secrets (name, value_encrypted, updated_at, updated_by)`, cifrado com
  `crypto.encrypt` (AES-256-GCM, [server-agentes.md](server-agentes.md)), sem nenhum `GRANT` para
  `eclume_app`. A API **nunca devolve o valor**: a listagem traz cada nome conhecido com `is_set` e
  `updated_at`. `PUT` grava ou troca (204), `DELETE` apaga (404 se não havia).
- **Nomes fixos, cada um com um leitor:** `hf_token` (worker GPU) e `anthropic_api_key` (provider
  `anthropic` sem chave própria, que vence quando existe). Outro nome → 422. Um segredo novo entra
  aqui junto com o código que o lê. Quem lê para trabalhar (enfileiramento, worker CPU) usa
  `settings_admin.secret_encrypted(conn, name)` com o papel de conexão.
- **O token do HF viaja cifrado.** Ao enfileirar, o server acrescenta `hf_token_encrypted` (o texto
  `v1:` como está no banco) às `options` do payload — nunca a `transcription_jobs.options`. O
  worker abre com a mesma chave (`ECLUME_ENCRYPTION_KEY`, ou o HKDF de `ECLUME_SECRET_KEY`), por
  uma cópia do formato em `eclume_worker/secrets.py`; o segredo da plataforma vence `HF_TOKEN` e o
  arquivo montado. Não abrir não falha o job: aviso `hf_token_undecryptable` e o token do ambiente.

## Usuários (`/admin/users`)

- A listagem devolve `AdminUser`: os dados da conta (`User`, com `notice_version` e
  `notice_accepted_at`) mais `recording_count`, do mais novo para o mais antigo. Nada do conteúdo.
- `PATCH /admin/users/{id}` aceita só `{active}`. Desativar apaga as sessões e revoga os PATs do
  usuário; reativar devolve o acesso por um login novo. Usuário inexistente → 404.

## Saúde (`/admin/health`)

- **Heartbeat do worker GPU:** o worker substitui `eclume:gpu:health` a cada 15 s (TTL 45 s) com
  versão, engine, dispositivo, `busy`, os modelos residentes (o ASR e o da etapa) e, com NVML, nome
  da GPU, VRAM usada e total e utilização; no SIGTERM, apaga o hash. Hash ausente = worker parado
  há mais de 45 s → `worker: null` e `gpu: null`. Os campos estão no
  [contrato de jobs](../api/jobs-transcricao.md).
- **Filas:** por fila arq (`eclume:gpu`, `eclume:default`), `running` = ids do zset com
  `arq:in-progress:<id>`, `queued` = o resto. São números da instância, sem ids nem conteúdo.
- **Jobs e falhas da plataforma**, lidos com o papel de conexão: `running_jobs` são os
  `transcription_jobs` `queued`/`running` com etapa, progresso e o `updated_at` do hash de
  progresso; `recent_failures` são os últimos 20 `failed` em 24 h, com `retryable` (a falha
  passageira do [job morto](../api/jobs-transcricao.md#job-morto), falta de VRAM, S3). O título da
  gravação nunca sai: `recording_title` é sempre o rótulo fixo "Gravação de usuário".

## Retentativa (`POST /admin/jobs/{job_id}/retry`)

- Só a sessão de admin. Vale para a gravação de qualquer usuário — por isso roda com o papel de
  conexão —, mas só para o job **mais recente** da gravação e em estado `failed`: job inexistente
  é 404; job antigo ou ainda em aberto é 409.
- Cria o job da revisão seguinte com a configuração atual da plataforma
  (`recordings.start_next_revision`, o mesmo caminho da retranscrição do dono), põe a gravação em
  `queued`, enfileira o `transcribe` com o token do HF cifrado e responde 202 com
  `AdminJobRetried` (`job_id`, `recording_id`, `revision`, `state: queued`, `queued_at`).
- A Saúde do web mostra "Tentar de novo" em cada falha recente, destacado quando `retryable`.

## Testes

`server/tests/test_admin_auth.py` (a sessão de admin e a fronteira com as credenciais de usuário),
`test_admin_settings.py`, `test_admin_secrets.py`, `test_admin_health.py` (com a retentativa) e
`test_cli.py` rodam com Postgres, Redis e MinIO reais e a conformidade estrita ligada; a fixture
`admin` abre a sessão de uma conta de admin nova e devolve a plataforma aos padrões antes e depois
do teste. O heartbeat é semeado no Redis do teste. O lado do worker é
`worker-gpu/tests/test_health.py` e os testes de token em `test_jobs.py`.
