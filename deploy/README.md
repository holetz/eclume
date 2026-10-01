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

## Gate de qualidade

O gate que libera deploy e releases (status `eclume/gate` no commit), com a norma em
[monorepo.md](../docs/standards/code/monorepo.md):

- `pilares.sh`: os comandos de prova de cada pilar (`--lista`), a fonte única da CI e do gate.
- `gate.sh`: na estação, envia o `git archive` do commit para o host e roda o gate
  (`--pilares`, `--fundo`, `--estado`, `--plan`); `gate-host.sh` é a parte do host e
  `gate.Dockerfile` a imagem `eclume-gate:<versão do Rust>` dos pilares.
- `gate.py` (testes em `test_gate.py`): a decisão sobre o status, a descrição e os alvos do hook de
  pre-push (`.githooks/pre-push`).

```bash
git config core.hooksPath .githooks       # uma vez por clone: o push do main dispara o gate
bash deploy/gate.sh                       # gate completo no HEAD (publicado), em primeiro plano
bash deploy/gate.sh --pilares python,web  # parte dos pilares, sem publicar
bash deploy/gate.sh --estado              # status e fim do log no host
```

## Produção

O stack de produção no host GPU (`https://192.168.15.199:8443`), com o runbook completo em
[docs/project/deploy-producao.md](../docs/project/deploy-producao.md):

- `docker-compose.prod.yml`: projeto `eclume` — caddy (a única porta publicada, 8443), web, server,
  worker-cpu, worker-gpu, mdns (anúncio `_eclume._tcp` na rede do host), postgres, redis e minio,
  com dados em `/srv/eclume`, e os one-shots
  `minio-init`, `migrate` e `publish-ca` no perfil `tools`.
- `server.Dockerfile`, `web.Dockerfile` e `web.Caddyfile`: as imagens `eclume-server:prod` e
  `eclume-web:prod`, cada uma com o `.dockerignore` ao lado. A CLI `claude` só entra na do server
  com `ECLUME_CLAUDE_CLI=1` (obrigatória no `.env.prod`, 0 ou 1; esta produção usa 1).
- `.env.prod.example`: as variáveis; `deploy.sh --gerar-env` cria o `deploy/.env.prod` real (600,
  fora do git).
- `deploy.sh`: build no daemon do host pelo contexto Docker e subida em ordem; `bootstrap-admin.sh`:
  a primeira conta de admin; `smoke_prod.py`: prova o caminho inteiro pela API pública,
  com o provider de resumos já cadastrado (de qualquer tipo, ou `--provider <id>`);
  `smoke_mcp.py`: prova o servidor MCP com o SDK `mcp` e o pareamento de um aparelho.
- `backup.sh` e `restaurar-backup.sh`: instalados em `/srv/eclume/bin/` pelo deploy; o backup
  roda no cron do host.
- `release-desktop.sh`: compila o app desktop no host (contêiner com CPU limitada), assina com a
  chave do updater do host e, com `--publicar`, cria o GitHub Release `desktop-v<versão>`;
  `publicar-desktop.sh`: publica esse release em `/srv/eclume/downloads/`.

```bash
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/release-desktop.sh --plan
bash deploy/bootstrap-admin.sh
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | python3 deploy/smoke_prod.py --ca eclume-root.crt
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | uv run python deploy/smoke_mcp.py --ca eclume-root.crt
```

O runbook do host está em [docs/project/host-setup.md](../docs/project/host-setup.md).
