---
type: how-to
title: Self-host eclume
description: How to bring up eclume on your own server, with or without an NVIDIA GPU — requirements, the no-GPU path, the generated deploy/.env.prod, deploy through any Docker context, the first admin, the summary provider, the local-network premise (mDNS and own CA), what changes when exposing to the internet, how to close signup, and the backup.
resource: deploy/deploy.sh, deploy/docker-compose.prod.yml, deploy/docker-compose.cpu.yml, deploy/.env.prod.example, deploy/bootstrap-admin.sh, deploy/backup.sh
tags: [deploy, auto-hospedagem, gpu, cpu, instalacao]
timestamp: 2026-10-07
audience: both
source: holetz/eclume#126, holetz/eclume#151
maintainer: holetz
---

# Self-host eclume

eclume runs entirely on a Linux server of yours, through Docker Compose, in eight long-running
containers: the Caddy edge with HTTPS on port 8443 and the embedded web, the API, a CPU worker, the
transcription worker, the mDNS announcement, Postgres, Redis and MinIO. The deploy goes out from a **station** (the machine on which
you cloned the repository) and talks to the server through an `ssh://` **Docker context**: the build
runs on the server's daemon and the data folders are created over SSH. This guide holds for any
server; the concrete record of the institution's production, which follows these steps, is in
[deploy-producao.md](../project/deploy-producao.md) and [host-setup.md](../project/host-setup.md).

## Requirements

**On the server**

- Linux x86_64 with Docker Engine **25 or newer** (the healthchecks' `start_interval`) and the
  Compose plugin **2.24 or newer** (the deploy checks), and SSH by key from the station.
- Memory: the default ceilings add up to about 12 GB (8 GB for the transcription worker, 2 GB for the CPU worker and the
  rest in fractions of a GB), plus Postgres, with no ceiling; each service has the pair
  `ECLUME_MEM_<SERVICE>`/`ECLUME_MEMSWAP_<SERVICE>` to adjust
  ([deploy-producao.md](../project/deploy-producao.md#stack)).
- Disk: the transcription worker image is **~8 GB**, and the first job downloads **~3.9 GB** of
  models into `<ECLUME_DATA_DIR>/models`; reserve 50 GB or more for models and audio. The deploy
  refuses with the disk at 90% or more (`ECLUME_DISK_LIMIT`).
- A data folder owned by the SSH user, by default `/srv/eclume`
  (`sudo mkdir -p /srv/eclume && sudo chown "$USER": /srv/eclume`).
- **With a GPU:** NVIDIA with **6 GB or more**, driver installed (`nvidia-smi` answers) and the NVIDIA
  Container Toolkit configured in Docker
  (`docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi` answers).
- **Hugging Face token** (read), with the terms of `pyannote/speaker-diarization-community-1`
  accepted on the same account: it is what turns on diarization (separating the speakers). It goes in
  `<ECLUME_DATA_DIR>/secrets/hf_token` or in the administration panel. Without a GPU, it is not used.
- Firewall: only 8443/tcp (Caddy) and 5353/udp (the mDNS announcement) open to the local network.
  Postgres, Redis and MinIO publish no port.

**On the station:** `git`, Docker CLI with the Compose plugin, `ssh`, `openssl`, `python3` and an authenticated `gh`
(the deploy checks the commit and the gate status on GitHub).

## Without a GPU

A server without an NVIDIA GPU brings up the same stack with `--sem-gpu`: the deploy adds
`deploy/docker-compose.cpu.yml`, and the transcription worker uses the same image with the `cpu` engine
(faster-whisper `small` int8), without a GPU reservation. The limit: **no diarization** (the transcription
comes out with a single speaker, and voice identification has nothing to suggest) and several times slower
than on the GPU. The engine's contract is in
[jobs-transcricao.md](../standards/api/jobs-transcricao.md#como-o-worker-cumpre-a-sua-parte).
Pass `--sem-gpu` on **every** deploy of that server: without it, compose asks for the GPU and the worker does not
come up.

## 1. Docker context

On the station, a context pointing at the server over SSH:

```bash
docker context create my-server --docker "host=ssh://user@server"
docker --context my-server info
```

The deploy scripts have no default context: pass `--context my-server` or export
`ECLUME_DOCKER_CONTEXT=my-server`. Without that, they refuse, saying what is missing.

## 2. `deploy/.env.prod`

```bash
bash deploy/deploy.sh --context my-server --gerar-env
```

generates `deploy/.env.prod` (600, outside git) from `deploy/.env.prod.example`, with random
secrets. Edit by hand what is yours, which the example carries as `troque-…` — the deploy refuses while there is
one:

- `ECLUME_PUBLIC_HOST`: the IP or name by which the network reaches the server.
- `ECLUME_PUBLIC_URL`: `https://<ECLUME_PUBLIC_HOST>:8443`.
- `ECLUME_DATA_DIR` (default `/srv/eclume`), `ECLUME_SERVER_NAME` and `ECLUME_CLAUDE_CLI` (`0` or
  `1`, see the provider below).

The deploy keeps a copy at `<ECLUME_DATA_DIR>/secrets/env.prod` on the server and, on a station
without the file, restores it from there. The meaning of each variable is in the example's comments and
in the table of [deploy-producao.md](../project/deploy-producao.md#secrets).

## 3. Deploy

```bash
bash deploy/deploy.sh --context my-server --plan      # only shows what it would do
bash deploy/deploy.sh --context my-server             # with a GPU
bash deploy/deploy.sh --context my-server --sem-gpu   # without a GPU
```

The deploy goes out from the `HEAD` commit, clean and published on GitHub, and requires on it the status
`eclume/gate` = `success`. A published `main` commit already has the gate; for another commit (a fork,
a branch of yours), `--sem-gate "<reason>"` and `--fora-do-main "<reason>"` waive those two
requirements and leave the reason in the history. The steps, the retention and the rollback (`--voltar`) are in
[deploy-producao.md](../project/deploy-producao.md#deploy).

## 4. First admin

```bash
bash deploy/bootstrap-admin.sh --context my-server --email admin@example.com
```

creates the panel's admin account once only. The e-mail has no default. The password is generated on the server,
in `<ECLUME_DATA_DIR>/secrets/admin-password` (600), and never passes through the station. The panel is at
`https://<server>:8443/admin/entrar`.

## 5. Summary provider

Transcription needs no provider; the summary does. Register one in **Admin → Agentes**. The
types and what each requires — an API key, an OpenAI-API-compatible server on your network,
or the Claude CLI, which only goes into the image with `ECLUME_CLAUDE_CLI=1` — are in the matrix of
[server-agentes.md](../standards/code/server-agentes.md#o-que-cada-provider-exige). With
`ECLUME_CLAUDE_CLI=0`, the server image has free software only.

## 6. Clients on the local network

eclume assumes a **local network**: Caddy uses its **own CA** (`tls internal`), and the `mdns`
service announces `_eclume._tcp` so the desktop and the phone find the server by themselves.

- The CA root is at `https://<server>:8443/downloads/eclume-root.crt`. Install it in the
  browsers and systems that access eclume (HTTPS is mandatory for the microphone and for media
  conversion); the per-system commands are in
  [deploy-producao.md](../project/deploy-producao.md#root-ca-on-the-clients). Check the fingerprint
  (`openssl x509 -noout -fingerprint -sha256 -in eclume-root.crt`) against the server.
- The desktop and mobile apps check and pin the CA by themselves on first run. Their installation
  instructions are in the server's own `/downloads/`.
- Deleting `<ECLUME_DATA_DIR>/caddy/data` generates another CA and forces reinstalling the root on every
  client.

## 7. Exposing to the internet

The stack was made for the local network. Before publishing 8443 outside it:

- **Close signup** (below) or accept that anyone creates an account.
- **Replace the internal CA with a public certificate** (your own domain and Caddy's automatic
  HTTPS) and do not publish `eclume-root.crt` alongside it (holetz/eclume#102).
- Hardening of the exposed server (limits, headers, attempts) is holetz/eclume#99, and the CA
  with a name constraint, holetz/eclume#101; until then, prefer a VPN for outside access.
- mDNS does not cross the internet: outside clients type the address.

## 8. Closing signup

Signup is born open (`ECLUME_SIGNUP_OPEN=true`): anyone who reaches the server creates
an account. To close it, put `ECLUME_SIGNUP_OPEN=false` in `deploy/.env.prod` and recreate the server
without a build:

```bash
bash deploy/deploy.sh --context my-server --sem-build    # + --sem-gpu, if applicable
```

The admin activates and deactivates accounts in **Admin → Usuários**; there is no invitation.

## 9. Backup

The deploy installs the daily `backup.sh` in the SSH user's crontab: an encrypted restic snapshot of the
database, the objects and the secrets in `<ECLUME_DATA_DIR>/backups/restic`. A backup only on the same
disk does not survive the disk: configure the off-server repository
(`<ECLUME_DATA_DIR>/secrets/restic-fora.env`) and test the restore, as in
[deploy-producao.md](../project/deploy-producao.md#backup-and-restore).
