# contracts

Source of truth for eclume's API v1: what any client — the web, the apps, your own program or an
AI assistant — can ask of an eclume server and what it gets back. The conventions and the
evolution rules are in the standard
[docs/standards/api/contrato-v1.md](../docs/standards/api/contrato-v1.md).

- **Browsable reference.** Every eclume server serves the generated reference of this contract, in
  the version it runs, at `https://<server>/referencia-api.html` (routes, scopes, parameters,
  schemas and examples, with nothing from outside the origin). The web generates it from
  `openapi-v1.bundled.yaml` at build time.
- **Integration guide.** From the token to incremental sync, with errors, limits and the MCP:
  [docs/how-to/integrar-com-a-api.md](../docs/how-to/integrar-com-a-api.md).
- **Mock.** To write a client without a server, the mock below answers with the examples.

| File | What it is |
|---|---|
| `openapi-v1.yaml` | **Source.** OpenAPI 3.1 of API v1: authentication, scopes, errors, pagination and every route. |
| `transcript.schema.json` | **Source.** JSON Schema 2020-12 of the transcript, referenced by the OpenAPI. It is also the GPU worker's output. |
| `fixtures/` | **Source.** Realistic pt-BR examples, one file per OpenAPI example (`externalValue`). |
| `openapi-v1.bundled.yaml` | **Generated** by `tools/bundle.py`: a single file, with no external refs and the fixtures inlined. It is what the mock and the type generators read. Do not edit by hand. |
| `tools/bundle.py` | Generates the bundle; `--check` fails if it is stale. |
| `tests/` | Contract tests (workspace pytest) and the mock smoke test; they also pin v1's deprecated fields (`DEPRECATED_V1`), which stay required until `/api/v2`. |

```bash
uv run python contracts/tools/bundle.py          # after changing any source
uv run pytest contracts/tests                    # OpenAPI, schema, fixtures, .md export, lumea mapping
docker compose -f deploy/docker-compose.mock.yml up -d --wait
bash contracts/tests/smoke-mock.sh
```

## Mock server

Prism (`stoplight/prism:5.15.10`) serves the bundle at `http://127.0.0.1:4010`, in static mode:
each route answers with its declared example, which comes from `fixtures/`.

- **Credential.** Protected routes require the *presence* of a credential: `Authorization: Bearer
  eclp_<anything>` or the `eclume_session` cookie. Without it, 401 with the problem from
  `fixtures/problem-unauthorized.json`. The mock does **not** check scopes. The
  `/api/v1/admin/*` routes require the admin account's `eclume_admin_session` cookie; a PAT or a
  user session there gets 401.
- **Validation.** The body and the parameters are validated against the contract; an invalid
  request gets 422.
- **Choosing the response.** `Prefer: code=<status>` picks the status and `Prefer: example=<name>`
  the example. Note: `POST /api/v1/uploads` answers by default with the **200** (`deduplicated`),
  because Prism picks the lowest 2xx; send `Prefer: code=201` to simulate a new upload.
- **Full upload.** The example's part URLs point at the mock itself
  (`PUT /api/v1/uploads/{id}/parts/{n}`, which returns an `ETag`), so the create → parts →
  complete flow runs end to end against it.
- **Port.** Published only on `127.0.0.1` (`ECLUME_MOCK_PORT` changes the port). For a lumea
  container on the default bridge to reach the mock, start it with `ECLUME_MOCK_BIND=172.17.0.1`
  and use `http://172.17.0.1:4010`, or `extra_hosts: ["host.docker.internal:host-gateway"]` in the
  service.

## Usage examples

### lumea, a PAT-based importer

1. With an eclume checkout alongside (`~/Projetos/eclume`), start the mock:
   `docker compose -f ~/Projetos/eclume/deploy/docker-compose.mock.yml up -d --wait`.
2. Point the importer at `http://127.0.0.1:4010` with any `eclp_...` PAT.
3. `GET /api/v1/me` shows the connected account and the PAT's scopes; `GET /api/v1/transcripts?since=`
   lists; `GET /api/v1/transcripts/{id}` returns the 3-speaker transcript.
4. In lumea's unit tests, copy the fixtures you need (`transcript-3-locutores.json`,
   `transcript-page.json`) instead of depending on the mock; the integration test uses the mock.

### The desktop app, resumable upload (#13)

`POST /api/v1/uploads` (with `Prefer: code=201`), `PUT` of each part to the `url` received,
`POST /api/v1/uploads/{id}/complete` and polling `GET /api/v1/recordings/{id}` until `transcribed`
or `failed`. Resuming: `GET /api/v1/uploads/{id}` and `POST /api/v1/uploads/{id}/part-urls`.

### The mapping to lumea's `transcricao.md`

The v1 JSON generates the frontmatter of `transcricao.md` (`lumea/assets/meet/transcribe/store.py`,
`models.py`) without loss. The test `test_v1_json_produces_the_lumea_frontmatter_without_loss` proves
the mapping with the 3-speaker fixture.

| `transcricao.md` | v1 JSON |
|---|---|
| `quando` | `recorded_at` |
| `participantes[].nome` | `speakers[].person.name`; with no person, `speakers[].label` |
| `participantes[].speaker_id` | `speakers[].id` |
| `participantes[].papel` | does not exist in eclume: the importer decides (`desconhecido` by default) |
| `gaps[]` `speaker-identity` | one per speaker with `person: null`; `amostra` = the text of that speaker's first segment |
| body `**Nome** [HH:MM:SS]: texto` | `segments[]`: speaker name, `start_ms` truncated to seconds, `text` |
| dedup key | `content_hash` (`sha256:` of the audio); reimporting is idempotent, `revision` says whether it changed |

A voice suggestion (`speakers[].suggestions`) is **not** an identity: the speaker keeps its gap
until someone confirms the person in eclume.

## Evolution rules

v1 only takes **additive** changes:

- **Allowed:** a new route; a new **optional** request parameter or field; a new response field;
  a new enum value in a response; a new error code (`code`); a new export format; a new scope
  required only by a new route.
- **Forbidden in v1:** removing or renaming a route, field or parameter; changing a type or a
  meaning; making an optional request field required; tightening the validation of an existing
  input; requiring an extra scope or role on an existing route; changing the success status.
- **Clients:** ignore unknown properties and tolerate unknown enum values in responses; decide on
  errors by `code`. That is why the response schemas do not use `additionalProperties: false`
  (the tests close the objects only to catch a wrong fixture).
- **Every change** bumps `info.version` (minor; patch for text) and, if it touches the transcript,
  `schema_version`; updates the fixtures; regenerates the bundle; and passes
  `uv run pytest contracts/tests`.
- **A breaking change** becomes `/api/v2` with its own `openapi-v2.yaml`. v1 keeps being served
  during the transition, announcing its end with the `Deprecation` and `Sunset` headers.
- **The single exception: 2.0.0.** The end of the organization (one account per user, an admin
  with its own session) shipped under `/api/v1`, because the desktop and lumea use nothing that
  changed; the reason is in the standard.
