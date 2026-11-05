---
type: project
title: Production deploy on the GPU host
description: How eclume runs in production on the host 192.168.15.199 — the eclume compose project with Caddy on 8443, build on the host daemon through the Docker context, secrets in deploy/.env.prod, a separate admin account and open signup, an internal CA on the clients, a daily cron backup with a tested restore, operation and coexistence with lumea.
resource: deploy/docker-compose.prod.yml, deploy/deploy.sh, deploy/deploy_lib.py, deploy/.env.prod.example, deploy/server.Dockerfile, deploy/web.Dockerfile, deploy/web.Caddyfile, deploy/bootstrap-admin.sh, deploy/backup.sh, deploy/restore-backup.sh, deploy/staging.sh, deploy/docker-compose.staging.yml, deploy/smoke_prod.py, deploy/smoke_mcp.py, deploy/prove-web-prod.sh, deploy/release-desktop.sh, deploy/test_compose_prod.py, deploy/prove-restricted-ca.sh
tags: [deploy, producao, host, caddy, backup, runbook]
timestamp: 2026-10-08
audience: both
authority: current
source: holetz/eclume#14, holetz/eclume#26, holetz/eclume#28, holetz/eclume#29, holetz/eclume#32, holetz/eclume#33, holetz/eclume#35, holetz/eclume#39, holetz/eclume#60, holetz/eclume#110, holetz/eclume#92, holetz/eclume#101, holetz/eclume#151
maintainer: holetz
---

# Production deploy on the GPU host

This is the runbook for **this** production: this institution's eclume runs on the host
`192.168.15.199`, prepared by the [host runbook](host-setup.md), and answers at
**`https://192.168.15.199:8443`**. The generic path, for any server with or without a GPU, is in
[auto-hospedar.md](../how-to/auto-hospedar.md); this page holds the values and choices of this host. The
host is shared with lumea (443) and with the user's personal services, which the deploy never touches.

```
LAN ──► :8443 caddy (tls internal) ─┬─ /api/*, /media/*, /mcp ──► server:8000 (uvicorn)
        eclume-edge                 ├─ /downloads/*           ──► /srv/eclume/downloads (read-only)
                                    └─ rest                   ──► /srv/web (SPA in the image itself)
server ──► postgres · redis · minio ◄── worker (eclume:default and eclume:agents, claude -p)
                         redis ◄──────── worker-gpu (eclume:gpu, WhisperX on the GTX 1660 SUPER)
```

## Stack

`deploy/docker-compose.prod.yml`, project **`eclume`** (containers `eclume-<service>-1`), with eight
long-running services (there were ten before holetz/eclume#151, with `web` and two CPU workers):

| Service | Image | Role |
|---|---|---|
| `caddy` | `eclume-edge:prod` (`deploy/web.Dockerfile`) | the edge: Caddy 2.11 with the SPA build in `/srv/web` and its rules (`deploy/web.Caddyfile`, at `/etc/caddy/spa.caddy`); internal TLS on 8443, the **only published port** |
| `server` | `eclume-server:prod` (`deploy/server.Dockerfile`) | API (`uvicorn`) and the MCP server at `/mcp`, with a healthcheck on `/api/v1/health/ready`; reads the published CA (`/srv/downloads`, read-only) for the `/api/v1/server` descriptor |
| `mdns` | `eclume-server:prod` | `eclume-server announce` (light: only the announcer, no app): announces `_eclume._tcp` on the LAN with the public address and the CA fingerprint; `network_mode: host`, no published port ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md#network-discovery-mdns)) |
| `worker` | `eclume-server:prod` | `eclume-server worker`: the queues `eclume:default` (ingestion, purges, reaper, resume and upload expiry) and `eclume:agents` (agenda type, fields, summaries, chats and previews, with `ECLUME_AGENT_MAX_JOBS` slots, default 2, and `claude -p`) in a single process |
| `worker-gpu` | `eclume-worker-gpu:prod` (`worker-gpu/Dockerfile`, ~8 GB) | ASR and diarization, `max_jobs=1`; exits on its own (code 0) after the idle unload and `restart` brings it back ([worker-gpu.md](worker-gpu.md)) |
| `postgres` | `pgvector/pgvector:pg16` | database; server and CPU worker connect as `eclume_server` (no superuser, DML only) and requests drop to `eclume_app`; the `eclume` superuser is left for `migrate`, the bootstrap and the backup ([server-nucleo.md](../standards/code/server-nucleo.md#database-roles)) |
| `redis` | `valkey/valkey:9.1.3-alpine` | Valkey (BSD-3-Clause), which speaks the Redis protocol: queues and progress, with `appendonly`. The service keeps the `redis` name and the `redis://` URLs; it replaced `redis:7-alpine` in holetz/eclume#324 ([cutover](#one-time-cutover-from-redis-to-valkey)) |
| `minio` | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | audio and artifacts (MinIO stopped publishing images); `MINIO_API_STALE_UPLOADS_EXPIRY=192h` keeps an incomplete multipart for 8 days, above the upload's 7, so resumption really works |

One-shots of the `tools` profile, run by `compose run --rm`: `minio-init` (bucket, users and per-service policies), `migrate`
(`eclume-server migrate`, as the superuser, which also enables the `LOGIN` of `eclume_server` with `ECLUME_RUNTIME_PG_PASSWORD`) and `publish-ca` (copies the CA to `/downloads/`).

- **Only Caddy publishes a port.** Docker publishes outside ufw, so Postgres, Redis, MinIO and
  server have no `ports:`. To debug, use `compose exec`.
- **Client-IP premise.** The server runs with `--proxy-headers --forwarded-allow-ips "*"`
  (`deploy/server.Dockerfile`) and `ratelimit.client_ip` uses the `X-Forwarded-For` that arrives. That is
  only safe because Caddy, without `trusted_proxies`, overwrites the header and because only it publishes a port.
  Giving `ports:` to the server, or making Caddy trust a proxy in front, lets anyone forge the IP and
  zeroes the per-IP limits on login, pairing and signup. `deploy/test_compose_prod.py` fails in all three cases.
- **Caddy routes.** `/api/*`, `/media/*` and `/mcp` (exact route) go to the server without stripping the prefix. `/downloads/*` is the
  installers folder ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md)),
  with `Cache-Control: no-cache` on the manifests and hidden files concealed. The rest is the SPA, from the
  image itself: the compose Caddyfile ends with `import /etc/caddy/spa.caddy`, the `handle` without a
  matcher that only catches what is left. No SPA route may start with `/api`, `/media`, `/mcp`
  or `/downloads`.
- **The SPA rules travel with the image** (`deploy/web.Caddyfile`), and the same file serves
  production, staging and e2e: the SPA's CSP, the API reference's (`/referencia-api.html`, with its own
  `style-src`), the long cache of Vite assets only for the file that exists, the `no-cache`
  of `index.html` and the `no-store` of error responses ([frontend-web.md](../standards/code/frontend-web.md)).
  On its own, the image serves the SPA on port 80, without TLS.
- **`mdns` is recreated after `publish-ca`**, and the deploy check requires that
  `/api/v1/server` carry the fingerprint of the published CA. Multicast (5353/udp on the host
  network) depends on the ufw rule in [host-setup.md](host-setup.md#6-firewall).
- **The Caddyfile is an inline `configs.content`.** With a remote daemon, a `file:` would become a bind
  mount of a path on the workstation.
- **The server and edge images live in `deploy/`,** with `<Dockerfile>.dockerignore` beside them
  filtering the root context. One server image serves the API, the CPU worker, `mdns`, the
  migrations and the CLI. It runs as uid 1000 (`HOME=/home/app`). The native `claude` CLI binary, pinned to a
  version, only goes in with `ECLUME_CLAUDE_CLI=1` in `deploy/.env.prod` (build arg; the image default is
  without the CLI, [server-agentes.md](../standards/code/server-agentes.md#deploy)). This production uses
  `ECLUME_CLAUDE_CLI=1`; `deploy.sh` refuses an env that does not declare 0 or 1.
- **Networks by role** (holetz/eclume#94): `borda` (caddy, server); `dados`, internal
  (postgres, redis, minio, server, worker, `minio-init`, `migrate`); `fila-gpu`,
  internal (redis, minio, worker-gpu); `saida` (worker and worker-gpu, which talk
  to providers, Claude and Hugging Face). The GPU worker does not reach Postgres, the server or the edge.
  `publish-ca` runs with `network_mode: none`; `mdns`, on the host network.
- **Credential per service:** server and CPU worker use `eclume-server` on Redis and MinIO; the
  GPU worker uses `eclume-gpu`, which only reads the audio and writes the artifacts. The MinIO root stays in
  MinIO, in `minio-init` and in the backup; the Redis `default` user is disabled
  ([server-nucleo.md](../standards/code/server-nucleo.md#redis-and-minio-credentials)). To
  debug Redis: `compose exec redis sh -c 'valkey-cli --user eclume-server --pass "$ECLUME_REDIS_SERVER_PASSWORD"'`.
- **Least privilege:** the Python containers (server, workers, `migrate`, `mdns`) run with
  `cap_drop: [ALL]` and `no-new-privileges`; Caddy is left as is, because it listens on a low port.
- **Memory limits** on caddy, server, worker, worker-gpu, redis and minio: the `mem_limit` by
  env `ECLUME_MEM_<SERVICE>` (256m, 768m, 2g, 8g, 256m and 512m) and the `memswap_limit` (memory plus
  swap) by `ECLUME_MEMSWAP_<SERVICE>`, defaulting to 1.5 × the ceiling (384m, 1152m, 3g, 12g, 384m and
  768m). Without the `memswap_limit`, each container would use as much again in swap and `docker stats`
  would understate the real usage. The defaults are those of the holetz/eclume#151 review; the right value
  remains the peak × 1.5 from the 24 h `docker stats` measurement. To
  adjust, set the pair in `deploy/.env.prod` and deploy: `deploy.sh` refuses a
  `memswap_limit` smaller than the `mem_limit`, which `up` would refuse in the middle of the deploy. **Names
  from before the single worker:** `ECLUME_MEM_WORKER_AGENTS` still applies to `worker` while the
  env has no `ECLUME_MEM_WORKER`; `ECLUME_MEM_WORKER_CPU` and `ECLUME_MEM_WEB` no longer apply
  (delete them from the env). Postgres has no ceiling: it gets `oom_score_adj: -800` (the host OOM picks
  another first) and `shm_size: 256m`; `mdns` has none either. A container that exceeds the ceiling dies
  inside its own cgroup and `restart` brings it back. `release-desktop.sh` limits the build to
  `ECLUME_BUILD_MEMORY` (6g), next to the 2 CPUs.
- **CPU weight per role (`cpu_shares`, only counts under contention):** 2048 for whoever serves the request
  (caddy, server, postgres), 1024 for support (redis, minio, worker) and 512 for what can
  wait (worker-gpu, whose heavy work is on the GPU, and mdns). The host's gate, staging and backup
  run with 256.
- **Light, spaced-out healthchecks:** `worker` through the probe `python -m eclume_server.sonda fila
  default agents` (stdlib and the Redis client only) and worker-gpu through the heartbeat, every 60 s; the
  server (`/api/v1/health/ready`), Postgres, Redis and MinIO every 30 s. During `start_period`,
  `start_interval` (1 to 2 s) hurries the first `healthy`, so the deploy's `up --wait` does not
  wait a whole interval; `start_interval` needs Docker Engine 25 or newer.
- **Restart `unless-stopped` and rotated logs** (3 × 10 MB per container): the stack comes back
  by itself after a reboot, with nobody running a deploy.

### Data in `/srv/eclume`

| Folder | Content |
|---|---|
| `pg/`, `redis/`, `minio/` | `eclume-prod-*` volumes (bind) of the database, the queues and the objects |
| `caddy/data`, `caddy/config` | **Caddy's internal CA**: deleting it generates a new CA and forces reinstalling the root on every client |
| `models/` | model cache of the GPU worker |
| `downloads/` | desktop installers, `latest.json` and `eclume-root.crt` |
| `secrets/` (700) | `env.prod`, `hf_token`, `admin-password`, updater keys, Android keystore, `restic-password`, `restic-fora.env` and `restic-rclone/` (the rclone configuration of the off-host destination) — all 600 |
| `backups/` | `restic/` (encrypted repository), `minio/.espelho/`, `pre-deploy/`, `backup.log` and `ensaio.log` |
| `estado/` (700) | `backup.json`, `fora.json`, `ensaio.json` (`ok`, `at`, `detalhe` of each nightly step, read by `watchdog.sh`), `secrets.sha256` and `vigia/` |
| `bin/` | `backup.sh`, `restore-backup.sh`, `staging.sh` and `watchdog.sh`, installed by the deploy |

## Deploy

From the development machine, with the `gpu-host` context of the [host runbook](host-setup.md):

```bash
bash deploy/deploy.sh --context gpu-host --generate-env   # once: deploy/.env.prod with random secrets
bash deploy/deploy.sh --plan --context gpu-host
bash deploy/deploy.sh --context gpu-host
bash deploy/bootstrap-admin.sh --context gpu-host --email admin@example.com   # once
```

The scripts have no default context: without `--context` (or `ECLUME_DOCKER_CONTEXT`), they refuse. This
host has a GPU and comes up without `--no-gpu`. `deploy.sh` uses the Docker context for build and bring-up and SSH (the target comes from the
context's `ssh://` endpoint) for what belongs to the host. In order:

1. Before any write to the host, it refuses a dirty working tree, a HEAD that GitHub does not
   have and a HEAD without the host gate's `eclume/gate` = `success` status (`bash deploy/gate.sh`;
   [monorepo.md](../standards/code/monorepo.md)). It also refuses a HEAD outside `origin/main` or
   that does not descend from the SHA in production (the last one in `deploys.log`), unless `--off-main
   "<reason>"` (test branch; the reason goes into the history) or `--rollback` (rollback), and a
   `deploy/.env.prod` that loses or changes a key of the host's copy (below). `--plan` shows, without
   refusing: the SHA in production and the target, how many commits separate them, the pending migrations, the
   env × host, the busy GPU and the gate. It also refuses with the host disk at 90% or more
   (`ECLUME_DISK_LIMIT`), before and after the build.
2. It creates the folders of `/srv/eclume` and an empty `hf_token` if missing. A missing file in a bind
   mount would become a folder.
3. It stores the copy of `deploy/.env.prod` at `/srv/eclume/secrets/env.prod`, installs the backup scripts
   in `bin/` and the `# eclume-backup` line in the crontab.
4. It builds `server`, `caddy` (the `eclume-edge` image, with the SPA) and `worker-gpu` on the host
   daemon from the `git archive` of the SHA in a temporary directory on the workstation — compose,
   Dockerfiles and scripts are those of the SHA, never those of the working tree (`--services` restricts, and
   `web` still works as the old name of `caddy`; `--no-build` skips). Which images the SHA has and
   which services come up come from its compose (`docker compose config` read by `deploy_lib.py
   topology`). An image that is not built now must already be on the host: the first deploy
   of the edge with the SPA builds `caddy`. The build records
   `ECLUME_COMMIT` (`/api/v1/health` returns it as `commit`) and the `:<sha>` tags beside `:prod`;
   the deploy also tags with `:<sha>` the images it did not build, and each deploy leaves a trio. On
   `worker-gpu` only the tag changes: with identical code, the cache returns the same image and the container is not
   recreated.
5. **Busy GPU:** it waits for the heartbeat's `busy` to drop up to `--gpu-wait` (30 min); at the end, it refuses,
   unless `--interrupt-gpu`. SIGTERM drains (the worker finishes the current job).
6. With a pending migration, it writes `pg_dump -Fc` to `/srv/eclume/backups/pre-deploy/` before
   `migrate`; `restore-backup.sh --database <dump> --confirmo` restores only the database from it.
7. `up --wait postgres redis minio` → `run --rm minio-init` → `run --rm migrate` →
   `up --wait server worker worker-gpu` → `up --force-recreate --remove-orphans --wait caddy`.
   The one-shots stay out of `--wait`, which treats exit 0 of a service nobody expects as a
   failure. Caddy is always recreated because compose does not recreate a container when only
   `configs.content` changes. The CA is in the volume and survives. With the new edge up,
   `--remove-orphans` removes the containers of services the SHA's compose no longer has: on the
   first deploy of holetz/eclume#151, `web`, `worker-cpu` and `worker-agents`.
8. It publishes the CA at `/srv/eclume/downloads/eclume-root.crt`, appends a line to
   `/srv/eclume/deploys.log`, applies the retention, prunes the BuildKit cache older than 7 days
   (`docker builder prune --filter until=168h`) and checks the health (with the SHA's `commit`) through the published
   CA.

### One-time cutover from Redis to Valkey

The first deploy of a SHA that carries holetz/eclume#324 replaces the `redis:7-alpine` container
(Redis 7.4.11, RSALv2/SSPLv1) with Valkey. Valkey 9.1 cannot read the data Redis 7.4 left in
`/srv/eclume/redis` (it stops with `Can't handle RDB format version 12`), and that data is
transient: the queues, job progress, the 1-hour chat and preview state and the attempt and quota
windows. So the queue is **drained first, then the old data is set aside**, and only then the deploy
runs:

```bash
P=(docker --context gpu-host compose -p eclume -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod)
bash deploy/deploy.sh --plan --context gpu-host      # the target SHA, the gate and the busy GPU
"${P[@]}" stop caddy                                  # no new uploads or agent requests
# Wait until the three queues are empty and nothing is in progress (repeat until it prints 0 0 0 0):
"${P[@]}" exec redis sh -c 'c() { redis-cli --no-auth-warning --user eclume-server --pass "$ECLUME_REDIS_SERVER_PASSWORD" "$@"; };
  echo $(c zcard eclume:gpu) $(c zcard eclume:default) $(c zcard eclume:agents) $(c --scan --pattern "arq:in-progress:*" | wc -l)'
"${P[@]}" stop redis
ssh <host> 'sudo mv /srv/eclume/redis /srv/eclume/redis.pre-valkey && sudo mkdir /srv/eclume/redis'
bash deploy/deploy.sh --context gpu-host              # brings caddy back with the rest
```

Once the deploy reports healthy, `sudo rm -rf /srv/eclume/redis.pre-valkey` on the host. If the
deploy stops with Valkey unhealthy, `"${P[@]}" logs redis` names the cause; a format error means the
old data is still in place. A `--rollback` to a SHA before holetz/eclume#324 brings Redis 7.4 back on
data it did not write: drain and set `/srv/eclume/redis` aside the same way first (or move
`redis.pre-valkey` back while it still exists). The workers and the server need no change: the
protocol, arq, the ACL users and every key stay the same.

### Tracing, retention and rollback

- **What is in production** comes from three places that agree: `GET /api/v1/health` (`commit`),
  the tags `eclume-{server,edge,worker-gpu}:<sha>` (`eclume-web` instead of `eclume-edge` in deploys
  before holetz/eclume#151) and `/srv/eclume/deploys.log` (TSV: date, SHA, flags, reason,
  applied migrations and the pre-deploy dump).
- **Retention:** the host keeps the image trio and the dump of the last 3 distinct deploys
  (`ECLUME_DEPLOYS_KEPT`); tags outside the window are removed, from the new trios (`edge`) and the old ones
  (`web`), and `image prune` only takes what is left without a tag (label `org.eclume.image`: `server`,
  `edge`, `web`, `worker-gpu`).
- **`bash deploy/deploy.sh --context gpu-host --rollback <sha>`** brings up the retained trio of that deploy,
  without build and without migrate (`deploy_lib.py voltar` decides), with the compose of that SHA: going back
  to a SHA before holetz/eclume#151 brings `web`, `worker-cpu` and `worker-agents` up again, with
  plain Caddy, and `--remove-orphans` removes the single `worker`. One step back works even with a new
  migration, by the expand/contract rule
  ([server-nucleo.md](../standards/code/server-nucleo.md)); more than one step with migrations the
  target does not know refuses and points to the pre-deploy dump to restore the database first.
- **Test branch** is `--off-main "<reason>"`; the next `main` deploy requires descending from
  what is in production, so go back to `main` with `--rollback` or with a `main` commit that already
  contains the branch.

### Gate and waiver

A push to `main` fires the gate on the host by itself (hook `.githooks/pre-push`); check with
`bash deploy/gate.sh --status` before the deploy. A test branch needs the gate on its own SHA:
publish the branch and run `bash deploy/gate.sh` on it (about 40 minutes on the host), or waive.
The waiver is `bash deploy/deploy.sh --context gpu-host --skip-gate "<reason>"`: it holds only for that
invocation, waives only the status (clean tree and commit on GitHub are still required) and leaves on the
commit the status `eclume/gate-dispensa` with the reason. Use it only in an emergency — a production
fix that cannot wait for the gate, or the gate broken by something outside the code (host, image,
network) — and run the gate on the same SHA right afterwards.

### Secrets

`deploy/.env.prod` (600, in `.gitignore`) comes from `deploy/.env.prod.example` through
`--generate-env`, with `openssl rand`; `--generate-env` refuses when the host already has
`secrets/env.prod` (the deploy restores that copy in a checkout without an env). The deploy compares the local
env with the host's copy **by key** — the host sends only the sha256 of each value — and refuses
when a host key is missing or changed; a key new only locally passes. `--replace-env` accepts
the swap and first stores `secrets/env.prod.<date>`. Passwords are hex, because they go into the DSN unescaped, and
`ECLUME_ENCRYPTION_KEY` is the base64 of 32 bytes. The deploy refuses while there is a `=troque-`.
Without the file in the checkout (another machine, another worktree), the deploy restores it from the host's
copy.

| Variable | Note |
|---|---|
| `ECLUME_PG_PASSWORD` | of the `eclume` superuser (migrator); only applies at volume creation; to change it later, `ALTER USER eclume PASSWORD '…'` before changing the env |
| `ECLUME_RUNTIME_PG_PASSWORD` | of the `eclume_server` role, the connection of the server and the CPU worker. `migrate` applies it on every deploy, so changing it means changing the env and deploying. An env from before it gets one generated by `deploy.sh` itself (append, without touching the rest) |
| `ECLUME_MINIO_USER`, `ECLUME_MINIO_PASSWORD` | MinIO root: only MinIO, `minio-init` and the backup scripts use it |
| `ECLUME_MINIO_SERVER_PASSWORD`, `ECLUME_MINIO_GPU_PASSWORD` | of the MinIO users `eclume-server` and `eclume-gpu`; `minio-init` applies them on every deploy, so changing means changing the env and deploying. An env from before them gets them generated by `deploy.sh` (append), with a warning in `--plan` |
| `ECLUME_REDIS_SERVER_PASSWORD`, `ECLUME_REDIS_GPU_PASSWORD` | of the users `eclume-server` and `eclume-gpu` in the Redis ACL; the ACL is recreated with the Redis container on deploy. Generated by `deploy.sh` when missing, like MinIO's |
| `ECLUME_MEM_<SERVICE>`, `ECLUME_MEMSWAP_<SERVICE>` | optional: memory ceiling and memory-plus-swap ceiling of each service, which go up together (see Stack) |
| `ECLUME_REDIS_MAXMEMORY` | optional (`160mb`): Redis `maxmemory` with `noeviction`, below `ECLUME_MEM_REDIS`; at the ceiling Redis refuses writes instead of evicting queue keys or dying from the OOM. Raise both together |
| `ECLUME_AGENT_MAX_JOBS` | optional (2): slots of the `eclume:agents` queue in `worker` |
| `ECLUME_JOB_GRACE_SECONDS`, `ECLUME_JOB_STALL_SECONDS` | optional (120 and 1800): dead-job detection ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#dead-job)) |
| `ECLUME_KEEP_ASR_RESIDENT`, `ECLUME_RESIDENT_MIN_FREE_MB`, `ECLUME_MODEL_IDLE_SECONDS` | optional (1, 2500, 300): ASR resident between jobs in the GPU worker ([worker-gpu.md](worker-gpu.md)) |
| `ECLUME_SECRET_KEY` | signs the part and audio URLs; changing it invalidates those in circulation |
| `ECLUME_ENCRYPTION_KEY` | encrypts the providers' API keys and the admin panel secrets; the GPU worker receives the same one, to open the HF token that arrives encrypted in the job; changing it forces re-registering them ([server-agentes.md](../standards/code/server-agentes.md), [server-admin.md](../standards/code/server-admin.md)) |
| `ECLUME_PUBLIC_URL` | `https://192.168.15.199:8443`, the base of the URLs returned to the client |
| `ECLUME_SIGNUP_OPEN` | `true` (default): anyone on the LAN creates an account through `POST /api/v1/auth/signup`, accepting the notice. `false` closes signup without a code deploy: change the env and recreate the server (`bash deploy/deploy.sh --context gpu-host --no-build`) |
| `ECLUME_SIGNUPS_PER_IP_PER_DAY` | `5` (default): ceiling of accounts created per IP in 24 h, besides the per-minute ceiling. After the quota deploy (holetz/eclume#98), the owner overrides the quotas of her own account in Admin → Usuários |
| `ECLUME_CLAUDE_CLI` | required, `0` or `1`: the build arg that puts the `claude` CLI in the server image. This production uses `1` (`claude-cli` is its provider); `0` builds the image with free software only and `claude-cli` fails with `provider_not_configured` |
| `ECLUME_CLAUDE_OAUTH_TOKEN` | optional: long-lived Claude token (`claude setup-token`, 1 year), delivered to `worker` as `CLAUDE_CODE_OAUTH_TOKEN`. The normal path is the token in the panel (below), which wins over this one; with neither, `claude-cli` fails with `provider_not_configured`. **Do not mount** the host's `~/.claude/.credentials.json`: the OAuth renewal diverges in the bind mount ([server-agentes.md](../standards/code/server-agentes.md#deploy)) |

### Admin, accounts and provider

There is no organization: each user account is isolated by the owner's RLS, and the panel belongs to the
**platform**. The **administration panel** is at
**`https://192.168.15.199:8443/admin/entrar`**: there is no link to it in the user's app. The **admin account** (`admins`) is separate from the user accounts, with its own login and
session at `/admin/entrar`, which only reach `/admin/*`
([server-admin.md](../standards/code/server-admin.md)).

- **User accounts** are born through open signup (`POST /api/v1/auth/signup`; the web's Criar
  conta screen), accepting the consent notice. There is no invitation or user CLI; the admin only activates or deactivates accounts in
  Admin → Usuários. `ECLUME_SIGNUP_OPEN=false` closes signup.
- **Admin account.** `bootstrap-admin.sh` (through the `migrate` one-shot, with the superuser) creates the
  admin account `admin@example.com` through `eclume-server admin create`. The password is
  generated on the host and stays **only** in `/srv/eclume/secrets/admin-password` (600). It reaches the CLI
  through a pipe (`--password-stdin`) and is never written on the workstation. With any admin account in the
  database, the script does nothing.
- **Organization migration (008, holetz/eclume#32).** The old users became
  independent accounts, with the owner's recordings, people, collections and templates. Each old admin got
  an admin account with the **same e-mail and the same hash**: the `admin-password` password works in
  both until someone changes one of them.
- **Changing the admin password** (ends its sessions):
  `ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password | "${P[@]}" run --rm -T migrate eclume-server admin set-password --email admin@example.com --password-stdin`
  (write the new password to the file first; `P` as in Operation). A user account's password is changed in the app.

This production's provider is `claude-cli` ("Claude (servidor)", model `sonnet`), a choice
of this host and not of the product: it runs `claude -p` in the agents worker, in the image built with
`ECLUME_CLAUDE_CLI=1`, with the token delivered by the panel or the env, without mounting the host's
credential. The matrix of what each type requires is in [server-agentes.md](../standards/code/server-agentes.md#what-each-provider-requires).
The smoke does not register a provider: it proves the summary with whatever is registered for `summaries`, of
any type, or with the one in `--provider <id>`.

**Pending decision (holetz/eclume#129, task 5.3):** whether Anthropic's terms allow a
subscription's token to serve eclume's accounts. Until the owner records the decision here,
`claude-cli` remains this production's provider; the switch is re-registering the provider in the panel.

**Claude token.** On a computer with Claude Code logged in to the subscription, `claude setup-token`
opens the authorization in the browser and prints the token (`sk-ant-oat01-…`). Register it in the panel:
**Admin → Agentes → Claude (servidor) → Editar → Token do Claude**. It is stored encrypted in the database and
wins over the env's `ECLUME_CLAUDE_OAUTH_TOKEN`, which remains as an alternative for operating without the panel. The
token lasts 1 year and is not renewed: generate another before it expires (the symptom is the summary failing with
`provider_auth` in the admin's Saúde). The panel records the registration date (`key_set_at`), and
`eclume-server saude --json` reports the expiry (`claude_token.days_left`); `watchdog.sh` warns
at 30 days or less. A token only in the env has no date: the watcher warns once "validade desconhecida".

On a Windows station ([estacao-windows.md](estacao-windows.md)), `.gitattributes` keeps the
scripts with LF in any checkout. Without `flock`, the lock becomes the directory `deploy/.deploy.lock.d`.

## Validate

**Proofs that write run on staging, never on production** (holetz/eclume#91). The
`eclume-staging` is an ephemeral compose project on the host (`deploy/docker-compose.staging.yml`), with the
`main` code and the data of the latest backup restored from the off-host repository, Caddy only on
`https://127.0.0.1:18444`, CPU transcription and no mDNS. `staging.sh up` brings it up with a
throwaway account (admin and user with the same e-mail, in `~/eclume-staging/conta`) and its CA in
`~/eclume-staging/ca/ca.crt`; `staging.sh down` deletes it (`down -v`). From the workstation, the tunnel
`ssh -L 18444:127.0.0.1:18444` reaches it.

```bash
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh up
ssh holetz@192.168.15.199 cat eclume-staging/ca/ca.crt > /tmp/staging-ca.crt
ssh -f -N -L 18444:127.0.0.1:18444 holetz@192.168.15.199
ssh holetz@192.168.15.199 "sed -n 's/^ECLUME_PASSWORD=//p' eclume-staging/conta" \
  | python3 deploy/smoke_prod.py --ca /tmp/staging-ca.crt --email staging@eclume.invalid
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh down
```

**On production, read-only:** `smoke_prod.py --read-only` (health, SPA, `/downloads/`, signup
and admin session) and the administration panel (`e2e-prod/admin.spec.ts`). Without
`--read-only`, the smoke refuses the production URL with exit 2 (`https://192.168.15.199:8443` or
`ECLUME_PUBLIC_URL`) before any request; `prova.spec.ts`, `producao.spec.ts` and
`mobile/e2e/prove.mjs` refuse the same way.

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/downloads/eclume-root.crt > /tmp/eclume-root.crt
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | python3 deploy/smoke_prod.py --url https://192.168.15.199:8443 --ca /tmp/eclume-root.crt --read-only
```

`smoke_prod.py` uses only the standard library. It checks health, the SPA (the routes' `index.html`
without long cache), the `404` without `immutable` of a nonexistent `/assets/*` (the chunk of an earlier
deploy must not come back as an `index.html` cached for a year), `/downloads/latest.json`
and open signup with the notice, signs in through the admin session (picks the already-registered summaries provider, registering none;
it fails saying what to register if there is none) and the user one, with the same e-mail and the same password (`--admin-email` and `ECLUME_SMOKE_ADMIN_PASSWORD`
when they differ), and sends `worker-gpu/tests/fixtures/two-voices.ogg` through the multipart
upload. Then it waits for the transcription with 2 speakers and a `done` summary. On that recording,
it proves the summary-centered recording (holetz/eclume#34): edits the summary by hand (`manual` version),
asks the chat "Diga quem fala primeiro na reunião e acrescente isso no início do resumo" and waits for the
`done` reply with a non-empty `reads` and a `chat` version (the chat time goes in the log), goes back to the
generated one, records 2 markers, finds the recording in its day's library with `kind=meeting` and downloads
the four export formats checking the `Content-Type` and the DOCX `PK` signature. At the end, it
prints `OK`. An audio already uploaded returns `deduplicated`, and the smoke checks the transcription that already
exists; each round adds versions and markers to the same recording.

**Automatic processing** (`--pipeline`, on staging): retranscribes a recording and waits for the six pipeline steps
`done` (received, preprocessing, transcription, fields, agenda type and summary), with the
duration of each, the automatic fields, the detected type and the automatic summary. A step
`failed` or `skipped` fails the smoke. Without `--recording`, the recording is the fixture audio's:

```bash
ssh holetz@192.168.15.199 "sed -n 's/^ECLUME_PASSWORD=//p' eclume-staging/conta" \
  | python3 deploy/smoke_prod.py --ca /tmp/staging-ca.crt --email staging@eclume.invalid --pipeline --recording <id of a restored recording>
```

**Administration panel in the browser** (`npm --prefix web run test:e2e:prod`, read-only, in the
workstation's Chrome): signs in with the admin account, walks through the seven screens with real data, waits for the
second Saúde reading within 17 s, checks `/admin/voz` → Locutores, that the admin session gets
401 on `GET /api/v1/me` and that logout closes the session. Screenshots go in
`web/test-results/prod/`. The default is Google Chrome; on a station without it, `E2E_CHANNEL=msedge`
uses Edge.

```bash
ECLUME_PROD_URL=https://192.168.15.199:8443 ECLUME_ADMIN_EMAIL=admin@example.com   ECLUME_ADMIN_PASSWORD="$(ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password)"   npm --prefix web run test:e2e:prod
```

**Library and recording in the browser** (`web/e2e-real/producao.spec.ts`, in the host's Google Chrome,
against staging): with the throwaway account, checks through the admin panel (same password) that there is a provider for summaries and
chat, imports an M4A through the modal and checks the date read from the metadata, finds the event on Monday
21/09/2026 at 09:00, waits for the pipeline until "Resumo pronto", edits the summary, asks the
chat for an adjustment, downloads the DOCX (`PK` signature) and deletes the proof recording. The screenshots, light and dark,
stay on the host in `~/build/<folder>/test-results/prod/`.

```bash
remote-run . 'ffmpeg -loglevel error -y -i worker-gpu/tests/fixtures/two-voices.ogg -c:a aac -metadata creation_time=2026-09-21T12:00:00Z /tmp/eclume-prova.m4a && npm --prefix web ci && . ~/eclume-staging/conta && ECLUME_E2E_EMAIL="$ECLUME_EMAIL" ECLUME_E2E_PASSWORD="$ECLUME_PASSWORD" ECLUME_E2E_AUDIO=/tmp/eclume-prova.m4a npx --prefix web playwright test -c web/playwright.real.config.ts producao.spec.ts'
```

**MCP and pairing** (`deploy/smoke_mcp.py`, with the `mcp` SDK, so through `uv run`): checks that the
descriptor carries the given CA's fingerprint, creates a 1-hour read PAT, and the real MCP client
lists the 9 tools, searches and reads a recording and has the deletion refused for lack of
`recordings:delete`; then it generates a pairing code, exchanges it for a device
credential and checks the `used` state. It revokes what it created. Discovery is proven from the workstation:

```bash
ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
  | uv run python deploy/smoke_mcp.py --ca /tmp/eclume-root.crt
uv run eclume-server discover --timeout 10
```

**Web proof** (`bash deploy/prove-web-prod.sh`, `web/e2e-prod/prova.spec.ts`, in the workstation's Chrome
or with `E2E_CHANNEL=msedge`, against staging through the tunnel the script opens): signs in through the screen
with the throwaway account (read from `~/eclume-staging/conta` on the host),
creates a temporary field, tests the rule on the latest recordings and deletes it; generates the link
code in App desktop and checks that the countdown starts between 9:55 and 10:00 and goes down; reads the App móvel QR in the
browser itself (SVG → `<canvas>` → `jsqr`) and checks the `pair_url` against the screen's code; checks the
MCP address against `GET /api/v1/server`, creates a read-only token and revokes it in Tokens de
acesso; searches "token" in the help center and opens the article; and opens the help drawer in Pessoas. It ends
with `OK`, no page error, and leaves the screenshots in `web/test-results/prod/`. The generated link
codes expire by themselves in 10 minutes.

```bash
ECLUME_PROD_SSH=holetz@192.168.15.199 bash deploy/prove-web-prod.sh
```

## Connect an assistant (MCP)

1. On the web, create a token in **Conexão MCP** (or in Tokens de acesso) with the scope groups
   the assistant needs ([groups](../standards/code/server-mcp-e-dispositivos.md#scope-groups-of-the-mcp-connection-screen))
   and the validity; the `eclp_…` secret appears once.
2. In the MCP client, register a streamable HTTP server at `https://192.168.15.199:8443/mcp`
   with the header `Authorization: Bearer eclp_…`. Claude Code example:
   `claude mcp add --transport http eclume https://192.168.15.199:8443/mcp --header "Authorization: Bearer eclp_…"`.
3. The client must trust the internal CA (the section below); Claude Code and other Node
   clients accept `NODE_EXTRA_CA_CERTS=/path/eclume-root.crt`.
4. Revoking the token on the web turns the assistant off. The admin's Saúde shows how many assistants
   used MCP in the last 24 h.

## Root CA on the clients

HTTPS is mandatory for the microphone and for media conversion in the browser. The root is at
**`https://192.168.15.199:8443/downloads/eclume-root.crt`** (a single certificate, the active CA's
root). It is distinct from lumea's. The apps (desktop and phone) **do not** use the system
store: they pin the root on their own, by fingerprint, on first run or at
pairing ([server-mcp-e-dispositivos.md](../standards/code/server-mcp-e-dispositivos.md#ca-pinning-by-the-apps)).
Only the browser, Claude Desktop/Code (MCP) and lumea need the root installed.

eclume's own root (`ECLUME_TLS_CA=eclume`) has a critical name constraint: it is only valid for the
IP of `ECLUME_PUBLIC_HOST` and the names in `ECLUME_CA_NAMES` (currently `workstation.local`), and only for TLS
server. Installing it on a station does not let anyone impersonate another site with it. The key
stays in `/srv/eclume/secrets/ca/` (the deploy generates it once and never overwrites it; it goes into the backup
of `secrets/`). Caddy's `local` root, from earlier installs, has no constraint and goes out in the
rotation below.

- **First download** (before trusting): `curl -k -o eclume-root.crt https://192.168.15.199:8443/downloads/eclume-root.crt`,
  or `scp holetz@192.168.15.199:/srv/eclume/downloads/eclume-root.crt .`. Check the fingerprint
  against the host:
  `openssl x509 -noout -fingerprint -sha256 -in eclume-root.crt`.
- **Linux:** `sudo cp eclume-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
- **Windows:** `certutil -addstore -f Root eclume-root.crt`, as administrator.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** import in Settings → Certificates, because it uses its own store.
- **lumea:** mount the PEM in the `api` container and point `LUMEA_ECLUME_CA_BUNDLE` to it, with
  `LUMEA_ECLUME_URL=https://192.168.15.199:8443` (lumea's `deploy/.env.remote`).
- **Proof of the constraint** on a station: `bash deploy/prove-restricted-ca.sh` generates a
  throwaway root for `127.0.0.1`, brings up `127.0.0.1:18445` (inside) and `127.0.0.2:18446` (outside) and checks
  `curl`; with the throwaway root installed, Chrome, Edge and Firefox open the first and refuse the
  second. Remove the throwaway root afterwards (the script prints the command).

### Rotation to the restricted root

Three steps, each with a check. The order matters: the apps only cross the switchover by themselves if
they have already stored the next root.

1. **Announce.** With the desktop and phone that carry the next root (holetz/eclume#101)
   published and installed, do the ordinary deploy (`ECLUME_TLS_CA` absent or `local`). The deploy
   generates `/srv/eclume/secrets/ca/raiz.crt` and `raiz.key` if missing, `publish-ca` publishes the own
   root at `/downloads/eclume-root-proxima.crt`, and the descriptor starts carrying
   `ca_next_sha256`; `--plan` shows the active and the next CA, and the end of the deploy checks the
   announcement. Also check:
   `curl -fsS --ssl-no-revoke --cacert eclume-root.crt https://192.168.15.199:8443/api/v1/server`
   (carries `"ca_next_sha256":"<64 hex>"`). The apps store the next one on the probe (phone) or within
   6 h (desktop).
2. **Switch**, on the decided date. Beforehand, install the next root
   (`https://192.168.15.199:8443/downloads/eclume-root-proxima.crt`) on the stations, in lumea and in the
   MCP clients, **beside** the current one. During the window, whoever uses a PEM bundle gets both
   roots in one file: `cat eclume-root.crt eclume-root-proxima.crt > eclume-raizes.pem`, for
   `LUMEA_ECLUME_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` (Claude Desktop/Code). Then put
   `ECLUME_TLS_CA=eclume` in `deploy/.env.prod` and deploy: Caddy issues from the own root,
   `publish-ca` publishes the own one as `eclume-root.crt` and deletes the next one, and the end of the deploy
   checks that the published one is the own root. Then change the variable
   `ECLUME_SERVER_CA_SHA256` to the new fingerprint and ship a desktop release
   ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md#server-embedded-in-the-installer)):
   the old installers in `/downloads` embed the old fingerprint. Check desktop and phone
   syncing without a new sign-in; whoever fell behind signs in or pairs again.
3. **Retire**, after the window: remove the old root from the stations, lumea and the MCP clients
   (the bundle goes back to having only the new one) and delete the `local` root from the host:
   `ssh holetz@192.168.15.199 'sudo rm -rf /srv/eclume/caddy/data/caddy/pki/authorities/local'`.
   Check: `ssh holetz@192.168.15.199 '! sudo test -e /srv/eclume/caddy/data/caddy/pki/authorities/local/root.key'`.
   With `eclume` active, Caddy does not recreate `local`.

The deploy refuses `ECLUME_TLS_CA=eclume` without the own root when a root is already published:
switching without announcing would change the root of whoever trusts the current one.

## Backup and restore

**Schedule: cron of the `holetz` user.** It has no linger, so a user systemd timer
would not run outside a session. `deploy.sh` installs the scripts in `bin/`, generates
`secrets/restic-password` and initializes the local repository the first time, and writes the two lines:

```
30 3 * * * ECLUME_DATA_DIR=/srv/eclume /srv/eclume/bin/backup.sh >> /srv/eclume/backups/backup.log 2>&1 # eclume-backup
30 4 * * * ECLUME_DATA_DIR=/srv/eclume /srv/eclume/bin/staging.sh rehearse >> /srv/eclume/backups/ensaio.log 2>&1 # eclume-rehearsal
```

**Encrypted restic snapshot, in two repositories.** `backup.sh` runs restic (official image
pinned by digest, in a container as root with the sources read-only) and writes a snapshot to
`backups/restic` (the local one, for logical error) and copies it (`restic copy`) to the **off-host**
repository, described in `secrets/restic-fora.env` (`RESTIC_REPOSITORY` and the destination's credential; S3,
B2, `rest-server`, `rclone:` or another that restic speaks), with the same password (`secrets/restic-password`). Both
stay out of the snapshot (it would be circular): **the off-host copy of each is the owner's**, in a vault. The
off-host repository is created once with `restic init --copy-chunker-params` from the local one, so
deduplication works on the copy. In this production, the destination is the owner's OneDrive, through rclone (below).

| In the snapshot (`/eclume/…`) | What it is |
|---|---|
| `pg/roles.sql` | `pg_dumpall --roles-only` (`eclume_app` belongs to the cluster, not the database) |
| `pg/eclume.dump` | `pg_dump -Fc eclume` |
| `pre-deploy/` | the dumps from before the migrations (holetz/eclume#92) |
| `minio/` | the bucket mirror (`backups/minio/.espelho`, `mc mirror --remove`) |
| `caddy/data/caddy/pki/` | Caddy's internal CA, with `root.key` |
| `secrets/` | `env.prod` (with `ECLUME_ENCRYPTION_KEY`), `admin-password`, `hf_token`, updater key and password, Android keystore and password — except `restic-*` |

The dumps exist in the clear only in a temporary folder during the run; only the bucket mirror stays in the clear
(the recordings are already in MinIO on the same disk). Retention: **7 dailies** (`KEEP`,
`forget --keep-daily 7` every day and `prune` only on Sundays, the `--prune` of the same `forget`) in both
repositories. The host is also CI and staging, so every backup container carries `--cpu-shares 256`
and `GOMAXPROCS=1` (restic and mc) and `restic backup` reads with `--read-concurrency 1`; `backup.sh`
rotates `backup.log` and `ensaio.log` to `<name>.log.1` on reaching 5 MB (`ECLUME_LOG_MAX_KB`),
keeping one generation. **Deletion window:** a deleted recording
vanishes from the bucket at once, but survives in the snapshots — local and off-host — for up to 14
days, and in the `pre-deploy/` dumps for as long as they are kept. The 14 days also bound the audio
removed by the audio retention policy: the next daily backup drops the object from the mirror
(`mc mirror --remove`), the last snapshot that holds it is at most one day older than the
deletion, `forget --keep-daily 7` releases it once seven newer daily snapshots exist (at most 7
days later), and the Sunday `prune` frees the space (at most 7 days after that). No snapshot is
rewritten on deletion. Each step writes
`estado/backup.json`, `estado/fora.json` and `estado/ensaio.json` (`ok`, `at`, `detalhe`), which
`watchdog.sh` reads, and the backup writes `estado/secrets.sha256` (sha256 of `secrets/` and the PKI in the snapshot).
`deploy.sh --plan` shows the age of each step's last `ok`.

**Nightly rehearsal** (`staging.sh rehearse`, at 04:30): restores the most recent snapshot **from the
off-host repository** into `eclume-staging`, applies `main`'s `migrate` over the restored database and runs
`smoke_prod.py` against it. It also checks what the smoke does not see: the sha256 of the restored `secrets/` and PKI
against `estado/secrets.sha256`, the fingerprint of the restored root against
`downloads/eclume-root.crt`, the `content_hash` of a batch of 20 restored audios and
`restic check --read-data-subset` of a rotating 1/7 of the off-host repository. It always exits with `down -v`;
refuses with the disk at 90% or more. A failure leaves `estado/ensaio.json` with `ok: false` and the reason.

The rehearsal is **proportional**. On Sundays (or with `ECLUME_REHEARSAL_DAY=7`) it is the **full** one: the
whole snapshot, the audio batch checked over the restored bucket and the summary and chat smoke
(which spends the Claude quota). On other days it is the **partial** one: it restores only `pg/`, `secrets/` and
`caddy/` plus the batch's audios, drawn from the restored database, and runs the `--read-only` smoke;
`estado/ensaio.json` says "ensaio parcial". The images `eclume-server:<sha>` and `eclume-edge:<sha>`
(or `eclume-web:<sha>`, before holetz/eclume#151) that the deploy retained for `main`'s SHA
are reused, without build; only what is missing is built (and, in the full one, the retained server's image needs
`claude`, otherwise the server is rebuilt). Staging brings up every long-running service of
`main`'s compose, with no fixed list: the edge with the SPA and the single CPU worker, as in production. Every staging container carries `--cpu-shares 256` (the services, through a
`~/eclume-staging/cpu-shares.yml` generated on every run) and restic and mc, `GOMAXPROCS=1`. The
`up` is always the full restore.

```bash
ssh holetz@192.168.15.199 /srv/eclume/bin/backup.sh                    # backup now
ssh holetz@192.168.15.199 /srv/eclume/bin/staging.sh rehearse            # rehearsal now
ssh holetz@192.168.15.199 /srv/eclume/bin/restore-backup.sh --test   # proves the most recent, on the host
ssh holetz@192.168.15.199 /srv/eclume/bin/restore-backup.sh --apply 2026-09-25 --confirmo
```

- **`[--repository local|fora] --test [<snap>]`** restores the snapshot (default `latest`; also the
  restic id or the date YYYY-MM-DD) into a temporary folder, the dump into a database `eclume_restore_teste` and the
  bucket into an `eclume-restore-teste`. Then it compares the counts (users, recordings,
  transcriptions, summaries and objects) with production and deletes everything.
- **`[--repository local|fora] --apply <snap> --confirmo`** validates the dump and restores it into a temporary
  database (`eclume_restore_novo`) before stopping anything; only then does it stop server and workers
  and swap the `eclume` database for the temporary one. Then it mirrors the snapshot's bucket back, without deleting objects
  that are not in the backup, and brings the services up.
- **`--database <dump> --confirmo`** returns only the database to a `pre-deploy/` dump (holetz/eclume#92).
- **Prior validation (`--database` and `--apply`).** The script runs `pg_restore --list` and restores the
  dump into a temporary database with the services still up. A truncated or corrupt dump refuses the
  restore with `FALHA`, deletes the temporary one and leaves the `eclume` database and the services as they were.
  If the rename swap fails after the stop, the old database (`eclume_antes`) gets its name back and the
  services come up. It requires space for a second copy of the database during the restore.

**New host.** All that is needed is the repository password and the destination credential, taken from the vault:

1. Write `/srv/eclume/secrets/restic-password` and `/srv/eclume/secrets/restic-fora.env` (700/600).
2. `restore-backup.sh --new-host /srv/eclume` returns `secrets/` (with `env.prod`) and Caddy's
   PKI in `caddy/data/caddy/pki`, **before** the first deploy, to keep the clients' CA.
3. Run the deploy (with the restored `env.prod` as `deploy/.env.prod`) and then
   `restore-backup.sh --repository fora --apply latest --confirmo`.

With the destination on OneDrive, the credential does not go to the vault: step 1 includes authorizing rclone
again on the new host, as below, because the owner's account is the credential.

**Off-host destination on OneDrive (rclone, since 2026-10-08).** `restic-fora.env` is
`RESTIC_REPOSITORY=rclone:eclume-onedrive:eclume-restic`, a folder in the owner's personal OneDrive,
chosen by her in place of B2. The restic image does not carry the `rclone` that this backend calls, and
so `backup.sh`, `staging.sh` and `restore-backup.sh` mount two items:

- the static binary from the `rclone/rclone` image pinned by digest (`RCLONE_IMAGE`), through a volume
  `eclume-rclone-<digest>` that Docker fills on the first mount;
- the configuration from `secrets/restic-rclone/`, writable because rclone renews the OAuth token every
  hour. It rewrites the file as root, and so the configuration can only be read through a container.

The authorization is eclume's own, separate from the host's personal rclone: one refresh token used in
two places can be invalidated by Microsoft. The `eclume-restic/` folder is excluded from the personal
bisync filter (`~/.config/rclone-bisync-onedrive-<owner>.filters`), which mirrors the OneDrive root.
To authorize, or to reauthorize with `config reconnect eclume-onedrive:` in place of
`config create …` after an `invalid_grant` in `backup.log`, run from the workstation. The tunnel carries the
OAuth port 53682 to the host, and the workstation's browser opens the link `http://127.0.0.1:53682/auth?…`
that rclone prints:

```bash
ssh -t -L 53682:127.0.0.1:53682 holetz@192.168.15.199 \
  'install -d -m 700 /srv/eclume/secrets/restic-rclone && docker run --rm -it --network host \
     -v /srv/eclume/secrets/restic-rclone:/config/rclone rclone/rclone:1.75.1 \
     config create eclume-onedrive onedrive'
```

## Operation

```bash
P=(docker --context gpu-host compose -p eclume -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod)
"${P[@]}" ps --all
"${P[@]}" logs -f --tail 100 worker-gpu
"${P[@]}" exec postgres psql -U eclume eclume
"${P[@]}" run --rm -T migrate eclume-server admin create --email <e-mail> --name "<name>" --password-stdin
bash deploy/deploy.sh --context gpu-host --services "server caddy"   # only server and web code (the edge)
```

- **Expired Claude token:** the summary fails with `provider_auth`. Generate another with
  `claude setup-token` and register it in the panel, as in [Admin, accounts and provider](#admin-accounts-and-provider);
  nothing is mounted from the host and no service needs to restart.
- **Stalled transcription job:** the CPU worker by itself marks as a recoverable failure (`worker_lost`,
  `job_lost`, `job_stalled`) the job the GPU worker abandoned; the owner retranscribes or the admin uses
  "Tentar de novo" in Saúde ([jobs-transcricao.md](../standards/api/jobs-transcricao.md#dead-job)).
- **Staging** (`eclume-staging`, 127.0.0.1:18444): `staging.sh up` for the proofs,
  `staging.sh down` afterwards; the nightly rehearsal brings it up and down by itself. Rehearsal failure: see
  `estado/ensaio.json` and the end of `backups/ensaio.log`.
- **Web E2E against the real backend** in an ephemeral stack, without touching production:
  `remote-run . 'bash deploy/e2e-real.sh'` ([frontend-web.md](../standards/code/frontend-web.md)).
- **Hugging Face token:** write it in Administração → Locutores (wins over the file) or change
  `/srv/eclume/secrets/hf_token` (600). The worker rereads it on every job, without restarting
  ([worker-gpu.md](worker-gpu.md)).
- **Desktop installers:** `deploy/publish-desktop.sh` writes to `/srv/eclume/downloads/`,
  which Caddy already serves ([host-setup.md](host-setup.md), installers section). Since 0.2.0,
  the release embeds the address and the CA fingerprint of this server (variables
  `ECLUME_SERVER_URL` and `ECLUME_SERVER_CA_SHA256`): changing the root CA (the switchover of the rotation above)
  or the address requires updating the variables and shipping a new release
  ([desktop-distribuicao.md](../standards/code/desktop-distribuicao.md#server-embedded-in-the-installer)).
  Publishing is `bash deploy/release-desktop.sh --publish --notes "<text>"` (compiles on the host, without
  Actions; `--plan` beforehand shows what would go out) and, with the release created,
  `ssh holetz@192.168.15.199 'bash -s -- desktop-v<version>' < deploy/publish-desktop.sh`.
- **Logs:** one JSON line per record (`ts`, `level`, `logger`, `msg` and, when present,
  `request_id`, `recording_id`, `revision`, `job_id`); every API response carries `X-Request-ID`.
  To follow a request or a job:
  `"${P[@]}" logs --no-log-prefix server | grep '"request_id": "<id>"'` (or `"recording_id": "<id>"`
  in the workers). Fields and what never goes in are in
  [server-nucleo.md](../standards/code/server-nucleo.md#logs).
- **Health and readiness:** `/api/v1/health/ready` returns 503 naming Postgres, Redis or MinIO as down, and is
  the `server` healthcheck; the workers have a healthcheck through the queues' heartbeat keys
  (`"${P[@]}" ps` shows `unhealthy`). The admin Saúde numbers from the terminal:
  `"${P[@]}" exec server eclume-server saude --json`.
- **Alerts (`watchdog.sh`):** the `# eclume-watchdog` cron runs `/srv/eclume/bin/watchdog.sh` every 5 min
  (`deploy.sh` installs it). It warns when: disk ≥ 85%; backup, off-host copy or rehearsal without
  `ok` for more than 26 h (`estado/*.json`; without them, the last `ok:` line of `backup.log`);
  a container of the `eclume` project `unhealthy`, restarting or stopped in two consecutive rounds; a job
  in the GPU queue for more than 2 h; 3 or more failures in 24 h or any `provider_auth`; Claude
  token expiring in 30 days; `nvidia-smi` failing or no GPU worker heartbeat; `saude --json`
  not responding. Each alert goes out once, repeats every 6 h and sends the back-to-normal notice;
  state in `/srv/eclume/estado/vigia/`. Limits per environment (`WATCHDOG_DISK_PCT`,
  `WATCHDOG_BACKUP_HOURS`, `WATCHDOG_TOKEN_DAYS`, `WATCHDOG_REPEAT_HOURS`; the `VIGIA_*` names are still read). To see without sending:
  `ssh holetz@192.168.15.199 /srv/eclume/bin/watchdog.sh --simulate`. **Channel:** not yet decided
  (holetz/eclume#93, task 5.3); until then the alerts go to `estado/vigia/alertas.log` and to the
  syslog (`journalctl -t eclume-watchdog`).
- **Disk:** `deploy.sh` shows the usage in `--plan`. To free space, run
  `docker --context gpu-host builder prune -f --filter until=720h`; never do `image prune -a`,
  because it would delete images of the personal services.

## Coexistence with lumea

lumea uses 443, the `lumea` project, the `lumea-*` containers and the data in `/srv/lumea`. eclume
uses 8443, the `eclume` project, the `eclume-prod-*` volumes and the data in `/srv/eclume`,
with its own CA, network and Caddy. No command here touches the containers, volumes or images of
lumea or of the personal services (Jellyfin, *arr, qBittorrent, Samba). After a deploy,
`curl --cacert lumea-root.crt https://192.168.15.199/api/health` must keep returning 200.
