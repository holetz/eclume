---
type: standard
title: Agentes — providers por finalidade, tipos de agenda, resumos e chat de ajuste
description: Como o server fala com agentes — quatro providers atrás de uma interface (claude -p do servidor sem ferramentas, API da Anthropic, OpenAI-compatível e Ollama só com a fila da GPU vazia), chaves de API cifradas, providers da plataforma com uma finalidade cada (resumos, campos, chat, detecção do tipo), resumos versionados por transcrição (gerados pelas instruções do tipo de agenda no job summarize, editados à mão com concorrência otimista, ajustados pelo chat) com erros tipados e retentativas, map-reduce para transcrições longas e o chat de ajuste (protocolo JSON de ferramentas sobre a transcrição, no job summary_chat); a matriz do que cada provider exige e a CLI claude opcional na imagem.
resource: server/src/eclume_server/agents/**, server/src/eclume_server/summaries.py, server/src/eclume_server/crypto.py, server/src/eclume_server/routes/summaries.py, server/src/eclume_server/routes/agent_providers.py, server/src/eclume_server/db/migrations/002_agentes.sql, server/src/eclume_server/db/migrations/009_tipos_de_agenda.sql, server/src/eclume_server/db/migrations/011_plataforma_de_processamento.sql, server/src/eclume_server/db/migrations/014_gravacao_resumo.sql, server/src/eclume_server/summary_chat.py, server/src/eclume_server/routes/summary_chat.py, server/src/eclume_server/resume.py
tags: [code, server, agentes, resumos, versoes, chat, tipos-de-agenda, llm, claude]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#9, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#34, holetz/eclume#96, holetz/eclume#129
maintainer: holetz
---

# Agentes — providers por finalidade, tipos de agenda, resumos e chat de ajuste

O server transforma uma transcrição num resumo Markdown seguindo as instruções de um tipo de agenda
do usuário, com um agente que o admin cadastra na plataforma. Os mesmos providers preenchem os
campos e detectam o tipo, no [processamento automático](processamento-automatico.md). As rotas seguem o [contrato v1](../api/contrato-v1.md); a persistência e o
isolamento seguem o [núcleo do server](server-nucleo.md); o job roda na fila `eclume:default` do
[contrato de jobs](../api/jobs-transcricao.md).

## Providers

Uma interface só — `Provider.complete(system, prompt, *, context="") -> Completion(text, model)` — em
`eclume_server/agents/`. `options` do provider ajusta `context_window`, `max_tokens`, `timeout_s`
e `temperature` (só enviada quando definida); sem elas valem os padrões por tipo.

| `kind` | Como chama | Janela padrão |
|---|---|---|
| `claude-cli` | `claude -p` do servidor, prompt pelo stdin | 200 000 |
| `anthropic` | SDK `anthropic`, Messages API em streaming | 200 000 |
| `openai-compatible` | `POST {base_url}/chat/completions` (DeepSeek, Groq, OpenRouter, Ollama `/v1`) | 32 000 |
| `ollama` | `POST {base_url}/api/chat` com `keep_alive: 0` | 8 192 |

- **`context` é o bloco cacheável.** É o material que várias chamadas da mesma gravação repetem
  (a transcrição, `prompting.transcript_block`) e vai antes do `prompt` na mensagem do usuário. O
  `anthropic` o manda como bloco próprio com `cache_control: ephemeral`; os demais o juntam ao prompt
  (`with_context`), e o `claude -p` cacheia o prefixo sozinho. O cache é por prefixo, então o
  preenchimento de campos e o resumo usam o mesmo `system` (`SHARED_SYSTEM`) e o mesmo bloco; as
  regras de cada tarefa (`FIELDS_SYSTEM`, `SYSTEM`) vão na mensagem, depois da transcrição.
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

### O que cada provider exige

A norma não recomenda fornecedor: diz o que sai do servidor e o que cada tipo pede. A conta, a
credencial e os termos de uso do fornecedor são de quem cadastra o provider; a escolha desta
produção fica no runbook ([deploy em produção](../../project/deploy-producao.md)).

| `kind` | O que sai do servidor | Imagem e host | Credencial e conta |
|---|---|---|---|
| `claude-cli` | transcrição e prompt para a Anthropic, pela CLI | a CLI `claude`, proprietária, só na imagem construída com `ECLUME_CLAUDE_CLI=1` | token do `claude setup-token` (conta Claude de quem gera) ou chave `sk-ant-api…` |
| `anthropic` | transcrição e prompt para a API da Anthropic | nada além da imagem padrão | `api_key` da conta de API de quem cadastra (ou o segredo `anthropic_api_key`) |
| `openai-compatible` | transcrição e prompt para o `base_url` | nada além da imagem padrão; o servidor do `base_url` é de quem cadastra | `api_key` do serviço, opcional num servidor local |
| `ollama` | nada, se o `base_url` é um Ollama da LAN | um Ollama alcançável; na mesma GPU, só roda com a fila vazia | nenhuma |

**Nada sai de casa** com o `ollama` na mesma GPU do ASR (ele cede a vez à fila `eclume:gpu`) ou
com o `openai-compatible` apontado para um servidor OpenAI-compatível local (llama.cpp, vLLM,
LM Studio, o `/v1` do Ollama). Os outros caminhos mandam a transcrição a um fornecedor externo.

### Erros tipados

`ProviderError(code, message)`; o `code` vira `Summary.error.code`.

| Retentáveis (até 3 tentativas, espera de 30 s e 120 s) | Definitivos |
|---|---|
| `provider_timeout`, `provider_rate_limited`, `provider_unavailable`, `provider_bad_output` | `provider_auth`, `provider_bad_request`, `provider_refused`, `provider_not_configured`, `context_too_long` |

`gpu_busy` adia sem contar tentativa; `internal_error` é uma exceção inesperada, registrada no log.
`provider_bad_output` é a resposta fora do formato pedido (o JSON dos campos, da detecção e do
chat). As regras de retentativa são uma só (`summaries.next_try`), para o resumo e para as etapas
por agente; o chat tem as próprias (abaixo). `chat_tool_limit` (definitivo) é o chat que passou do
limite de consultas à transcrição.

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
- **Finalidade (`used_for`):** `summaries`, `fields`, `chat` e `agenda_detection`. Cada
  finalidade tem no máximo um provider: declará-la num provider a tira dos outros, na mesma
  transação. O banco garante (migration `013`): um trigger serializa as escritas de `used_for`
  num advisory lock, o mesmo que as rotas tomam, e recusa a sobreposição. `provider_for(conn,
  finalidade)` devolve o provider habilitado que a declara (na ordem do cadastro). Um
  provider habilitado cadastrado sem `used_for` assume as finalidades que ninguém declara.
- Excluir com resumo `queued`/`running` no provider, de qualquer usuário → 409; as finalidades
  dele ficam sem provider.
- Não há provider padrão nem bloco `summarization`: a migration `011` deu as quatro finalidades
  ao antigo padrão (ou ao único habilitado).

## Tipos de agenda

Os resumos seguem as `summary_instructions` de um tipo de agenda do usuário
(`agenda_types`, política de dono); os templates de resumo saíram na migration `009`, que converteu
cada um no tipo do dono, com o mesmo id. Os tipos, os tipos padrão do admin e a detecção estão no
[processamento automático](processamento-automatico.md).

## Resumos

- `summaries` guarda instantâneos: `agenda_type_id` e `agenda_type_name` (sem FK), `instructions`,
  `provider_name`, `provider_kind` e `model`. Editar ou excluir o tipo ou o provider não mexe nos
  resumos.
- `version` = maior versão **da transcrição** + 1, sob `pg_advisory_xact_lock('summary:{transcript_id}')`
  (`summaries.lock_versions`), com `UNIQUE (transcript_id, version)`. Trocar o tipo de agenda
  continua o histórico. A migration 014 renumerou as versões antigas (eram por par transcrição e
  tipo) na ordem de `created_at`.
- `summaries` tem `owner_id` (o dono da transcrição) e a política de dono: só o dono lê, gera e
  exclui; outra conta recebe 404.
- `POST /transcripts/{id}/summaries` usa `agenda_type_id` ou o tipo da gravação (nenhum → 422) e
  `provider_id` ou o provider de `summaries` (ausente, inexistente ou desabilitado → 422). Responde
  202 `queued` e enfileira `summarize(summary_id)` em `eclume:default` com
  `_job_id = "summarize:{summary_id}"`.
- **Automático:** é a última etapa do pipeline (`summaries.start_auto_summary`), depois da detecção
  do tipo: as instruções do tipo da gravação, o provider de `summaries` e `trigger: automatic`. O
  `summarize` fecha a etapa `summary`.

## Versões e edição

- Toda mudança no resumo é uma **versão** com `origin`: `generated` (o agente, pelas instruções do
  tipo; o `summarize`), `manual` (edição à mão, ou voltar à gerada) ou `chat` (ajuste pelo chat).
  `manual` e `chat` nascem `done`, com `trigger: manual` e o tipo de agenda da versão de que
  partiram; o `provider_*` fica nulo na `manual` e é o do chat na `chat` (`CHECK (origin <>
  'generated' OR provider_id IS NOT NULL)`). `created_by` é quem gerou, editou ou pediu.
- **Versão atual:** a de maior `version` com `status: done`; uma geração em `queued`/`running` não
  a troca até terminar. Se uma edição ou um ajuste entrou enquanto ela rodava, a geração toma o
  próximo número ao terminar (sob o lock da transcrição) e vira a atual; os números podem pular. **Gerada de referência:** a `generated` concluída mais recente.
  `GET /recordings/{id}/summary` devolve `{current, generated, pending, version_count}`; o
  "comparar com a gerada" é do cliente, com as duas versões.
- **Edição à mão** (`PUT /recordings/{id}/summary`, `summaries:write`) com concorrência otimista:
  o corpo leva `base_version`, a versão que a pessoa abriu (0 sem resumo concluído). Sob o lock da
  transcrição, se a atual não é mais essa → 409 `summary_changed` e nada é sobrescrito.
- **Voltar à gerada** (`POST .../summary/revert`) cria uma versão `manual` com o conteúdo da
  gerada de referência e `restored_from_id` apontando para ela; sem gerada, 409
  `summary_missing`. Nada se perde: voltar também é versão.
- `DELETE /recordings/{id}/summary` apaga todas as versões e o chat; `DELETE /summaries/{id}`
  segue apagando uma versão. As rotas da gravação resolvem a transcrição dela; sem transcrição,
  409 `transcript_missing`.

## Chat de ajuste

O pedido ("encurte", "quem falou do orçamento?") vira uma resposta do agente marcado para `chat`,
que trabalha sobre o resumo atual e **só lê a transcrição quando o pedido depende do que foi
dito**.

- **Protocolo** (`agents/chat.py`, puro): o agente fala por texto, pela `Provider.complete` que os
  quatro providers já têm (sem tool-use nativo), e cada resposta é **um objeto JSON** com uma de
  três ações: `{"action": "read_transcript", "from": "HH:MM:SS", "to": "HH:MM:SS"}`,
  `{"action": "search_transcript", "query": "termos"}` ou
  `{"action": "reply", "message": "…", "summary_md": "documento inteiro" | null}`.
- **O prompt** leva o cabeçalho da gravação (`Título/Data/Participantes`, a duração e os
  marcadores com nota), o resumo atual em `<resumo>`, as últimas 10 mensagens e o pedido. O texto
  inteiro da transcrição **nunca** vai no prompt.
- **O laço:** enquanto a ação é uma ferramenta, o server a executa e anexa o resultado em
  `<ferramenta nome=…>…</ferramenta>`. `read_transcript` devolve as linhas `[HH:MM:SS] Locutor:
  texto` que cruzam o trecho (aceita `HH:MM:SS` ou `MM:SS`), no máximo 15 min por leitura e o que
  couber no `input_budget` do provider; acima disso corta e avisa `(cortado em HH:MM:SS)`.
  `search_transcript` é o full-text `eclume_pt` da busca (`websearch_to_tsquery`), restrito à
  transcrição da mensagem, com até 8 trechos em ordem de tempo, ou "nenhum trecho". Cada consulta
  fica em `reads` (`{tool, from_ms, to_ms, clipped}` ou `{tool, query, hits}`).
- **Limites:** `MAX_TOOL_CALLS = 4`; depois delas o prompt pede a resposta, e outra ferramenta é
  `chat_tool_limit`. O parser pega o último objeto JSON válido da saída (tolera a cerca de código
  `json` e texto em volta; com várias cercas, vale a última); uma saída inválida recebe **um** pedido de correção, e a segunda é
  `provider_bad_output`.
- **Segurança:** transcrição, resumo e resultados vão delimitados e declarados como dado no
  sistema. O único efeito possível é uma versão nova de texto, e o `claude-cli` segue com
  `--tools ""`: a transcrição nunca vira ação.
- **Rotas** (`summaries:read`/`summaries:write`): `POST /recordings/{id}/summary/chat {message}`
  grava, numa transação, o pedido (`user`, `done`) e a resposta (`assistant`, `queued`, com
  `base_summary_id` = a atual) e responde 202 com as duas; com uma resposta em aberto na gravação,
  409 `chat_busy` (índice único parcial). `GET .../summary/chat` lista em ordem cronológica e
  `GET /summary-chat-messages/{id}` é a consulta do cliente até `done`/`failed`, como o resumo.
- **O job `summary_chat(message_id)`** (worker CPU, `_job_id = "summary_chat:{id}"`) resolve o
  provider de `chat` com a mesma `provider_config` do resumo (sem provider →
  `provider_not_configured`), roda o laço com teto total de 5 min e, com `summary_md`, cria a
  versão `chat` (`chat_message_id` = a resposta) sob o lock da transcrição **se a atual ainda for a
  de base**; se mudou, a resposta fica `done` com `error.code = summary_changed` e sem versão. Falha
  passageira (`provider_timeout`, `provider_rate_limited`, `provider_unavailable`) tem **uma** nova
  tentativa após 10 s; `gpu_busy` falha na hora ("A GPU está transcrevendo; tente em instantes"),
  porque um chat não espera horas. Mensagem apagada (resumo ou gravação excluídos) → o job termina
  sem chamar o agente.
- **Resposta que ninguém vai terminar:** se o enfileiramento falha, a rota passa a resposta a
  `failed` (`internal_error`) antes de devolver o erro; se o worker morre, o cron
  `reap_stalled_jobs` falha, a cada minuto, as respostas em aberto há mais de 15 min
  (`summary_chat.reap_stalled_chats`, acima do pior caso do job). Sem isso o índice único deixaria
  a gravação em `chat_busy` para sempre.
- **Por que job e não resposta síncrona:** o `claude` e a credencial dele vivem no worker CPU, o
  Ollama depende da fila da GPU que só o worker consulta, e uma chamada leva de segundos a
  minutos; o ciclo 202 + consulta já existe no cliente para o resumo.

## Chat sobre a base

Uma tela de perguntas sobre o conjunto das gravações do usuário (`POST /base-chat`, `GET
/base-chat/{id}`), com o provider marcado para `chat`. O harness (`agents/base_chat.py`) usa o
mesmo protocolo de texto do chat de ajuste: uma ação JSON por chamada, sobre `Provider.complete`.

- **Ações:** `search_summaries` e `read_summary` (os resumos primeiro), `search_transcripts` e
  `read_transcript` (só quando o resumo não basta; até 15 minutos por leitura) e `reply` (`message`
  em Markdown e `sources`, os ids das gravações em que se apoia). Até 8 consultas; depois, a próxima
  ação tem de ser `reply`, senão `chat_tool_limit`. Saída que não é ação válida recebe uma correção;
  a segunda é `provider_bad_output`.
- **Fontes verificadas pelo server:** `sources` só mantém ids que apareceram nos resultados devolvidos
  ao agente, com o título do banco; um id inventado some.
- **Dado, não instrução:** resumos, falas e resultados voltam em `<ferramenta>` delimitados, e o
  `system` manda ignorar pedidos dentro deles. O agente não tem ferramenta de escrita.
- **Busca sem migration:** os resumos são buscados por `websearch_to_tsquery('eclume_pt')` sobre título,
  tags e a versão atual concluída, calculado na consulta; as falas usam a busca de `GET /search`.
  Cada consulta abre uma transação do dono (`user_tx`), então a RLS vale como em qualquer rota.
- **Assíncrono pelo Redis** (`base_chat.py`, como as pré-visualizações): `eclume:basechat:{id}`, 1 h,
  até 2 em aberto por conta (429), job `base_chat` no worker CPU sem nova tentativa e com o teto de
  5 minutos do chat de ajuste. O histórico da conversa é do cliente, que reenvia as últimas 10 mensagens.

## O worker de agentes

Os jobs por agente — `detect_agenda_type`, `fill_fields`, `summarize`, `summary_chat`,
`base_chat` e `run_preview` — rodam na fila `eclume:agents`, consumida por
`arq eclume_server.worker.AgentWorkerSettings` (serviço `worker-agents`) com
`max_jobs = ECLUME_AGENT_MAX_JOBS` (padrão 4): no máximo tantas chamadas a agente juntas, e a
ingestão, em `eclume:default`, nunca espera atrás delas (holetz/eclume#96).

- **O `claude -p` morre com o job.** `ClaudeCliProvider.complete` mata e espera o processo num
  `finally` sempre que ele ainda roda: o teto próprio, o timeout do arq (`CancelledError`) e a
  parada do worker não deixam processo órfão.
- **Resumo perdido.** A retomada ([processamento-automatico.md](processamento-automatico.md))
  reenfileira o resumo `queued`/`running` há mais de 5 min que sumiu do arq e marca `failed`
  (`internal_error`) o que o arq deu por concluído sem fechar.

## O job `summarize`

Função arq do worker de agentes com `timeout` de 30 min e `max_tries` alto: quem conta as tentativas é
`summaries.attempts`. Lê a transcrição do banco com o papel de sistema, marca `running`, chama o
provider e grava `done` (com `content_md` e o `model` que respondeu) ou `failed` (com `error`).
Um teto interno de 25 min garante `failed` em vez de `running` eterno. Resumo apagado ou já
concluído → o job não faz nada.

## Transcrições longas

O texto é `Título/Data/Participantes` mais uma linha `[HH:MM:SS] Locutor: texto` por segmento,
delimitado em `<transcricao>` e declarado como dado, não instrução. Tokens são estimados por
`len(texto) / 3`; a entrada pode ocupar 75% de `context_window − max_tokens`, descontados o
sistema e as instruções.

- Cabe → uma chamada com as instruções do tipo de agenda.
- Não cabe → **map-reduce**: seções cortadas nas fronteiras de segmento viram notas detalhadas
  (com o intervalo de tempo), e as notas passam pelas instruções do tipo; notas que ainda não
  cabem são condensadas em até 4 níveis. Janela pequena demais para as instruções →
  `context_too_long`.

## Deploy

A imagem do server (`deploy/server.Dockerfile`) **não leva a CLI `claude` por padrão**: só
software de licença aberta entra no build sem opções. A CLI, de versão fixada, entra com o build arg
`ECLUME_CLAUDE_CLI=1`, que escolhe o estágio `claudecli-1` em vez do vazio `claudecli-0`. Uma
imagem sem a CLI cadastra o `claude-cli` normalmente e o job falha com `provider_not_configured`
("Não foi possível executar claude"). O compose de produção passa o arg a partir do
`.env.prod` do deploy, e o `deploy.sh` recusa um env que não declare `ECLUME_CLAUDE_CLI=0` ou `1`,
para a produção não perder a CLI por omissão.

Com a CLI na imagem, o worker de agentes (`worker-agents`) que roda `claude-cli` acha o `claude` no `PATH` (ou em `ECLUME_CLAUDE_BIN`) e precisa de
`CLAUDE_CODE_OAUTH_TOKEN`, o token de longa duração que `claude setup-token` gera (1 ano, sem
renovação), ou do token cadastrado no painel. **Não monte a sessão OAuth do host** (`~/.claude/.credentials.json`): o `claude` do
host renova o token reescrevendo o arquivo (inode novo), o bind mount de arquivo único fica no
inode antigo, e o container passa a renovar com um refresh token já rotacionado até falhar com
`provider_auth` (holetz/eclume#28). Defina `ECLUME_ENCRYPTION_KEY` em produção.

O `deploy/smoke_prod.py` prova o resumo com o provider que já estiver cadastrado — o habilitado
de `summaries` ou, sem nenhum, o habilitado sem finalidade, ou o de `--provider` — de qualquer
tipo, e não cadastra nenhum.

## Testes

- Os providers são provados sem rede (`server/tests/test_agents.py`): `httpx.MockTransport`,
  `httpx2.MockTransport` no SDK da Anthropic e um executável `claude` falso.
- O job e as rotas rodam com o worker CPU real e `FakeAgents`
  (`eclume_server_testing/fakes.py`), que o `run_cpu` injeta sempre: nenhum teste chama um LLM.
  A finalidade de cada chamada sai do prompt de sistema, ou das regras de campos no prompt (`FIELDS_SYSTEM`), já que campos e resumo compartilham o `system`; `replies["chat"]` é o roteiro do chat,
  uma resposta por chamada (consultas e a resposta final).
- O protocolo do chat é provado sem banco (`test_chat_protocol.py`), com um provider roteirizado.
- O teste real, marcado `slow`, roda o `claude -p` do host sobre a transcrição de fixture: o
  resumo, um pedido que exige a transcrição (ao menos uma consulta) e um pedido de forma (nenhuma):

```bash
remote-run . 'ECLUME_TEST_CLAUDE=1 PATH=$HOME/.local/bin:$PATH uv run pytest server/tests/test_agents_real.py -m slow -s'
```
