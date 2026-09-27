# `standards/api/`

**Como a API do eclume conversa com os clientes** — o contrato versionado em `contracts/`, as
convenções de autenticação, erros, paginação e upload, e as regras de evolução.

**Fronteira:** `api/` governa a interface HTTP pública. O layout e os comandos de cada pilar vivem
em [../code/](../code/index.md). Um padrão por arquivo; cada um com `type: standard` e um
`resource:` derivado.

* [contrato-v1.md](contrato-v1.md) — as convenções da API v1 (sessão e PAT com escopos, erros, paginação, upload multipart S3, transcrição) e a regra de evolução só aditiva
* [jobs-transcricao.md](jobs-transcricao.md) — o contrato de jobs entre o server e o worker GPU: filas arq, `transcribe` com o pré-processamento do áudio, artefatos no bucket, `ingest_transcript`/`transcription_failed`, progresso e idempotência
