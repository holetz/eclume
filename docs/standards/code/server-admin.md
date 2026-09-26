---
type: standard
title: Painel admin no server — configuração, segredos, convites e saúde
description: Como o server atende o painel de administração — configuração em runtime da organização (merge por campo, validação e entrega ao worker pelas options do transcribe), segredos cifrados só de escrita (o token do HF vai cifrado ao worker GPU), convites por link com expiração, a RLS de users por comando e a saúde montada das filas arq, do heartbeat do worker GPU e dos jobs da organização.
resource: server/src/eclume_server/settings_admin.py, server/src/eclume_server/invitations.py, server/src/eclume_server/health.py, server/src/eclume_server/routes/admin*.py, server/src/eclume_server/routes/auth.py, server/src/eclume_server/db/migrations/004_painel_admin.sql, worker-gpu/src/eclume_worker/health.py, worker-gpu/src/eclume_worker/secrets.py
tags: [code, server, admin, configuracao, segredos, convites, saude, rls]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#12, holetz/eclume#26, holetz/eclume#29
maintainer: holetz
---

# Painel admin no server — configuração, segredos, convites e saúde

As rotas `/api/v1/admin/*` aceitam **só sessão** de um usuário com papel `admin` (PAT → 401,
membro → 403, como todas as rotas só de sessão em [server-nucleo.md](server-nucleo.md)). Os
providers de agente (`/admin/agent-providers`) estão em [server-agentes.md](server-agentes.md);
o acordo com o worker GPU, em [jobs-transcricao.md](../api/jobs-transcricao.md).

Na tela **Admin → Agentes**, o segredo de cada provider tem o rótulo do seu tipo: o `claude-cli`
("Claude Code do servidor") pede **"Token do Claude"**, com a explicação de como obtê-lo
(`claude setup-token` num computador logado na assinatura, token `sk-ant-oat01-…` de 1 ano); os
demais pedem "Chave de API". Os dois vão no mesmo campo cifrado `api_key`, e o server escolhe a
variável do `claude -p` pelo prefixo ([server-agentes.md](server-agentes.md)).

## Configuração em runtime (`/admin/settings`)

- **Fonte única:** `org_settings`, uma linha por organização, lida por todos e escrita só por
  admin (política `org_settings_admin_update`). O `PATCH` mescla **campo a campo** dentro de cada
  bloco (`asr`, `diarization`, `summarization`, `voice_identification`), grava `updated_at` e
  `updated_by` e devolve a configuração resultante. Merge por campo é o que impede o `PATCH` de
  apagar o `default_template_id` que as rotas de template gravam no mesmo bloco.
- **Validação (422 `validation_failed`, campo `bloco.campo`):** campo desconhecido é recusado;
  `null` só onde o schema aceita; `compute_type` em `int8_float16`, `int8`, `int8_float32` ou
  `float32` — `float16` é recusado aqui, porque a GTX 16xx dá NaN nele
  ([worker-gpu.md](/docs/project/worker-gpu.md)); `diarization.model` só
  `pyannote/speaker-diarization-community-1`, o único pipeline que a engine carrega;
  `min_speakers ≤ max_speakers`; `endpoint_url` obrigatória com `engine: openai-compatible`;
  `default_provider_id` precisa ser provider **habilitado** da organização e
  `default_template_id`, template **da organização** (`owner_id` nulo). As regras entre campos
  valem sobre o estado mesclado, não só sobre o que foi enviado.
- **Vale para os próximos jobs.** O worker não lê o banco: `transcribe_options` monta as
  `options` do `transcribe` a partir de `org_settings` num lugar só (`recordings.insert_job`), usado
  pelo upload completo e pela retranscrição. Transcrições prontas não mudam.
- **Bloco `voice_identification`** (opt-in LGPD, limiar e termo de consentimento): um
  `consent_term_text` novo sobe `consent_term_version` sozinho, e toda mudança no bloco vai para a
  trilha de voz (`org_opt_in_changed`). A tela é a seção Identificação por voz (`/admin/voz`);
  as regras estão em [identificacao-por-voz.md](identificacao-por-voz.md).

## Segredos (`/admin/secrets`)

- `org_secrets (org_id, name, value_encrypted, updated_at, updated_by)`, cifrado com
  `crypto.encrypt` (AES-256-GCM, [server-agentes.md](server-agentes.md)). A API **nunca devolve o
  valor**: a listagem traz cada nome conhecido com `is_set` e `updated_at`. `PUT` grava ou troca
  (204), `DELETE` apaga (404 se não havia).
- **Nomes fixos, cada um com um leitor:** `hf_token` (worker GPU) e `anthropic_api_key` (provider
  `anthropic` sem chave própria, que vence quando existe). Outro nome → 422. Um segredo novo entra
  aqui junto com o código que o lê.
- **RLS só de admin em todos os comandos.** Quem precisa ler para trabalhar (enfileiramento,
  worker CPU) usa o papel de sistema.
- **O token do HF viaja cifrado.** Ao enfileirar, o server acrescenta `hf_token_encrypted` (o texto
  `v1:` como está no banco) às `options` do payload — nunca a `transcription_jobs.options`. O
  worker abre com a mesma chave (`ECLUME_ENCRYPTION_KEY`, ou o HKDF de `ECLUME_SECRET_KEY`), por
  uma cópia do formato em `eclume_worker/secrets.py`; o segredo da organização vence `HF_TOKEN` e o
  arquivo montado. Não abrir não falha o job: aviso `hf_token_undecryptable` e o token do ambiente.

## Usuários e convites

- **RLS de `users` por comando:** `users_read` (SELECT, a organização) e `users_admin_update`
  (UPDATE, `USING org AND eclume_admin()`). Antes, qualquer membro atualizaria outro pela RLS e só
  a rota impedia. `eclume_admin()` lê `users` sob a política de SELECT, que não chama a função: sem
  recursão. O `WITH CHECK` não pede admin para que um admin possa se rebaixar; a rota garante que
  resta outro admin ativo.
- **Convite = link com expiração.** `invitations` guarda o SHA-256 do token (`ecli_` + 32
  base62, ~190 bits), o e-mail, o papel, os grupos e `expires_at` (padrão 7 dias,
  `expires_in_days` de 1 a 30). O link `<ECLUME_PUBLIC_URL>/convite/<token>` só aparece na
  resposta da criação. Só admin enxerga convites (RLS).
- **Criação:** e-mail já cadastrado na instância, ou com convite pendente e válido na organização
  → 409; grupo que não é da organização → 422. **Revogar** apaga o convite não aceito; aceito ou
  inexistente → 404. `status` (`pending`, `accepted`, `expired`) é calculado, não guardado.
- **Aceite** (`POST /auth/invitations/{token}/accept`, sem credencial) roda com o papel de
  sistema: token inexistente, expirado ou usado → 404, sem distinguir; cria o usuário com
  `create_user`, as associações aos grupos que ainda existem, marca `accepted_at` e abre a sessão
  com os mesmos cookies do login. Senha com menos de 12 caracteres ou e-mail tomado → 422.
- Papel e desativação seguem em `PATCH /admin/users/{id}`: desativar apaga as sessões e revoga os
  PATs; a organização nunca fica sem admin ativo (422).

## Saúde (`/admin/health`)

- **Heartbeat do worker GPU:** o worker substitui `eclume:gpu:health` a cada 15 s (TTL 45 s) com
  versão, engine, dispositivo, `busy`, os modelos residentes (o ASR e o da etapa) e, com NVML, nome da GPU, VRAM usada e
  total e utilização; no SIGTERM, apaga o hash. Hash ausente = worker parado há mais de 45 s →
  `worker: null` e `gpu: null`. Os campos estão no [contrato de jobs](../api/jobs-transcricao.md).
- **Filas:** por fila arq (`eclume:gpu`, `eclume:default`), `running` = ids do zset com
  `arq:in-progress:<id>`, `queued` = o resto. São números da instância, sem ids nem conteúdo.
- **Jobs e falhas da organização**, lidos com o papel de sistema e filtrados por `org_id`:
  `running_jobs` são os `transcription_jobs` `queued`/`running` com etapa, progresso e o
  `updated_at` do hash de progresso; `recent_failures` são os últimos 20 `failed` em 24 h, com
  `retryable` (a falha passageira do [job morto](../api/jobs-transcricao.md#job-morto), falta de
  VRAM, S3). O título de gravação que o admin não enxerga pela RLS sai como "Gravação privada".

## Retentativa (`POST /admin/jobs/{job_id}/retry`)

- Só admin, só sessão. Vale para qualquer gravação da organização, **inclusive privada** de outro
  membro — por isso roda com o papel de sistema, filtrando por `org_id` —, mas só para o job
  **mais recente** da gravação e em estado `failed`: job de outra organização ou inexistente é
  404; job antigo ou ainda em aberto é 409.
- Cria o job da revisão seguinte com a configuração atual da organização
  (`recordings.start_next_revision`, o mesmo caminho da retranscrição do dono), põe a gravação em
  `queued`, enfileira o `transcribe` com o token do HF cifrado e responde 202 com
  `AdminJobRetried` (`job_id`, `recording_id`, `revision`, `state: queued`, `queued_at`).
- A Saúde do web mostra "Tentar de novo" em cada falha recente, destacado quando `retryable`.

## Testes

`server/tests/test_admin_settings.py`, `test_admin_secrets.py`, `test_invitations.py`,
`test_admin_health.py` (com a retentativa) e o bloco de RLS de `test_isolation.py` rodam com Postgres, Redis e MinIO
reais e a conformidade estrita ligada; o heartbeat é semeado no Redis do teste. O lado do worker é
`worker-gpu/tests/test_health.py` e os testes de token em `test_jobs.py`.
