---
type: standard
title: Agents — providers per purpose, agenda types, summaries, adjustment chat and the Agent
description: How the server talks to agents — four providers behind one interface (the server's claude -p with no tools, the Anthropic API, OpenAI-compatible and Ollama only with the GPU queue empty), encrypted API keys, platform providers with one purpose each (summaries, fields, chat, type detection), summaries versioned per transcript (generated from the agenda type's instructions in the summarize job, hand-edited with optimistic concurrency, adjusted by the chat) with typed errors and retries, map-reduce for long transcripts the adjustment chat (a JSON tool protocol over the transcript, in the summary_chat job) and the Agent (conversations stored under RLS, attachments with extracted text, generated files to download and an extensible tool registry, in the agent_turn job), the user's skills and the environment actions the agent proposes and the person confirms (agent_action job, through the same operations as the MCP); the matrix of what each provider requires and the optional claude CLI in the image.
resource: server/src/eclume_server/agents/**, server/src/eclume_server/summaries.py, server/src/eclume_server/crypto.py, server/src/eclume_server/routes/summaries.py, server/src/eclume_server/routes/agent_providers.py, server/src/eclume_server/db/migrations/002_agentes.sql, server/src/eclume_server/db/migrations/009_tipos_de_agenda.sql, server/src/eclume_server/db/migrations/011_plataforma_de_processamento.sql, server/src/eclume_server/db/migrations/014_gravacao_resumo.sql, server/src/eclume_server/summary_chat.py, server/src/eclume_server/routes/summary_chat.py, server/src/eclume_server/resume.py, server/src/eclume_server/privacy.py, server/src/eclume_server/routes/privacy.py, server/src/eclume_server/agent_sessions.py, server/src/eclume_server/agent_files.py, server/src/eclume_server/routes/agent.py, server/src/eclume_server/db/migrations/031_agente_conversas.sql, server/src/eclume_server/agent_skills.py, server/src/eclume_server/agent_actions.py, server/src/eclume_server/operations.py, server/src/eclume_server/routes/agent_skills.py, server/src/eclume_server/db/migrations/032_agente_habilidades_e_acoes.sql
tags: [code, server, agentes, resumos, versoes, chat, tipos-de-agenda, llm, claude, agente, arquivos, habilidades, acoes]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#9, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#34, holetz/eclume#96, holetz/eclume#129, holetz/eclume#99, holetz/eclume#98, holetz/eclume#116, holetz/eclume#142, holetz/eclume#145
maintainer: holetz
---

# Agents — providers per purpose, agenda types, summaries and adjustment chat

The server turns a transcript into a Markdown summary following the instructions of one of the
user's agenda types, with an agent the admin registers on the platform. The same providers fill
the fields and detect the type, in [automatic processing](processamento-automatico.md). The routes follow [contract v1](../api/contrato-v1.md); persistence and
isolation follow the [server core](server-nucleo.md); the job runs on the `eclume:default` queue of the
[job contract](../api/jobs-transcricao.md).

## Providers

A single interface — `Provider.complete(system, prompt, *, context="") -> Completion(text, model)` — in
`eclume_server/agents/`. The provider's `options` tune `context_window`, `max_tokens`, `timeout_s`
and `temperature` (sent only when set); without them the per-kind defaults apply.

| `kind` | How it calls | Default window |
|---|---|---|
| `claude-cli` | the server's `claude -p`, prompt over stdin | 200 000 |
| `anthropic` | `anthropic` SDK, Messages API in streaming | 200 000 |
| `openai-compatible` | `POST {base_url}/chat/completions` (DeepSeek, Groq, OpenRouter, Ollama `/v1`) | 32 000 |
| `ollama` | `POST {base_url}/api/chat` with `keep_alive: 0` | 8 192 |

- **`context` is the cacheable block.** It is the material that several calls for the same recording repeat
  (the transcript, `prompting.transcript_block`) and it goes before the `prompt` in the user message. The
  `anthropic` provider sends it as its own block with `cache_control: ephemeral`; the others join it to the prompt
  (`with_context`), and `claude -p` caches the prefix on its own. The cache is by prefix, so
  field filling and the summary use the same `system` (`SHARED_SYSTEM`) and the same block; the
  rules of each task (`FIELDS_SYSTEM`, `SYSTEM`) go in the message, after the transcript.
- **`claude-cli` has no tools at all.** The command line is built in one place only
  (`claude_command`): `--output-format json --tools "" --system-prompt <s> --no-session-persistence
  --setting-sources "" --strict-mcp-config --disable-slash-commands --permission-mode dontAsk`,
  in an empty temporary directory. The agent receives text and returns text; the transcript never becomes
  an action. `options.effort` becomes `--effort`. The binary is `ECLUME_CLAUDE_BIN` (default `claude`).
- **`claude-cli` credential:** the provider's secret (`api_key`, registered under Admin → Agentes
  as "Token do Claude"), the environment's `CLAUDE_CODE_OAUTH_TOKEN` or the OAuth of a logged-in
  Claude Code session in `$HOME/.claude/.credentials.json`. The provider's secret beats the environment's and
  becomes the variable by its prefix: `sk-ant-oat…` (the 1-year token from `claude setup-token`) →
  `CLAUDE_CODE_OAUTH_TOKEN`, and any other (an `sk-ant-api…` API key) →
  `ANTHROPIC_API_KEY`. The variable that does not apply is removed from the subprocess env. No credential →
  `provider_not_configured` before running.
  The CLI's failure is read from its own JSON (`is_error`, `result`, `api_error_status`).
- **`anthropic`** requires `api_key` in the registration; without it the SDK would fall back to the process credentials. The
  SDK's retries are turned off (`max_retries=0`): the job is what retries, counting each
  attempt. `stop_reason: refusal` → `provider_refused`.
- **`ollama` does not stay resident and yields the GPU to ASR.** Before each call, `ZCARD eclume:gpu`
  must be 0 — arq keeps the job in the queue until it finishes, so zero means nothing queued or
  running. Busy → `gpu_busy`, which the job postpones by 60 s without spending an attempt, up to
  `options.ollama_wait_s` (default 2 h).

### What each provider requires

The standard recommends no vendor: it says what leaves the server and what each kind asks for. The account, the
credential and the vendor's terms of use belong to whoever registers the provider; this
production's choice is in the runbook ([production deploy](../../project/deploy-producao.md)).

| `kind` | What leaves the server | Image and host | Credential and account |
|---|---|---|---|
| `claude-cli` | transcript and prompt to Anthropic, through the CLI | the proprietary `claude` CLI, only in the image built with `ECLUME_CLAUDE_CLI=1` | a `claude setup-token` token (the Claude account of whoever generates it) or an `sk-ant-api…` key |
| `anthropic` | transcript and prompt to the Anthropic API | nothing beyond the default image | `api_key` of the API account of whoever registers it (or the `anthropic_api_key` secret) |
| `openai-compatible` | transcript and prompt to the `base_url` | nothing beyond the default image; the `base_url` server belongs to whoever registers it | the service's `api_key`, optional on a local server |
| `ollama` | nothing, if the `base_url` is an Ollama on the LAN | a reachable Ollama; on the same GPU, it runs only with the queue empty | none |

**Nothing leaves the premises** with `ollama` on the same GPU as ASR (it gives way to the `eclume:gpu` queue) or
with `openai-compatible` pointed at a local OpenAI-compatible server (llama.cpp, vLLM,
LM Studio, Ollama's `/v1`). The other paths send the transcript to an external vendor.

### Typed errors

`ProviderError(code, message)`; the `code` becomes `Summary.error.code`.

| Retryable (up to 3 attempts, waits of 30 s and 120 s) | Definitive |
|---|---|
| `provider_timeout`, `provider_rate_limited`, `provider_unavailable`, `provider_bad_output` | `provider_auth`, `provider_bad_request`, `provider_refused`, `provider_not_configured`, `context_too_long` |

`gpu_busy` postpones without counting an attempt; `internal_error` is an unexpected exception, recorded in the log.
`provider_bad_output` is a response outside the requested format (the JSON of the fields, of the detection and of the
chat). The retry rules are a single set (`summaries.next_try`), for the summary and for the
per-agent steps; the chat has its own (below). `chat_tool_limit` (definitive) is the chat that went past the
limit of transcript queries.

### Where the text goes: each provider's destination

`privacy.py` classifies the destination of each purpose, and `GET /privacy` (public) returns it; the Account page,
the registration and the admin panel read that route, no screen decides by `kind` (holetz/eclume#116).
The rule, without resolving DNS and **when in doubt, outside** — erring outward only over-warns, erring inward
would hide the sending:

- `anthropic` and `claude-cli`: always `external`, with `Anthropic` as the processor.
- `ollama` and `openai-compatible`, by the host of the `base_url`: `localhost`, loopback,
  `host.docker.internal` and a dotless name (a compose service) are `server`; a private IP (RFC 1918,
  link-local, ULA `fc00::/7`) and the `.local`/`.lan` suffixes are `local_network`; any other host
  is `external`, labelled by the host alone (lowercase, without port, path or query).
- A purpose with no enabled provider: `disabled` (nothing is sent).
- Transcription follows the same rule through `asr.endpoint_url` with the `openai-compatible` engine; the
  local engines (`whisperx-local`, `cpu`) are `server`.

The response never carries `base_url`, the model, the key or the name the admin gave.

## API keys

`crypto.encrypt`/`decrypt`: AES-256-GCM, text `v1:` + base64(nonce + ciphertext). The key comes from
`ECLUME_ENCRYPTION_KEY` (base64 of 32 bytes) or, without it, is derived from `ECLUME_SECRET_KEY` by
HKDF-SHA256. **Changing `ECLUME_SECRET_KEY` without `ECLUME_ENCRYPTION_KEY` invalidates the stored
keys**: the job fails with `provider_not_configured` asking for re-registration, never with 500. The API
never returns the key, only `api_key_set`; `PATCH` with `api_key: null` deletes it.

## Provider routes and the boundary with the admin panel

`/admin/agent-providers` (admin session only) belongs to this piece, because the job does not run without a provider;
`/admin/settings`, `/admin/secrets` and the panel are in [server-admin.md](server-admin.md).

- **Providers belong to the platform:** `agent_providers` has no owner and no RLS. The admin routes
  write with the connection role; `eclume_app` only reads the columns without secrets (`GRANT SELECT`
  column by column, without `api_key_encrypted`), and the summary resolves the provider under the user's RLS
  with `summaries.PROVIDER_PUBLIC`. The worker is the one that opens the key, with the connection role.
- `base_url` is required for `ollama` and `openai-compatible` and forbidden for `claude-cli`.
- **Purpose (`used_for`):** `summaries`, `fields`, `chat` and `agenda_detection`. Each
  purpose has at most one provider: declaring it on one provider removes it from the others, in the same
  transaction. The database guarantees it (migration `013`): a trigger serializes the writes of `used_for`
  under an advisory lock, the same one the routes take, and refuses the overlap. `provider_for(conn,
  finalidade)` returns the enabled provider that declares it (in registration order). An
  enabled provider registered without `used_for` takes the purposes nobody declares.
- Deleting with a `queued`/`running` summary on the provider, from any user → 409; its
  purposes are left without a provider.
- There is no default provider and no `summarization` block: migration `011` gave the four purposes
  to the former default (or to the only enabled one).

## Agenda types

Summaries follow the `summary_instructions` of one of the user's agenda types
(`agenda_types`, owner policy); summary templates left in migration `009`, which converted
each one into its owner's type, with the same id. The types, the admin's default types and the detection are in
[automatic processing](processamento-automatico.md).

## Summaries

- `summaries` stores snapshots: `agenda_type_id` and `agenda_type_name` (without an FK), `instructions`,
  `provider_name`, `provider_kind` and `model`. Editing or deleting the type or the provider does not touch the
  summaries.
- `version` = highest version **of the transcript** + 1, under `pg_advisory_xact_lock('summary:{transcript_id}')`
  (`summaries.lock_versions`), with `UNIQUE (transcript_id, version)`. Switching the agenda type
  continues the history. Migration 014 renumbered the old versions (they were per transcript and
  type pair) in `created_at` order.
- `summaries` has `owner_id` (the transcript's owner) and the owner policy: only the owner reads, generates and
  deletes; another account gets 404.
- `POST /transcripts/{id}/summaries` uses `agenda_type_id` or the recording's type (none → 422) and
  `provider_id` or the `summaries` provider (absent, nonexistent or disabled → 422). It responds
  202 `queued` and enqueues `summarize(summary_id)` on `eclume:default` with
  `_job_id = "summarize:{summary_id}"`.
- **Automatic:** it is the last step of the pipeline (`summaries.start_auto_summary`), after the type
  detection: the instructions of the recording's type, the `summaries` provider and `trigger: automatic`. The
  `summarize` job closes the `summary` step.

## Agent request quota

- Each request **by the person** to the agent counts against the `agent_requests_24h` quota (holetz/eclume#98):
  generating or redoing a summary (`POST /transcripts/{id}/summaries` and the MCP's `request_summary`
  tool), the summary chat, the base chat and the previews (agenda type and field rule).
  The record is one zset per account in Redis (`eclume:quota:agent:{owner}`, the instant of each
  request), trimmed on every read to a rolling 24 h window. When exceeded, **403** `quota_exceeded`
  before enqueuing; on routes with a transaction, the refusal undoes what the request would have written.
- **Atomic and refundable (holetz/eclume#156):** `quotas.take_agent_request` trims the window, compares
  with the limit and records in a single round trip to Redis (a Lua script), so concurrent requests from the
  same account never exceed the limit; it returns the token of the counted request. Whoever spends quota before
  an action that can fail (enqueue, commit, `hset`, `abandon_reply`) refunds the token on the
  failure branch (`quotas.refunding`, `refund_agent_request`): a request that did not go out consumes no quota. The
  refund is idempotent and never raises, so as not to mask the original error.
- The automatic pipeline steps (agenda type, fields, automatic summary) do not count: they are already
  bounded by the minutes quota, one per recording, and failing on quota would leave a recording without a summary
  without the person having asked for anything.
- **Summaries in progress:** an account has at most 3 `queued`/`running` summaries
  (`quotas.MAX_OPEN_SUMMARIES`, counting the automatic ones); the next request gets **429**
  `rate_limited`, like the previews.

## Versions and editing

- Every change to the summary is a **version** with an `origin`: `generated` (the agent, from the
  type's instructions; the `summarize` job), `manual` (a hand edit, or reverting to the generated one) or `chat` (an adjustment through the chat).
  `manual` and `chat` are born `done`, with `trigger: manual` and the agenda type of the version they
  started from; `provider_*` is null on `manual` and is the chat's on `chat` (`CHECK (origin <>
  'generated' OR provider_id IS NOT NULL)`). `created_by` is whoever generated, edited or requested it.
- **Current version:** the one with the highest `version` and `status: done`; a generation in `queued`/`running` does not
  replace it until it finishes. If an edit or an adjustment came in while it ran, the generation takes the
  next number when it finishes (under the transcript lock) and becomes the current one; numbers may skip. **Reference generated version:** the most recent completed `generated` one.
  `GET /recordings/{id}/summary` returns `{current, generated, pending, version_count}`; the
  "comparar com a gerada" (compare with the generated one) belongs to the client, with both versions.
- **Hand edit** (`PUT /recordings/{id}/summary`, `summaries:write`) with optimistic concurrency:
  the body carries `base_version`, the version the person opened (0 with no completed summary). Under the
  transcript lock, if the current one is no longer that one → 409 `summary_changed` and nothing is overwritten.
- **Revert to the generated one** (`POST .../summary/revert`) creates a `manual` version with the content of the
  reference generated version and `restored_from_id` pointing to it; with no generated one, 409
  `summary_missing`. Nothing is lost: reverting is also a version.
- `DELETE /recordings/{id}/summary` deletes every version and the chat; `DELETE /summaries/{id}`
  still deletes one version. The recording routes resolve its transcript; with no transcript,
  409 `transcript_missing`.

## Adjustment chat

The request ("encurte" (shorten it), "quem falou do orçamento?" (who talked about the budget?)) becomes a reply from the agent marked for `chat`,
which works on the current summary and **reads the transcript only when the request depends on what was
said**.

- **Protocol** (`agents/chat.py`, pure): the agent speaks through text, via the `Provider.complete` that the
  four providers already have (no native tool use), and each reply is **one JSON object** with one of
  three actions: `{"action": "read_transcript", "from": "HH:MM:SS", "to": "HH:MM:SS"}`,
  `{"action": "search_transcript", "query": "termos"}` or
  `{"action": "reply", "message": "…", "summary_md": "documento inteiro" | null}`.
- **The prompt** carries the recording header (`Título/Data/Participantes`, the duration and the
  markers with a note), the current summary in `<resumo>`, the last 10 messages and the request. The
  full transcript text **never** goes in the prompt.
- **The loop:** while the action is a tool, the server runs it and appends the result in
  `<ferramenta nome=…>…</ferramenta>`. `read_transcript` returns the `[HH:MM:SS] Locutor:
  texto` lines that cross the range (it accepts `HH:MM:SS` or `MM:SS`), at most 15 min per read and what
  fits in the provider's `input_budget`; beyond that it cuts and notes `(cortado em HH:MM:SS)`.
  `search_transcript` is the search's `eclume_pt` full-text (`websearch_to_tsquery`), restricted to the
  message's transcript, with up to 8 excerpts in time order, or "nenhum trecho" (no excerpt). Each query
  is kept in `reads` (`{tool, from_ms, to_ms, clipped}` or `{tool, query, hits}`).
- **Limits:** `MAX_TOOL_CALLS = 4`; after them the prompt asks for the reply, and another tool is
  `chat_tool_limit`. The parser takes the last valid JSON object of the output (it tolerates the `json` code
  fence and surrounding text; with several fences, the last one wins); an invalid output gets **one** correction request, and the second is
  `provider_bad_output`.
- **Security:** transcript, summary and results go delimited and declared as data in the
  system prompt. The only possible effect is a new text version, and `claude-cli` keeps running with
  `--tools ""`: the transcript never becomes an action.
- **Routes** (`summaries:read`/`summaries:write`): `POST /recordings/{id}/summary/chat {message}`
  stores, in one transaction, the request (`user`, `done`) and the reply (`assistant`, `queued`, with
  `base_summary_id` = the current one) and responds 202 with both; with an open reply on the recording,
  409 `chat_busy` (partial unique index). `GET .../summary/chat` lists in chronological order and
  `GET /summary-chat-messages/{id}` is the client's poll until `done`/`failed`, like the summary.
- **The `summary_chat(message_id)` job** (CPU worker, `_job_id = "summary_chat:{id}"`) resolves the
  `chat` provider with the same `provider_config` as the summary (no provider →
  `provider_not_configured`), runs the loop with an overall ceiling of 5 min and, with `summary_md`, creates the
  `chat` version (`chat_message_id` = the reply) under the transcript lock **if the current one is still the
  base one**; if it changed, the reply ends `done` with `error.code = summary_changed` and no version. A transient
  failure (`provider_timeout`, `provider_rate_limited`, `provider_unavailable`) gets **one** new
  attempt after 10 s; `gpu_busy` fails at once ("A GPU está transcrevendo; tente em instantes"),
  because a chat does not wait hours. A deleted message (summary or recording deleted) → the job ends
  without calling the agent.
- **A reply nobody will finish:** if enqueuing fails, the route moves the reply to
  `failed` (`internal_error`) before returning the error; if the worker dies, the
  `reap_stalled_jobs` cron fails, every minute, the replies open for more than 15 min
  (`summary_chat.reap_stalled_chats`, above the job's worst case). Without it the unique index would leave
  the recording in `chat_busy` forever.
- **Why a job and not a synchronous reply:** `claude` and its credential live in the CPU worker, the
  Ollama depends on the GPU queue that only the worker checks, and a call takes from seconds to
  minutes; the 202 + poll cycle already exists in the client for the summary.

## Agent

The web **Agent** screen (formerly Questions) converses about the whole set of the user's recordings and
about the files they attach, with the provider marked for `chat` (holetz/eclume#142). The
conversations live in Postgres; the protocol is the base chat's, generalized over a tool
registry.

- **Data (migration 031, under the owner's RLS):** `agent_sessions` (title up to 120 characters, empty
  until the first question, which gives the title; `updated_at` is the last activity), `agent_messages`
  (the `user` question, always `done`, and the `assistant` reply, from `queued` to `done` or `failed`, with
  `sources`, `queries`, `model` and `error`) and `agent_files` (`input` with the extracted text, `output`
  generated by the agent; the content in the bucket at `users/{dono}/agent/{conversa}/{arquivo}`). Deleting the
  conversation cascades to everything, and a `SECURITY DEFINER` trigger on `agent_files` enqueues each
  key in `storage_deletions` (the 024 drain cleans the bucket).
- **Routes** (`routes/agent.py`, `summaries:read` like `/base-chat`): list, open, rename and
  delete conversations; attach (multipart) and remove an attachment not yet sent; ask (202 with the
  question and the reply in the queue) and poll the reply; download a file's content
  (`Content-Disposition: attachment`, `nosniff`). Another account is 404. One open reply per
  conversation (409), two per account (429), and each question counts against the agent's 24 h quota.
- **Attachments** (`agent_files.py`): .txt, .md, .csv, .pdf (`pypdf`, up to 500 pages) and .docx
  (`python-docx`, with a ceiling of 50 MB uncompressed against a zip bomb), up to 10 MB each (the
  `BodyLimitMiddleware` gives the attachment path 10 MB + 64 KB), 5 per question and 20 per conversation. The
  type comes from the extension and is checked against the content (415 `unsupported_media_type`); the extracted
  text is cut at 200 thousand characters. A PDF without a text layer comes in with empty text and the screen
  warns "sem texto legível" (no readable text).
- **Tool registry** (`agents/agent_tools.py`): each `AgentTool` declares the action name, the
  usage line in the `system`, the validation, the execution `run(env, action, budget, state)`, the
  availability by credential (`available(Capabilities)`) and the nature: `read` queries,
  `produce` prepares a file and `action` acts on the environment, always with `confirm`. The
  `default_registry()` has the four base tools (those of `agents/base_chat.py`, without the
  transcript for a PAT without `transcripts:read`), `read_file` (the text of a conversation attachment from
  `offset`, cut to the budget, with the next `offset` when it continues), `write_file`
  (`name`, `format` in `md|txt|csv|docx`, `content` up to 200 thousand characters; up to 3 per reply),
  `use_skill` and the four actions (below). Each tool has a short `description`, which
  `GET /agent/tools` returns as the catalog. `reply` is reserved for the loop; a repeated name or an `action`
  without `confirm` is refused by the registry.
- **The loop** (`agents/agent.py`, `run_agent`): the `system` starts with `AGENT_SYSTEM_PREFIX` and lists
  only the available tools; one JSON action per call, one correction
  (`provider_bad_output` on the second), up to 8 calls (`chat_tool_limit`); `reply` carries the answer and
  the sources, checked against what the tools returned. A tool with `confirm` never
  runs in the loop: with `plan`, it becomes a proposal (`RunState.proposals`, up to 3 per reply); without
  `plan`, the agent is told that the action awaits confirmation and it stays in `pending_actions`. The
  instructions of the chosen skill and `AgentContext.instructions` go at the end of the `system` as
  "Instruções da pessoa" (the person's instructions; up to 8 thousand characters). Attachments, summaries and utterances are data, not instructions,
  delimited in `<ferramenta>`; only a skill's instructions, written by the person themselves,
  are to be followed.
- **Skills** (holetz/eclume#145; `agent_skills.py`, `routes/agent_skills.py`, migration 032):
  `agent_skills` under the owner's RLS, with `name` matching `^[a-z0-9][a-z0-9-]{1,39}$` and unique per
  account (409 `skill_exists`), `description` (up to 300), `instructions` in Markdown (up to 8 thousand),
  `allowed_tools` (catalog names; null allows all) and `enabled`; up to 50 per account. Routes
  `GET/POST /agent/skills`, `GET/PATCH/DELETE /agent/skills/{id}` and `GET /agent/tools`, with
  `summaries:read` like the other Agent routes. The question picks a skill by `skill` in the body
  or by `/nome` at the start of the text (the prefix is removed from the stored text; nonexistent or disabled,
  422); `agent_messages.skill_id` and `skill_name` keep the choice. With a skill chosen, its
  instructions go into the `system` and `allowed_tools` restricts the registry (`parse_action`
  refuses a tool outside the list, not just the text). Without one, the `system` lists the enabled skills
  (name and description, up to 20) and `use_skill` loads the instructions of one and starts applying its
  restriction.
- **Environment actions** (holetz/eclume#145; `agent_actions.py`, `operations.py`): four
  `action` tools with `confirm` and `plan` — `regenerate_summaries` (`summaries:write`, up to 20
  targets), `tag_recordings` (`add`/`remove`), `collect_recordings` (`add`/`remove` of existing
  collections, by id or name) and `set_agenda_type` (an existing type), the last three with
  `recordings:write` and up to 50 targets. The targets come in `targets`: `recording_ids` or a non-empty
  filter (`agenda_type`, `from`, `to` in YYYY-MM-DD, inclusive, `collection`, `tag`), resolved under the
  RLS by the library's `Library` (for summaries, only the transcribed ones). Above the limit, with no target or
  with a name that does not exist, the agent receives the reason and there is no proposal. The tool only appears
  to the agent if the credential has the scope: the session has both; a PAT, the write scopes it has
  (passed to the `agent_turn` job).
- **Decision: reuse the MCP's operations, not `/mcp` over HTTP.** The writes live in
  `operations.py` (`regenerate_summary`, `edit_tags`, `edit_collections`, `change_agenda_type`),
  called by the MCP (`request_summary`), by the API (`PATCH /recordings/{id}`, the type switch) and
  by the `agent_action` job, always inside the owner's `user_tx`. Calling `/mcp` would require storing a
  PAT for the agent and an HTTP loop inside the server itself, with no gain in rules.
- **Proposal, confirmation and audit:** `agent_actions` stores each proposal (`proposed`) with the
  tool, the normalized parameters, the card summary and the frozen targets
  (`[{recording_id, title}]`), linked to the reply; `AgentMessage.actions` returns them. `POST
  /agent/actions/{id}/confirm` (202) moves to `queued` in a conditional update and enqueues
  `agent_action` (`_job_id=agent_action:{id}`); confirming again returns the state without re-enqueuing;
  a proposal older than 24 h becomes `expired` (409 `action_expired`), a discarded one is 409
  `action_cancelled`; a PAT without the tool's scope, 403. `POST .../cancel` only from `proposed`
  (409 `action_not_proposed`). The row is the audit record (`confirmed_via`, `token_id`,
  `decided_at`, `finished_at`, `results` per target), with `session_id` and `message_id` on `SET NULL`:
  it outlives the conversation. `GET /agent/actions` lists, paginated.
- **Execution and idempotency (`agent_action` job):** it walks the targets still without a result; each
  target is a transaction that performs the operation and stores its result (`done`, `skipped` with the
  reason, `failed` with the code), so a new run skips what was already done. A tag already applied,
  a collection already included or the same type is `skipped`; a deleted recording or one without a transcript too.
  Each regenerated summary counts against the agent's 24 h quota (when exceeded, the rest becomes `failed`
  `quota_exceeded`) and respects the 3 open summaries: on the 429, the job reschedules itself in 30 s
  (`agent_action:{id}:{n}`, up to 120 times) and continues from where it stopped. The open summaries are
  enqueued after each target's commit.
- **The `agent_turn` job** (`agent_sessions.py`, `eclume:agents` queue, no retry, ceiling of 5
  minutes): enqueued after the question's commit, with the credential's `transcripts` and write
  scopes; it reads the question's skill and the enabled ones, the proposals go to `agent_actions` in the
  same transaction as the reply; it reads the
  conversation history (the last 10 finished messages) and the sent attachments, runs the loop, builds
  the files (`render_output`; the .docx through the export's Markdown subset), writes them to the
  bucket and the reply in the same transaction. A reply open for more than 15 minutes becomes
  `failed` (`agent_expired`) on read.

### Base chat (deprecated)

`POST /base-chat` and `GET /base-chat/{id}` remain in v1, marked `deprecated` since 2.23.0, and the
web no longer uses them. The state lives 1 h in Redis (`eclume:basechat:{id}`, up to 2 open per account,
`base_chat` job), the history is what the client resends (up to 10 messages) and the harness
(`agents/base_chat.py`) has the same four base tools and `reply`, with the transcript ones only
with `transcripts:read`; the Agent reuses those tools. The provider comes from
`base_chat.chat_provider`, shared by both.

## The agent worker

The per-agent jobs — `detect_agenda_type`, `fill_fields`, `summarize`, `summary_chat`,
`base_chat`, `agent_turn` and `run_preview` — run on the `eclume:agents` queue, consumed by
`AgentWorkerSettings`, which `eclume-server worker` (the `worker` service) runs alongside the
`eclume:default` queue, with `max_jobs = ECLUME_AGENT_MAX_JOBS` (default 4 in the code, 2 in the production
compose): at most that many agent calls together, and
ingestion, on `eclume:default`, never waits behind them (holetz/eclume#96).

- **`claude -p` dies with the job.** `ClaudeCliProvider.complete` kills and waits for the process in a
  `finally` whenever it is still running: its own ceiling, the arq timeout (`CancelledError`) and the
  worker shutdown leave no orphan process.
- **Lost summary.** The resume ([processamento-automatico.md](processamento-automatico.md))
  re-enqueues the `queued`/`running` summary older than 5 min that vanished from arq and marks `failed`
  (`internal_error`) the one arq considered finished without closing it.

## The `summarize` job

An arq function of the agent worker with a `timeout` of 30 min and a high `max_tries`: what counts the attempts is
`summaries.attempts`. It reads the transcript from the database with the system role, marks `running`, calls the
provider and stores `done` (with `content_md` and the `model` that answered) or `failed` (with `error`).
An internal ceiling of 25 min guarantees `failed` instead of an eternal `running`. A summary deleted or already
completed → the job does nothing.

## Long transcripts

The text is `Título/Data/Participantes` plus one `[HH:MM:SS] Locutor: texto` line per segment,
delimited in `<transcricao>` and declared as data, not instructions. Tokens are estimated as
`len(texto) / 3`; the input may take 75% of `context_window − max_tokens`, minus the
system prompt and the instructions.

**Marker notes.** Each marker with a note (`markers.note`, up to 500 characters) becomes a
`[HH:MM:SS] Nota do marcador: texto` line at its instant, among the utterances (`transcript_text`, which fields,
agenda type, previews, summary and chat read the same way). The note is flattened onto one line, so as not to
forge another utterance, and `SHARED_SYSTEM` declares them the person's highlights, still as data. A marker without
a note does not go in. They have no new destination: they follow the purpose and the provider that already receive the utterances,
with the `privacy.py` classification applying unchanged.

- Fits → one call with the agenda type's instructions.
- Does not fit → **map-reduce**: sections cut at segment boundaries become detailed notes
  (with the time range), and the notes go through the type's instructions; notes that still do not
  fit are condensed over up to 4 levels. A window too small for the instructions →
  `context_too_long`.

## Deploy

The server image (`deploy/server.Dockerfile`) **does not carry the `claude` CLI by default**: only
openly licensed software goes into the build without options. The CLI, at a pinned version, comes in with the build arg
`ECLUME_CLAUDE_CLI=1`, which picks the `claudecli-1` stage instead of the empty `claudecli-0`. An
image without the CLI registers `claude-cli` normally and the job fails with `provider_not_configured`
("Não foi possível executar claude"). The production compose passes the arg from the deploy's
`.env.prod`, and `deploy.sh` refuses an env that does not declare `ECLUME_CLAUDE_CLI=0` or `1`,
so production does not lose the CLI by omission.

With the CLI in the image, the agent worker (in the `worker` service) that runs `claude-cli` finds `claude` on the `PATH` (or in `ECLUME_CLAUDE_BIN`) and needs
`CLAUDE_CODE_OAUTH_TOKEN`, the long-lived token that `claude setup-token` generates (1 year, without
renewal), or the token registered in the panel. **Do not mount the host's OAuth session** (`~/.claude/.credentials.json`): the host's
`claude` renews the token by rewriting the file (new inode), the single-file bind mount stays on the
old inode, and the container starts renewing with an already rotated refresh token until it fails with
`provider_auth` (holetz/eclume#28). Set `ECLUME_ENCRYPTION_KEY` in production.

`deploy/smoke_prod.py` proves the summary with the provider already registered — the enabled
`summaries` one or, with none, the enabled one without a purpose, or the one from `--provider` — of any
kind, and registers none.

## Tests

- The providers are proven without network (`server/tests/test_agents.py`): `httpx.MockTransport`,
  `httpx2.MockTransport` in the Anthropic SDK and a fake `claude` executable.
- The job and the routes run with the real CPU worker and `FakeAgents`
  (`eclume_server_testing/fakes.py`), which `run_cpu` always injects: no test calls an LLM.
  The purpose of each call comes from the system prompt, or from the field rules in the prompt (`FIELDS_SYSTEM`), since fields and summary share the `system`; `replies["chat"]` is the chat's script,
  one reply per call (queries and the final reply).
- The chat protocol is proven without a database (`test_chat_protocol.py`), with a scripted provider.
- The real test, marked `slow`, runs the host's `claude -p` over the fixture transcript: the
  summary, a request that requires the transcript (at least one query) and a form request (none):

```bash
remote-run . 'ECLUME_TEST_CLAUDE=1 PATH=$HOME/.local/bin:$PATH uv run pytest server/tests/test_agents_real.py -m slow -s'
```
