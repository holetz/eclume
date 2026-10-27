# eclume-server

eclume's API (`eclume_server`): user and admin accounts, session and PATs, recordings with
multipart upload and hash dedup, transcripts and the CPU worker (`eclume_server.worker`) that
ingests what the GPU worker produces. Persistence, RLS isolation, authentication and upload are in
[docs/standards/code/server-nucleo.md](../docs/standards/code/server-nucleo.md); the job contract
with the GPU worker, in [docs/standards/api/jobs-transcricao.md](../docs/standards/api/jobs-transcricao.md).

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email <e-mail> --name "<name>" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
uv run arq eclume_server.worker.AgentWorkerSettings
```
