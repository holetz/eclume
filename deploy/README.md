# deploy

Artefatos de execução do eclume.

## Desenvolvimento e teste

- `docker-compose.dev.yml`: serviços de apoio para desenvolvimento local — Postgres com pgvector,
  Redis e MinIO. Toda porta é publicada só em `127.0.0.1`.
- `.env.example`: as variáveis que o compose de dev lê; copie para `deploy/.env` e ajuste.
- `docker-compose.gpu-test.yml`: worker GPU (`worker-gpu/Dockerfile`) com Redis e MinIO efêmeros,
  para dev e para o teste de integração no host GPU (projeto `eclume-gpu-test`, Redis em
  `127.0.0.1:16379`, MinIO em `127.0.0.1:19000`). Modelos em `/srv/eclume/models` e token do
  Hugging Face em `/srv/eclume/secrets/hf_token`; o runbook está em
  [docs/project/worker-gpu.md](../docs/project/worker-gpu.md).
- `docker-compose.mock.yml`: mock server do contrato v1 (Prism) em `127.0.0.1:4010`, servindo
  `contracts/openapi-v1.bundled.yaml` com as fixtures de `contracts/fixtures/`. Uso pelo lumea,
  pelo desktop e pelo frontend em [contracts/README.md](../contracts/README.md).

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.dev.yml down

docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml up -d --build --wait
docker --context gpu-host compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml down -v

docker compose -f deploy/docker-compose.mock.yml up -d --wait
bash contracts/tests/smoke-mock.sh
docker compose -f deploy/docker-compose.mock.yml down
```

## Produção

O stack de produção no host GPU (`https://192.168.15.199:8443`), com o runbook completo em
[docs/project/deploy-producao.md](../docs/project/deploy-producao.md):

- `docker-compose.prod.yml`: projeto `eclume` — caddy (a única porta publicada, 8443), web, server,
  worker-cpu, worker-gpu, mdns (anúncio `_eclume._tcp` na rede do host), postgres, redis e minio,
  com dados em `/srv/eclume`, e os one-shots
  `minio-init`, `migrate` e `publish-ca` no perfil `tools`.
- `server.Dockerfile`, `web.Dockerfile` e `web.Caddyfile`: as imagens `eclume-server:prod` e
  `eclume-web:prod`, cada uma com o `.dockerignore` ao lado.
- `.env.prod.example`: as variáveis; `deploy.sh --gerar-env` cria o `deploy/.env.prod` real (600,
  fora do git).
- `deploy.sh`: build no daemon do host pelo contexto Docker e subida em ordem; `bootstrap-admin.sh`:
  a primeira organização e o admin; `smoke_prod.py`: prova o caminho inteiro pela API pública;
  `smoke_mcp.py`: prova o servidor MCP com o SDK `mcp` e o pareamento de um aparelho.
- `backup.sh` e `restaurar-backup.sh`: instalados em `/srv/eclume/bin/` pelo deploy; o backup
  roda no cron do host.
- `publicar-desktop.sh`: publica um release do desktop em `/srv/eclume/downloads/`.

```bash
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/bootstrap-admin.sh
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | python3 deploy/smoke_prod.py --ca eclume-root.crt
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | uv run python deploy/smoke_mcp.py --ca eclume-root.crt
```

O runbook do host está em [docs/project/host-setup.md](../docs/project/host-setup.md).
