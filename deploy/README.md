# deploy

Artefatos de execução do eclume.

- `docker-compose.dev.yml`: serviços de apoio para desenvolvimento local — Postgres com pgvector,
  Redis e MinIO. Toda porta é publicada só em `127.0.0.1`.
- `.env.example`: as variáveis que o compose de dev lê; copie para `deploy/.env` e ajuste.

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.dev.yml down
```

O compose de produção, o Caddy (`tls internal`, porta 8443) e o deploy no host GPU por
`docker --context gpu-host` entram com as specs `provisionamento-host-gpu` e
`deploy-eclume-host-gpu`. O runbook do host está em
[docs/project/host-setup.md](../docs/project/host-setup.md).
