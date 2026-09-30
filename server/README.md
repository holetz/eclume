# eclume-server

API do eclume (`eclume_server`): contas de usuário e de admin, sessão e PATs, gravações com
upload multipart e dedup por hash, transcrições e o worker CPU (`eclume_server.worker`) que ingere
o que o worker GPU produz. Persistência, isolamento por RLS, autenticação e upload estão em
[docs/standards/code/server-nucleo.md](../docs/standards/code/server-nucleo.md); o contrato de
jobs com o worker GPU, em [docs/standards/api/jobs-transcricao.md](../docs/standards/api/jobs-transcricao.md).

```bash
docker compose -p eclume-test -f deploy/docker-compose.test.yml up -d --wait
ECLUME_TEST_REQUIRE_SERVICES=1 uv run pytest server/tests
uv run eclume-server migrate
uv run eclume-server admin create --email <e-mail> --name "<nome>" --password-stdin
uv run uvicorn eclume_server.app:create_app --factory
uv run arq eclume_server.worker.WorkerSettings
```
