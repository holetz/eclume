---
type: standard
title: Painel admin no server — conta de admin, configuração, segredos, usuários e saúde
description: Como o server atende o painel de administração — a conta e a sessão de admin separadas das contas de usuário, a configuração em runtime da plataforma (platform_settings com o pré-processamento, o idioma automático e a regra identificação ⇒ separação; merge por campo, validação e entrega ao worker pelas options do transcribe), os tipos de agenda padrão, segredos cifrados só de escrita (platform_secrets; o token do HF vai cifrado ao worker GPU), usuários com ativar, desativar e o link de redefinição de senha, a saúde com as filas, o worker GPU, as etapas do pipeline e as sondas dos serviços, e o CLI de contas de admin.
resource: server/src/eclume_server/settings_admin.py, server/src/eclume_server/health.py, server/src/eclume_server/accounts.py, server/src/eclume_server/cli.py, server/src/eclume_server/routes/admin*.py, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql, server/src/eclume_server/db/migrations/027_redefinicao_de_senha.sql, worker-gpu/src/eclume_worker/health.py, worker-gpu/src/eclume_worker/secrets.py
tags: [code, server, admin, configuracao, segredos, usuarios, saude, cli]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#12, holetz/eclume#26, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#95, holetz/eclume#93, holetz/eclume#98, holetz/eclume#119, holetz/eclume#121
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
  de credencial comuns estão em [server-nucleo.md](server-nucleo.md#authentication).
- **As rotas de admin rodam em `system_tx`** (papel de conexão) e só tocam `platform_*`,
  `agent_providers`, `admins`, `admin_sessions`, `users` (lista, contagem de gravações por dono e
  `active`), `sessions` e `api_tokens` (ao desativar), `password_resets` (gerar e vencer o link), além da fila e dos jobs para Saúde e
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
  CHECK (id)`), com os blocos `asr`, `diarization`, `voice_identification` (`enabled`,
  `suggestion_threshold`), `preprocessing` e `quotas` (holetz/eclume#98, migration 026), mais
  `updated_at` e `updated_by` (FK para `admins`).
  Os padrões moram nas migrations 008 e 011. O bloco `summarization` saiu na 011: o resumo
  automático segue o tipo de agenda e o provider de `summaries`
  ([processamento automático](processamento-automatico.md)).
  `eclume_app` lê a linha (o liga-desliga da voz e o resumo precisam); só o admin escreve.
- O `PATCH` mescla **campo a campo** dentro de cada bloco (e, no `preprocessing`, dentro de cada
  etapa), grava `updated_at` e `updated_by` e
  devolve a configuração resultante, com `updated_by` apontando a conta de admin (`{id, name}`).
- **Validação (422 `validation_failed`, campo `bloco.campo`):** campo desconhecido é recusado
  (inclusive os que saíram, como `summarization.default_template_id` e
  `voice_identification.consent_term_text`); `null` só onde o schema aceita; `compute_type` em
  `int8_float16`, `int8`, `int8_float32` ou `float32` — `float16` é recusado aqui, porque a GTX
  16xx dá NaN nele ([worker-gpu.md](/docs/project/worker-gpu.md)); `diarization.model` só
  `pyannote/speaker-diarization-community-1`, o único pipeline que a engine carrega;
  `min_speakers ≤ max_speakers`; a JSON boolean in any numeric field (integer or float, in every block and
  preprocessing step) is a 422 instead of silently becoming `1`/`1.0` (`asr.batch_size`, `quotas.*`);
  `"4"` and `4.0` are still accepted; `endpoint_url` obrigatória com `engine: openai-compatible`;
  `voice_identification.enabled` exige `diarization.enabled` (a impressão é por locutor), checada
  só quando o `PATCH` toca um dos dois blocos: um estado antigo que a quebra não trava a edição de
  outro bloco. As regras entre campos valem sobre o estado mesclado, não só sobre o que foi enviado.
- **Idioma automático:** `asr.default_language: "auto"` manda `options.language = null`, e a
  engine detecta o idioma de cada gravação.
- **Padrão do servidor é o último recurso:** `asr.default_language` só vale quando nem o arquivo
  nem a conta escolhem (`users.transcription_language` nulo); a ordem completa (arquivo → conta →
  servidor → `pt`) está em [jobs-transcricao.md](../api/jobs-transcricao.md). O `GET
  /me/transcription` devolve o padrão em `platform_default` para os clientes o nomearem
  ("Padrão do servidor: Português").
- **Bloco `preprocessing`:** `denoise` (`enabled`, `method` `rnnoise`/`afftdn`, `strength` 0–1),
  `loudnorm` (`target_lufs` −30 a −10, `true_peak_db` −9 a 0, `lra` 1–20), `trim_silence`
  (`min_silence_s` 1–30, `threshold_db` −80 a −20) e `split_channels` (`enabled`). A conversão
  para 16 kHz mono não tem chave. Vai inteiro ao worker em `options.preprocess`; a ordem e o
  tratamento estão no [contrato de jobs](../api/jobs-transcricao.md#preprocessing).
- **Vale para os próximos jobs.** O worker não lê o banco: `transcribe_options` monta as
  `options` do `transcribe` a partir de `platform_settings` num lugar só (`recordings.insert_job`),
  usado pelo upload completo, pela retranscrição e pela retentativa. Transcrições prontas não mudam.
- **Bloco `voice_identification`:** o liga-desliga e o limiar da plataforma. Desligar apaga, na
  mesma transação do `PATCH`, os `speaker_embeddings` e as sugestões pendentes de toda a
  plataforma, e depois enfileira o `purge_embedding_objects`. As regras estão em
  [identificacao-por-voz.md](identificacao-por-voz.md).

## Tipos de agenda padrão (`/admin/default-agenda-types`)

`default_agenda_types` é da plataforma (sem dono nem RLS; só o papel de conexão e a sessão de
admin): nome, padrão de título, como identificar, tags padrão, instruções de resumo, `position` e
`include_for_new_users`. Os marcados são copiados para cada conta no cadastro
(`eclume_seed_user_defaults`); mudar ou excluir um padrão não mexe nas cópias que as contas já
têm. Nome repetido: 409 no `POST`, 422 em `name` no `PATCH`.

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

- **Bloco `quotas`** (holetz/eclume#98): as cotas padrão de toda conta — `storage_bytes` (10 GiB),
  `file_bytes` (2 GiB), `open_uploads` (3), `gpu_minutes_24h` (600) e `agent_requests_24h` (200);
  `null` é sem limite. Mesclado campo a campo pelo mesmo `PATCH /admin/settings`, com inteiros
  `>= 0` ou `null`. A conta da dona não é conhecida pela migration: ela se sobrepõe pelo painel
  depois do deploy. Regras de uso em [server-nucleo.md](server-nucleo.md#upload-and-audio) e
  [server-agentes.md](server-agentes.md#cota-de-pedidos-ao-agente).

## Usuários (`/admin/users`)

- A listagem devolve `AdminUser`: os dados da conta (`User`, com `notice_version` e
  `notice_accepted_at`), `recording_count`, o uso (`usage`: armazenamento, uploads abertos,
  minutos de áudio e pedidos ao agente em 24 h, `quotas.usage`) e a sobreposição das cotas
  (`quotas`, só os campos sobrepostos, ou `null`), do mais novo para o mais antigo. Nada do
  conteúdo.
- `PATCH /admin/users/{id}` aceita `active` e `quotas` (ao menos um). Desativar apaga as sessões e
  revoga os PATs do usuário e vence o link de redefinição pendente; reativar devolve o acesso por um login novo. `quotas` troca a
  sobreposição inteira (`users.quotas`, JSONB): os campos enviados valem sobre o padrão, `null`
  num campo é sem limite e `quotas: null` volta a conta ao padrão. Usuário inexistente → 404.
- `DELETE /admin/users/{id}` exclui a conta (204; inexistente, 404) com `accounts.purge_user`, o
  mesmo da exclusão pela própria pessoa, sem a senha e com o papel de conexão: as FKs levam tudo em
  cascata, os gatilhos põem os objetos na fila de exclusão do bucket, os `transcribe` em aberto
  recebem o pedido de cancelamento e o e-mail fica livre para um cadastro novo. O painel pede
  confirmação digitando o e-mail.
- `POST /admin/users/{id}/password-reset` (201 `PasswordResetLink`) gera o link de redefinição de
  senha com `accounts.create_password_reset`: segredo de 32 bytes no fragmento de
  `<url pública>/redefinir-senha#<segredo>`, com a URL de `server_info` (`ECLUME_PUBLIC_URL`, não
  o `Host` do pedido), válido por 24 h, e `admin_id` de quem gerou. Gerar outro vence os pendentes
  da conta; conta desativada → 409 `conflict`; inexistente → 404. O link só volta nesta resposta, e
  o painel o mostra uma vez para o admin copiar e entregar por fora, depois de confirmar quem pede.
  O admin nunca vê nem define a senha; o uso do link está em
  [server-nucleo.md](server-nucleo.md#authentication).

## Saúde (`/admin/health`)

- **Heartbeat do worker GPU:** o worker substitui `eclume:gpu:health` a cada 15 s (TTL 45 s) com
  versão, engine, dispositivo, `busy`, os modelos residentes (o ASR e o da etapa) e, com NVML, nome
  da GPU, VRAM usada e total e utilização; no SIGTERM, apaga o hash. Hash ausente = worker parado
  há mais de 45 s → `worker: null` e `gpu: null`. Os campos estão no
  [contrato de jobs](../api/jobs-transcricao.md).
- **Filas:** por fila arq (`eclume:gpu`, `eclume:default`, `eclume:agents`), `running` = ids do zset com
  `arq:in-progress:<id>`, `queued` = o resto. São números da instância, sem ids nem conteúdo.
- **Jobs retidos (`held_jobs`, holetz/eclume#98):** só números — `account_turn`, os jobs que
  aguardam a vez da conta (ela já tem um `transcribe` na GPU), e `gpu_minutes`, os que aguardam a
  janela de minutos de 24 h (`dispatch.held_counts`). O
  [despacho na vez da conta](../api/jobs-transcricao.md#queues) explica a retenção.
- **Jobs e falhas da plataforma**, lidos com o papel de conexão: `running_jobs` são os
  `transcription_jobs` `queued`/`running` **despachados** (o retido conta em `held_jobs`, e por
  isso o `queued_over_2h` do `saude --json` não alerta pela espera da vez) com etapa, progresso e o `updated_at` do hash de
  progresso; `recent_failures` são as últimas 20 etapas do pipeline `failed` em 24 h (todas as
  etapas), com `step`, e `job_id` e `retryable` só no pré-processamento e na transcrição, que são
  do job que o admin retenta (a falha passageira do [job morto](../api/jobs-transcricao.md#dead-job),
  falta de VRAM, S3). O título da gravação nunca sai: `recording_title` é sempre o rótulo fixo
  "Gravação de usuário".
- **Etapas (`steps`):** para cada etapa do pipeline fora o recebido, nas últimas 24 h, as
  execuções concluídas (`done` e `failed`), a mediana de `duration_ms` das feitas e as falhas, num
  `SELECT` só de `pipeline_steps` com o papel de conexão. Só números; as cinco etapas aparecem
  sempre, zeradas quando não rodaram.
- **Serviços (`services`):** uma sonda por serviço, em paralelo, com teto de 2 s cada —
  `healthy`, `degraded`, `down` ou `absent`:

  | Serviço | Sonda |
  |---|---|
  | `api` | a versão do server |
  | `postgres` | a RLS forçada (`relforcerowsecurity`) em todas as tabelas do usuário: detail "RLS ativa" |
  | `redis` | `PING` |
  | `storage` | `head_bucket`; acima de 1 s, `degraded` |
  | `gpu_worker` | o heartbeat `eclume:gpu:health` |
  | `cpu_worker` | as chaves `eclume:default:health-check` e `eclume:agents:health-check` do arq (os dois workers CPU), renovadas a cada 15 s (`health_check_interval`); faltando uma, `down` com o detalhe `sem worker em <fila>` |
  | `mcp` | `absent` até holetz/eclume#35 |

  A cota do bucket não aparece: a API S3 não a expõe.
- **Prontidão (`GET /api/v1/health/ready`, pública):** reaproveita as sondas `postgres`, `redis` e
  `storage` acima (`check_*` em `health.py`, teto de 2 s, em paralelo) e responde 200 com tudo `ok`
  ou 503 com o nome de quem caiu (`down`), sem latência nem mensagem de erro, porque é pública.
  `/api/v1/health` segue estático (sinal de vida, `deploy.sh`, descritor). O healthcheck do
  `server` no compose de produção é a prontidão.
- **Sondas dos workers sem subir o worker:** `eclume-server sonda fila <default|agents>` sai 0 se a
  chave `eclume:<fila>:health-check` existe; `python -m eclume_worker.health --sonda` faz o mesmo
  com `eclume:gpu:health`. São os healthchecks de `worker` (as duas filas, pela sonda leve
  `python -m eclume_server.sonda fila default agents`) e `worker-gpu` (60 s, 3 tentativas,
  `start_interval` de 2 s; `start_period` de 120 s no GPU).
- **`eclume-server saude --json`:** a mesma `admin_health()` da tela, mais um `summary`
  (`queued_over_2h`, `failed_last_24h`, `provider_auth_last_24h`, `services_down`) e o
  `claude_token` (`status` `ok`/`unknown`, `expires_at`, `days_left`). É o que o `vigia.sh` do host
  lê por `docker exec`, para a Saúde e o alerta nunca discordarem; o log do CLI vai para o stderr.
- **Vencimento do token do Claude:** `agent_providers.key_set_at` (migration 025) muda sempre que a
  chave muda (criar, trocar, apagar). Um `sk-ant-oat…` vence `key_set_at + 365 dias`; as chaves
  anteriores à migration receberam a data de criação do provider (o aviso só pode vir cedo). Token
  só no `ECLUME_CLAUDE_OAUTH_TOKEN` do env não tem data: `unknown`.

## Retentativa (`POST /admin/jobs/{job_id}/retry`)

- Só a sessão de admin. Vale para a gravação de qualquer usuário — por isso roda com o papel de
  conexão —, mas só para o job **mais recente** da gravação e em estado `failed`: job inexistente
  é 404; job antigo ou ainda em aberto é 409.
- A rota **trava a linha da gravação** (`recordings.lock_recording`, `SELECT … FOR UPDATE` num
  comando próprio) antes de ler o estado, como a retranscrição do dono: dois pedidos simultâneos
  criam uma revisão só, e o segundo recebe 409 em problem+json, nunca 500.
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
