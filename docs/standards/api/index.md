# `standards/api/`

**How the eclume API talks to its clients** — the versioned contract in `contracts/`, the
authentication, error, pagination and upload conventions, and the evolution rules.

**Boundary:** `api/` governs the public HTTP interface. The layout and commands of each pillar live
in [../code/](../code/index.md). One standard per file; each with `type: standard` and a derived
`resource:`.

* [contrato-v1.md](contrato-v1.md) — the API v1 conventions (session and PAT with scopes, errors, pagination, S3 multipart upload, transcription) and the additive-only evolution rule
* [jobs-transcricao.md](jobs-transcricao.md) — the job contract between the server and the GPU worker: arq queues, `transcribe` with audio preprocessing, artifacts in the bucket, `ingest_transcript`/`transcription_failed`, progress and idempotency
