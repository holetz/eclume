# deploy

Artefatos de execução do eclume.

- `docker-compose.dev.yml`: serviços de apoio para desenvolvimento local — Postgres com pgvector,
  Redis e MinIO. Toda porta é publicada só em `127.0.0.1`.
- `.env.example`: as variáveis que o compose de dev lê; copie para `deploy/.env` e ajuste.
- `docker-compose.mock.yml`: mock server do contrato v1 (Prism) em `127.0.0.1:4010`, servindo
  `contracts/openapi-v1.bundled.yaml` com as fixtures de `contracts/fixtures/`. Uso pelo lumea,
  pelo desktop e pelo frontend em [contracts/README.md](../contracts/README.md).

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.dev.yml down

docker compose -f deploy/docker-compose.mock.yml up -d --wait
bash contracts/tests/smoke-mock.sh
docker compose -f deploy/docker-compose.mock.yml down
```

O compose de produção, o Caddy (`tls internal`, porta 8443) e o deploy no host GPU por
`docker --context gpu-host` entram com as specs `provisionamento-host-gpu` e
`deploy-eclume-host-gpu`. O runbook do host está em
[docs/project/host-setup.md](../docs/project/host-setup.md).
