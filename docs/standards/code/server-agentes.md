---
type: standard
title: Agentes de sumarização — providers, templates e resumos
description: Como o server gera resumos de transcrições — quatro providers atrás de uma interface (claude -p do servidor sem ferramentas, API da Anthropic, OpenAI-compatível e Ollama só com a fila da GPU vazia), chaves de API cifradas, providers da plataforma, templates do usuário semeados no cadastro, resumos versionados no job summarize do worker CPU com erros tipados e retentativas, map-reduce para transcrições longas e o resumo automático após a ingestão.
resource: server/src/eclume_server/agents/**, server/src/eclume_server/summaries.py, server/src/eclume_server/crypto.py, server/src/eclume_server/routes/summaries.py, server/src/eclume_server/routes/agent_providers.py, server/src/eclume_server/db/migrations/002_agentes.sql, server/src/eclume_server/db/migrations/008_conta_por_usuario.sql
tags: [code, server, agentes, resumos, templates, llm, claude]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#9, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32
maintainer: holetz
---

# Agentes de sumarização — providers, templates e resumos

O server transforma uma transcrição num resumo Markdown seguindo um template do usuário, com um
agente que o admin cadastra na plataforma. As rotas seguem o [contrato v1](../api/contrato-v1.md); a persistência e o
isolamento seguem o [núcleo do server](server-nucleo.md); o job roda na fila `eclume:default` do
[contrato de jobs](../api/jobs-transcricao.md).

## Providers

Uma interface só — `Provider.complete(system, prompt) -> Completion(text, model)` — em
`eclume_server/agents/`. `options` do provider ajusta `context_window`, `max_tokens`, `timeout_s`
e `temperature` (só enviada quando definida); sem elas valem os padrões por tipo.

| `kind` | Como chama | Janela padrão |
|---|---|---|
| `claude-cli` | `claude -p` do servidor, prompt pelo stdin | 200 000 |
| `anthropic` | SDK `anthropic`, Messages API em streaming | 200 000 |
| `openai-compatible` | `POST {base_url}/chat/completions` (DeepSeek, Groq, OpenRouter, Ollama `/v1`) | 32 000 |
| `ollama` | `POST {base_url}/api/chat` com `keep_alive: 0` | 8 192 |

- **`claude-cli` não tem ferramenta nenhuma.** A linha de comando é montada num lugar só
  (`claude_command`): `--output-format json --tools "" --system-prompt <s> --no-session-persistence
  --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk`,
  num diretório temporário vazio. O agente recebe texto e devolve texto; a transcrição nunca vira
  ação. `options.effort` vira `--effort`. O binário é `ECLUME_CLAUDE_BIN` (padrão `claude`).
- **Credencial do `claude-cli`:** o segredo do provider (`api_key`, cadastrado em Admin → Agentes
  como "Token do Claude"), o `CLAUDE_CODE_OAUTH_TOKEN` do ambiente ou o OAuth de uma sessão logada
  do Claude Code em `$HOME/.claude/.credentials.json`. O segredo do provider vence o do ambiente e
  vira a variável pelo prefixo: `sk-ant-oat…` (o token de 1 ano do `claude setup-token`) →
  `CLAUDE_CODE_OAUTH_TOKEN`, e qualquer outro (uma chave de API `sk-ant-api…`) →
  `ANTHROPIC_API_KEY`. A variável que não se aplica sai do env do subprocesso. Nenhuma credencial →
  `provider_not_configured` antes de rodar.
  A falha da CLI é lida do próprio JSON (`is_error`, `result`, `api_error_status`).
- **`anthropic`** exige `api_key` no cadastro; sem ela o SDK cairia nas credenciais do processo. As
  retentativas do SDK ficam desligadas (`max_retries=0`): quem retenta é o job, que conta cada
  tentativa. `stop_reason: refusal` → `provider_refused`.
- **`ollama` não fica residente e cede a GPU ao ASR.** Antes de cada chamada, `ZCARD eclume:gpu`
  precisa ser 0 — o arq mantém o job na fila até terminar, então zero é nada enfileirado nem
  rodando. Ocupada → `gpu_busy`, que o job adia 60 s sem gastar tentativa, até
  `options.ollama_wait_s` (padrão 2 h).

### Erros tipados

`ProviderError(code, message)`; o `code` vira `Summary.error.code`.

| Retentáveis (até 3 tentativas, espera de 30 s e 120 s) | Definitivos |
|---|---|
| `provider_timeout`, `provider_rate_limited`, `provider_unavailable` | `provider_auth`, `provider_bad_request`, `provider_refused`, `provider_not_configured`, `context_too_long` |

`gpu_busy` adia sem contar tentativa; `internal_error` é uma exceção inesperada, registrada no log.

## Chaves de API

`crypto.encrypt`/`decrypt`: AES-256-GCM, texto `v1:` + base64(nonce + cifra). A chave vem de
`ECLUME_ENCRYPTION_KEY` (base64 de 32 bytes) ou, sem ela, é derivada de `ECLUME_SECRET_KEY` por
HKDF-SHA256. **Trocar `ECLUME_SECRET_KEY` sem `ECLUME_ENCRYPTION_KEY` invalida as chaves
guardadas**: o job falha com `provider_not_configured` pedindo o recadastro, nunca com 500. A API
nunca devolve a chave, só `api_key_set`; `PATCH` com `api_key: null` apaga.

## Rotas de provider e a fronteira com o painel admin

`/admin/agent-providers` (só a sessão de admin) é desta peça, porque o job não roda sem provider;
`/admin/settings`, `/admin/secrets` e o painel estão em [server-admin.md](server-admin.md).

- **Providers são da plataforma:** `agent_providers` não tem dono nem RLS. As rotas de admin
  escrevem com o papel de conexão; `eclume_app` só lê as colunas sem segredo (`GRANT SELECT`
  coluna a coluna, sem `api_key_encrypted`), e o resumo resolve o provider sob a RLS do usuário
  com `summaries.PROVIDER_PUBLIC`. Quem abre a chave é o worker, com o papel de conexão.
- `base_url` é obrigatória para `ollama` e `openai-compatible` e proibida para `claude-cli`.
- O primeiro provider habilitado de uma plataforma sem `default_provider_id` vira o padrão;
  excluir o padrão deixa a plataforma sem padrão.
- Excluir com resumo `queued`/`running` no provider, de qualquer usuário → 409.
- O bloco `summarization` (`default_provider_id`, `auto_summarize`) mora em `platform_settings`,
  lido por todos e escrito só pelas rotas de admin.

## Templates

`summary_templates` é só do usuário (`owner_id NOT NULL`, política de dono): não há template da
plataforma nem `scope`. Template de outro usuário é 404.

- **Padrão** = `is_default` guardado no template, no máximo um por usuário (índice único
  parcial); marcar um desmarca o anterior. É o template do resumo automático.
- Toda conta nasce com **Ata de reunião** (padrão), **Resumo executivo** e **Decisões e ações**,
  pela função SQL `eclume_seed_summary_templates(user)` da migration `008`, que
  `accounts.create_user` chama no cadastro: os textos têm uma fonte só. A função não faz nada para
  quem já tem template. O usuário edita e exclui os seus, inclusive os semeados.

## Resumos

- `summaries` guarda instantâneos: `template_name`, `instructions`, `provider_name`,
  `provider_kind` e `model`. Editar ou excluir o template ou o provider não mexe nos resumos.
- `version` = maior versão do par (transcrição, template) + 1, sob `pg_advisory_xact_lock` do par.
- `summaries` tem `owner_id` (o dono da transcrição) e a política de dono: só o dono lê, gera e
  exclui; outra conta recebe 404.
- `POST /transcripts/{id}/summaries` usa `provider_id` ou o `default_provider_id`; ausente,
  inexistente ou desabilitado → 422. Responde 202 `queued` e enfileira
  `summarize(summary_id)` em `eclume:default` com `_job_id = "summarize:{summary_id}"`.
- **Automático:** `ingest_transcript` chama `auto_summarize` na mesma transação da ingestão. Com
  `summarization.auto_summarize` ligado na plataforma e provider padrão habilitado, gera o template
  padrão (`is_default`) do dono, com `trigger: automatic`; no máximo um por revisão da
  transcrição. Dono sem template padrão → sem resumo automático, e o log registra o motivo.

## O job `summarize`

Função arq do worker CPU com `timeout` de 30 min e `max_tries` alto: quem conta as tentativas é
`summaries.attempts`. Lê a transcrição do banco com o papel de sistema, marca `running`, chama o
provider e grava `done` (com `content_md` e o `model` que respondeu) ou `failed` (com `error`).
Um teto interno de 25 min garante `failed` em vez de `running` eterno. Resumo apagado ou já
concluído → o job não faz nada.

## Transcrições longas

O texto é `Título/Data/Participantes` mais uma linha `[HH:MM:SS] Locutor: texto` por segmento,
delimitado em `<transcricao>` e declarado como dado, não instrução. Tokens são estimados por
`len(texto) / 3`; a entrada pode ocupar 75% de `context_window − max_tokens`, descontados o
sistema e as instruções.

- Cabe → uma chamada com as instruções do template.
- Não cabe → **map-reduce**: seções cortadas nas fronteiras de segmento viram notas detalhadas
  (com o intervalo de tempo), e as notas passam pelas instruções do template; notas que ainda não
  cabem são condensadas em até 4 níveis. Janela pequena demais para as instruções →
  `context_too_long`.

## Deploy

O worker CPU que roda `claude-cli` precisa da CLI `claude` no `PATH` (ou `ECLUME_CLAUDE_BIN`) e de
`CLAUDE_CODE_OAUTH_TOKEN`, o token de longa duração que `claude setup-token` gera (1 ano, sem
renovação). **Não monte a sessão OAuth do host** (`~/.claude/.credentials.json`): o `claude` do
host renova o token reescrevendo o arquivo (inode novo), o bind mount de arquivo único fica no
inode antigo, e o container passa a renovar com um refresh token já rotacionado até falhar com
`provider_auth` (holetz/eclume#28). Defina `ECLUME_ENCRYPTION_KEY` em produção.

## Testes

- Os providers são provados sem rede (`server/tests/test_agents.py`): `httpx.MockTransport`,
  `httpx2.MockTransport` no SDK da Anthropic e um executável `claude` falso.
- O job e as rotas rodam com o worker CPU real e `FakeAgents`
  (`eclume_server_testing/fakes.py`), que o `run_cpu` injeta sempre: nenhum teste chama um LLM.
- O teste real, marcado `slow`, roda o `claude -p` do host sobre a transcrição de fixture:

```bash
remote-run . 'ECLUME_TEST_CLAUDE=1 PATH=$HOME/.local/bin:$PATH uv run pytest server/tests/test_agents_real.py -m slow -s'
```
