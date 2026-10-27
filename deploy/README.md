# deploy

eclume's runtime artifacts.

## Development and testing

- `docker-compose.dev.yml`: supporting services for local development — Postgres with pgvector,
  Redis and MinIO. Every port is published only on `127.0.0.1`.
- `.env.example`: the variables the dev compose reads; copy it to `deploy/.env` and adjust.
- `docker-compose.gpu-test.yml`: GPU worker (`worker-gpu/Dockerfile`) with ephemeral Redis and
  MinIO, for dev and for the integration test on the GPU host (project `eclume-gpu-test`, Redis on
  `127.0.0.1:16379`, MinIO on `127.0.0.1:19000`). Models in `/srv/eclume/models` and the Hugging
  Face token in `/srv/eclume/secrets/hf_token`; the runbook is in
  [docs/project/worker-gpu.md](../docs/project/worker-gpu.md).
- `docker-compose.mock.yml`: the v1 contract mock server (Prism) on `127.0.0.1:4010`, serving
  `contracts/openapi-v1.bundled.yaml` with the fixtures from `contracts/fixtures/`. Usage by lumea,
  the desktop and the frontend in [contracts/README.md](../contracts/README.md).

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

## Quality gate

The gate that clears deploys and releases (status `eclume/gate` on the commit), with the rule in
[monorepo.md](../docs/standards/code/monorepo.md):

- `pilares.sh`: each pillar's proof commands (`--lista`), the single source for CI and the gate.
- `gate.sh`: on the workstation, sends the commit's `git archive` to the host and runs the gate
  (`--pilares`, `--fundo`, `--estado`, `--plan`); `gate-host.sh` is the host side and
  `gate.Dockerfile` the pillars' `eclume-gate:<Rust version>` image.
- `gate.py` (tests in `test_gate.py`): the decision on the status, the description and the
  pre-push hook's targets (`.githooks/pre-push`).

```bash
git config core.hooksPath .githooks       # once per clone: pushing main fires the gate
bash deploy/gate.sh                       # full gate on HEAD (published), in the foreground
bash deploy/gate.sh --pilares python,web  # some of the pillars, unpublished
bash deploy/gate.sh --estado              # status and log tail on the host
```

## Production

The production stack on the GPU host (`https://192.168.15.199:8443`), with the full runbook in
[docs/project/deploy-producao.md](../docs/project/deploy-producao.md):

- `docker-compose.prod.yml`: project `eclume` — caddy (the edge with the SPA, the only published
  port, 8443), server, worker (the `eclume:default` and `eclume:agents` queues), worker-gpu, mdns
  (`_eclume._tcp` announcement on the host network), postgres, redis and minio, with data in
  `/srv/eclume`, and the `minio-init`, `migrate` and `publish-ca` one-shots in the `tools` profile.
- `server.Dockerfile`, `web.Dockerfile` and `web.Caddyfile`: the `eclume-server:prod` and
  `eclume-edge:prod` images (Caddy with the SPA and its rules), each with its `.dockerignore`
  alongside. The `claude` CLI only goes into the server image with `ECLUME_CLAUDE_CLI=1`
  (required in `.env.prod`, 0 or 1; this production uses 1).
- `.env.prod.example`: the variables; `deploy.sh --gerar-env` creates the real `deploy/.env.prod`
  (600, outside git).
- `deploy.sh`: build on the host's daemon through the Docker context and startup in order;
  `bootstrap-admin.sh`: the first admin account; `smoke_prod.py`: proves the whole path through the
  public API, with the summary provider already registered (of any kind, or `--provider <id>`);
  `smoke_mcp.py`: proves the MCP server with the `mcp` SDK and the pairing of a device.
- `backup.sh` and `restaurar-backup.sh`: installed in `/srv/eclume/bin/` by the deploy; the backup
  runs in the host's cron.
- `release-desktop.sh`: builds the desktop app on the host (CPU-limited container), signs it with
  the host's updater key and, with `--publicar`, creates the GitHub Release `desktop-v<version>`;
  `publicar-desktop.sh`: publishes that release to `/srv/eclume/downloads/`.

```bash
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/release-desktop.sh --plan
bash deploy/bootstrap-admin.sh
ssh <user>@192.168.15.199 cat /srv/eclume/secrets/admin-password | python3 deploy/smoke_prod.py --ca eclume-root.crt
ssh <user>@192.168.15.199 cat /srv/eclume/secrets/admin-password | uv run python deploy/smoke_mcp.py --ca eclume-root.crt
```

The host runbook is in [docs/project/host-setup.md](../docs/project/host-setup.md).
