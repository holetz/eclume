---
type: standard
title: Processamento automático — pipeline, campos, tipos de agenda e resumo pelo tipo
description: Como o server processa uma gravação depois do upload — as seis etapas do pipeline por revisão e os estados delas, os campos do usuário com regras e a origem dos valores, os tipos de agenda (padrão de título, regra do assunto, tags padrão, instruções de resumo), o tipo de reserva de cada conta e os tipos padrão do admin, o cadastro de tags (fixas por padrão ou autogerenciadas com limites), os jobs detect_agenda_type e fill_fields (com as coleções automáticas) com os prompts e o JSON de saída, o resumo automático pelo tipo e as pré-visualizações.
resource: server/src/eclume_server/db/migrations/021_tipo_de_agenda_padrao.sql, server/src/eclume_server/pipeline.py, server/src/eclume_server/fields.py, server/src/eclume_server/agenda_types.py, server/src/eclume_server/previews.py, server/src/eclume_server/agents/extraction.py, server/src/eclume_server/summaries.py, server/src/eclume_server/worker.py, server/src/eclume_server/routes/fields.py, server/src/eclume_server/routes/agenda_types.py, server/src/eclume_server/routes/admin_agenda_types.py, server/src/eclume_server/db/migrations/009_tipos_de_agenda.sql, server/src/eclume_server/db/migrations/010_campos_e_valores.sql, server/src/eclume_server/db/migrations/012_etapas_do_pipeline.sql, server/src/eclume_server/db/migrations/013_revisao_do_processamento.sql, server/src/eclume_server/db/migrations/022_colecoes_automaticas.sql, server/src/eclume_server/routes/collections.py, server/src/eclume_server/tags.py, server/src/eclume_server/routes/tags.py, server/src/eclume_server/db/migrations/023_cadastro_de_tags.sql
tags: [code, server, pipeline, campos, tipos-de-agenda, resumos, agentes]
timestamp: 2026-09-30
audience: both
authority: current
source: holetz/eclume#33, holetz/eclume#76, holetz/eclume#77, holetz/eclume#78
maintainer: holetz
---

# Processamento automático — pipeline, campos, tipos de agenda e resumo pelo tipo

Depois do upload, cada gravação passa por uma cadeia de etapas sem ninguém pedir: o áudio é
recebido, pré-processado e transcrito pelo worker GPU; o tipo de agenda é detectado, os campos são
preenchidos e o resumo é gerado pelo worker CPU. As rotas seguem o [contrato v1](../api/contrato-v1.md),
a persistência e o isolamento seguem o [núcleo do server](server-nucleo.md), os providers e o job
`summarize` seguem os [agentes](server-agentes.md), e o pré-processamento segue o
[contrato de jobs](../api/jobs-transcricao.md).

## O pipeline por revisão

`pipeline_steps` guarda uma linha por (gravação, revisão, etapa). A revisão é a do job de
transcrição (`transcription_jobs.revision`): retranscrever abre uma revisão nova e refaz a cadeia.

| Etapa | Quem grava |
|---|---|
| `received` | `recordings.insert_job`, ao criar o job (upload, retranscrição, retentativa); `failed` com hash divergente |
| `preprocessing` | a ingestão, pelo `engine_info.preprocess` do worker GPU |
| `transcription` | a ingestão (`done`), a falha e o reaper (`failed`, com o erro do job) |
| `agenda_type` | o job `detect_agenda_type` |
| `fields` | o job `fill_fields` |
| `summary` | o resumo automático: `active` ao abrir, `done`/`failed` quando o `summarize` termina |

- **Estados:** `pending`, `active`, `done`, `failed` e `skipped` (os do componente `.pipeline` do
  Design System). Pulada ou falha, a etapa diz por quê: `detail.reason` (`no_provider`,
  `no_auto_fields`, `no_types`, `set_by_user`, `no_agenda_type`, `before_pipeline`) ou
  `error_code`/`error_message`.
- `pipeline.set_step` faz upsert por `(recording_id, revision, step)`: `active` marca o início, um
  estado final marca o fim e mantém o início; `duration_ms` é coluna gerada.
- **`Recording.pipeline`** são as seis etapas da maior revisão, em ordem; sem linha, `pending`.
  Enquanto o worker GPU reporta progresso, o pré-processamento (etapa `preprocess`) ou a
  transcrição (as demais) sai `active`.
- **A cadeia nunca para numa falha de agente:** campos, tipo e resumo gravam a própria etapa e
  enfileiram o próximo. Só param quando a gravação foi apagada ou a revisão não é mais a atual.
- A migration `012` preencheu o histórico: `received` e `transcription` dos jobs; pré-processamento,
  campos e tipo `skipped` com `before_pipeline`; resumo `done` quando havia resumo automático.

## Campos e a origem dos valores

`fields` é do usuário (`owner_id`, RLS de dono). Toda conta tem os embutidos **título** (`text`) e
**tags** (`list`), com a regra padrão, que não saem nem mudam de tipo (409 `builtin_field`, 422). O
título não aparece em "Campos personalizados" e a regra dele não vale mais: o assunto segue a regra
do tipo da gravação (ver [Tipos de agenda](#tipos-de-agenda)); a migration `021` o deixou sempre
automático. Os
demais são `text`, `list` ou `choice` (com `options`), cada um com a regra (`instructions`) e
`auto_fill`. A `key` é o slug do nome, única por conta e sem os marcadores `assunto`, `data` e
`tipo`; não muda quando o nome muda.

- `field_values` guarda o valor (`text`/`choice` → string, `list` → array, `null` = nada
  encontrado) e a **origem**: `auto` (o agente), `edited` (o usuário escreveu) ou `accepted` (o
  usuário aceitou o automático). **`edited` e `accepted` nunca são sobrescritos** por um
  preenchimento automático.
- Título e tags continuam em `recordings.title`/`tags`, que a busca e a biblioteca leem. Toda
  escrita passa por `fields.set_value`, que atualiza as duas tabelas juntas. `PATCH /recordings`
  com título ou tags e um upload com título ou tags explícitos viram `edited`; o nome do arquivo
  não tem origem, e o automático o troca.
- Mudar o `kind` de um campo descarta os valores dele.
- **Tetos:** regra do campo, `identify` e `summary_instructions` até 4000 caracteres; valor escrito
  pelo usuário até 300 caracteres (texto) ou 50 itens de até 300 (lista); tag, a escrita e a
  automática, até 64, como as tags padrão de um tipo.

## Cadastro de tags

`tags` é o cadastro do usuário (`owner_id`, RLS de dono): nome (até 64, único sem acento e sem
caixa), descrição ("quando usar", até 4000) e origem (`user` ou `auto`, quando o agente criou).
`recordings.tags` continua sendo o valor das gravações; o cadastro fica ao lado. A migration `023`
cadastrou as tags já usadas nas gravações e nas tags padrão dos tipos, com a grafia mais usada de
cada nome, e passou as gravações para essa grafia; a semeadura da conta nova cadastra as tags
padrão dos tipos que ela ganha.

- **Tag escrita pelo usuário entra sozinha** (`tags.adopt`): o valor `edited`/`accepted` do
  embutido Tags (edição, envio, campo) e as tags padrão de um tipo (criar e editar) ficam na grafia
  do cadastro, e o que falta é cadastrado com origem `user`.
- **Renomear, mesclar e excluir** (`PATCH /tags/{id}`, `POST /tags/{id}/merge`, `DELETE`) mexem
  também em `recordings.tags` e em `agenda_types.default_tags`, sem repetir e na mesma ordem
  (`tags.replace_everywhere`), e sobem o `updated_at` das gravações e das transcrições. Nome já
  cadastrado é 409 `tag_exists`.
- **Modo** (`users.tag_mode`, `GET/PATCH /me/tag-assignment`): `fixed` (padrão) — o agente só usa
  tags do cadastro; `auto` — pode criar até `users.tag_new_limit` (1 a 5, padrão 1) tags novas por
  gravação, sempre preferindo reusar, enquanto o cadastro tiver menos que `MAX_CATALOG` (200). O
  automático e a regra geral são os do embutido Tags (`auto_fill`, `instructions`).

## Tipos de agenda

`agenda_types` é do usuário: nome, `title_pattern`, `title_instructions` ("como escrever o
assunto"), `identify` ("como identificar"), `default_tags`, `summary_instructions` e `position`.
Substituem os templates de resumo: a migration `009` converteu cada template no tipo do dono, com o
mesmo id.

- **Tipo de reserva** (`is_fallback`, `fallback` na API; "Geral", com o selo "Padrão" na tela):
  um por conta (índice único parcial), criado pela migration `021` e por
  `eclume_seed_fallback_type(user)`, que a semeadura da conta nova chama depois dos embutidos. Nasce
  com `{assunto}` como padrão, a regra do título embutido da conta como regra do assunto e
  instruções de resumo genéricas; "Geral" já usado vira "Geral (padrão)". Não sai (409
  `fallback_agenda_type`) e não concorre na detecção. Excluir outro tipo passa as gravações dele
  para o de reserva, com origem `auto`.
- **Regra do assunto** (`title_instructions`): a regra que o agente segue para o título automático
  (`{assunto}`). Vazia, vale a do tipo de reserva; vazia também, a de fábrica
  (`DEFAULT_TITLE_RULE`). O admin também a escreve nos tipos padrão que distribui.

- **Tipos padrão do admin** (`default_agenda_types`, da plataforma, só pela sessão de admin): os
  marcados `include_for_new_users` são copiados para cada conta nova por
  `eclume_seed_user_defaults(user)`, que `accounts.create_user` chama no cadastro e que também cria
  os campos embutidos. Mudar um padrão não mexe nas cópias que as contas já têm.
- **Padrão de título:** marcadores `{assunto}` (o título automático; sem ele, o título de antes do
  primeiro padrão, guardado em `recordings.subject`, para reaplicar sem aninhar), `{data}` (`dd/mm/aaaa` de
  `recorded_at`), `{tipo}` e `{<key do campo>}`. O padrão é cortado nos separadores (` · `, ` - `,
  ` | `, travessões); uma parte que fica vazia sai junto com o separador dela.
- **Aplicar o tipo** (`agenda_types.apply_type`): grava `agenda_type_id` e a origem (`auto` ou
  `edited`), troca o título pelo padrão se o título não é `edited`/`accepted`, e soma as tags
  padrão às automáticas (as do usuário ficam como estão). A detecção aplica sem o título
  (`render=False`); o `fill_fields` o remonta no fim (`refresh_title`), com o assunto novo, e soma
  de novo as tags padrão às que acabou de escrever.
- **Trocar o tipo à mão** (`PATCH /recordings/{id}` com `agenda_type_id`): origem `edited`, título
  e tags reaplicados e, na gravação transcrita, um resumo automático novo com a etapa `summary`
  refeita — se ainda não há o automático da mesma revisão por esse tipo. `null` tira o tipo e
  devolve a escolha à detecção.

## Os jobs por agente

O worker CPU encadeia `ingest_transcript → detect_agenda_type → fill_fields → summarize`, com
`_job_id = "{job}:{recording_id}:{revision}"`. Só a ingestão que gravou a transcrição abre a cadeia:
job já falho (pelo reaper) ou ingestão repetida não enfileiram o `detect_agenda_type`. O tipo vem
antes dos campos porque o assunto do título segue a regra do tipo. Cada job resolve o provider pela finalidade
(`provider_for`) e chama o agente por `summaries.call_agent_step`, que aplica as retentativas do
`summarize` (3 tentativas, 30 s e 120 s; `gpu_busy` adia sem gastar tentativa) e conta as
tentativas em `detail.attempts` da etapa. A falha definitiva deixa a etapa `failed`, e a cadeia
segue; uma falha inesperada fora da chamada ao agente também (`internal_error`, em
`worker._run_step`).

### `fill_fields`

- Campos elegíveis: os de `auto_fill` cujo valor não é `edited`/`accepted`. Nenhum → `skipped`
  (`no_auto_fields`); sem provider `fields` → `skipped` (`no_provider`).
- O título vai com a regra do assunto do tipo da gravação (`agenda_types.title_rule`), não com a
  do campo embutido.
- **Contexto e coleções** (`fields.recording_context`): o prompt ganha o tipo de agenda da gravação
  (`## Tipo de agenda da gravação`), os participantes identificados (as pessoas ligadas aos
  locutores, com empresa, área, cargo e tags de pessoa) e, quando há, as coleções automáticas com
  regra (`auto_assign` e `instructions`) como `C1..Cn` (`- C1: Nome — regra`), com `COLLECTIONS_TASK`
  e a chave `"colecoes": ["C1", …]` no formato. Índice fora da lista é ignorado; em seções, a união.
  Só coleções, sem campos elegíveis, também chamam o agente.
- **Gravar as coleções** (`fields.apply_collections`), pela origem `recordings.collections_origin`:
  `edited` (o usuário mudou pelo `PATCH`) → nada muda, e as coleções nem vão ao prompt; `auto` → as
  escolhidas substituem as automáticas de antes, e as outras ficam; nula (vindas do envio, ou ainda
  sem escolha) → só soma. Escolheu alguma, a origem vira `auto`. A etapa guarda `collections`.
- No fim — preenchida, pulada ou falha —, `refresh_title` remonta o título pelo padrão do tipo. Ao
  terminar, o worker abre o resumo automático.
- Uma chamada para todos os campos (`agents/extraction.py`), (nunca uma por campo),
  com o `system` `SHARED_SYSTEM`, o mesmo do resumo, e a transcrição em `<transcricao>` no
  `context` (o bloco cacheável, idêntico ao do resumo: `Provider.complete` em
  [server-agentes](server-agentes.md)). As regras vêm no prompt, depois da transcrição, começando
  por `FIELDS_SYSTEM`: "Tarefa: preencher campos da gravação transcrita. Para cada campo, siga a
  regra do usuário; sem a informação na conversa, devolva null. Responda só com um objeto JSON,
  sem texto fora dele."
- O prompt lista `- key (tipo[, opções: a | b]): regra`, o cadastro de tags (`## Tags
  cadastradas`, `- nome — descrição`, até 200, com a regra do modo: "use só tags desta lista" ou
  "prefira sempre uma tag desta lista… no máximo N nova(s) por gravação") quando o embutido Tags é
  elegível, e o formato esperado.
- **Tags do agente** (`tags.resolve`): cada tag proposta é casada com o cadastro por
  `tags.canonical` (sem acento nem caixa, hífens e espaços unificados, plural do português no
  singular) e fica na grafia do cadastro; as que não casam só ficam no modo `auto`, até o limite
  por gravação e o espaço que resta no cadastro, e entram nele com origem `auto`. No modo `fixed`,
  somem.
- Transcrição maior que a janela: uma chamada por seção (`split_sections`) e a mescla — texto e
  escolha, o valor não nulo mais frequente (empate, o primeiro); lista, a união sem repetição.
- Validação: escolha fora das opções → `null`; lista de strings, até 10; texto até 300
  caracteres. JSON que não abre → `provider_bad_output`, retentável.
- Grava com origem `auto`, rechecando a elegibilidade: o que o usuário escreveu enquanto o agente
  trabalhava fica.

### `detect_agenda_type`

- Tipo escolhido pelo usuário (`edited`) → `skipped` (`set_by_user`), e o resumo usa esse tipo.
  Só o tipo de reserva → `no_types`; sem provider `agenda_detection` → `no_provider`.
- Os tipos, **sem o de reserva**, viram `T1..Tn` (nome e como identificar) e a transcrição vai só
  até o orçamento da janela, a partir do início (o Ollama tem 8 k, e o assunto aparece cedo).
  `DETECT_SYSTEM` pede o tipo que melhor descreve a gravação, ou `null` quando nenhum serve, e só o
  JSON `{"tipo": "T2" ou null, "confianca": 0.0-1.0, "motivo": "uma frase"}`. Um `tipo` fora da
  lista, ou a chave ausente, é `provider_bad_output`.
- **Reserva:** `tipo: null` ou confiança abaixo de `MIN_CONFIDENCE` (0,6) aplica o tipo de
  reserva; a etapa guarda o tipo aplicado, `fallback`, o candidato (`candidate_name`), a confiança
  e o motivo. Pulada ou falha, o worker aplica o de reserva à gravação sem tipo (`ensure_type`,
  que não para a cadeia se falhar): o resumo sempre tem um tipo.
- O resultado é aplicado com origem `auto`, sem o título, que espera os campos.

### O resumo automático pelo tipo

`summaries.start_auto_summary`, chamado pelo worker ao fim do `fill_fields`, abre o resumo
`trigger: automatic` com as instruções do tipo da gravação e o provider `summaries`, e marca a etapa `summary` `active` com o `summary_id`. Sem tipo
→ `skipped` (`no_agenda_type`); sem provider → `no_provider`. Já existindo o automático da mesma
revisão e do mesmo tipo, nada é criado. O `summarize` fecha a etapa; o resumo apagado antes de
gerar a fecha `skipped` (`summary_deleted`). O resumo de uma chamada lê a transcrição como o
`fill_fields` (mesmo `system` e mesmo `context`), então o cache de prompt do provider serve às duas
etapas e a nova tentativa do `fill_fields`.

## Retranscrição

A revisão nova refaz a cadeia: valores `auto` e tipo `auto` são recalculados; `edited` e `accepted`
ficam.

## Pré-visualizações

"Testar numa gravação" (`POST /fields/preview`) e "Pré-visualizar numa gravação"
(`POST /agenda-types/preview`) rodam o job `run_preview` sobre um rascunho, sem gravar nada no
banco: o estado vive no Redis (`eclume:preview:{id}`, com `owner_id`, `kind`, `status` e `result`)
por 1 h, e `GET /previews/{id}` de outra conta é 404. Cada conta tem no máximo 3 em aberto (na
fila ou rodando, em `eclume:preview:open:{owner_id}`); a quarta é 429 `rate_limited`.

- `field_rule` roda `FIELDS_SYSTEM` só com o campo em rascunho, em até 3 gravações transcritas (as
  indicadas, ou as 3 mais recentes do usuário).
- `agenda_type` roda, numa gravação, a detecção com o rascunho no lugar do tipo salvo que ele edita
  (`agenda_type_id`, ou o de mesmo nome), o título e as tags que ele aplicaria e o resumo com as
  instruções do rascunho. A regra de reserva vale igual: `fallback` diz que ficaria o tipo padrão;
  o rascunho do próprio tipo de reserva não concorre e é o que fica quando nenhum serve.

## Testes

`FakeAgents` (`eclume_server_testing/fakes.py`) reconhece a finalidade pelo prompt de sistema
ou, nos campos, pelas regras no prompt (`FIELDS_SYSTEM`, `DETECT_SYSTEM`, resumo) e tem uma fila de respostas por finalidade
(`replies`) e de erros por finalidade (`failures`); sem resposta programada, os campos saem vazios, a detecção escolhe `T1` e o resumo é
Markdown determinístico. Nenhum teste chama LLM. `server/tests/test_processing.py` prova a cadeia
com o worker CPU real.
