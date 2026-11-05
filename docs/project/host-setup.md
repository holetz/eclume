---
type: project
title: GPU host runbook
description: "How to prepare the server 192.168.15.199 (Ubuntu 26.04, GTX 1660 Super) to receive the eclume and lumea containers: fixed IP, NVIDIA driver, Docker, NVIDIA Container Toolkit, firewall and docker context."
resource: deploy/**
tags: [host, deploy, gpu, runbook]
timestamp: 2026-11-05
audience: both
authority: current
source: holetz/eclume#1, holetz/eclume#28, holetz/eclume#41
maintainer: holetz
---

# Preparing the host 192.168.15.199

This is the runbook of the **reference deployment**: it gets the maintainer institution's server ready to
receive the eclume containers and a neighbouring application's. The requirements and steps for any server, with or without a GPU,
are in [auto-hospedar.md](../how-to/auto-hospedar.md); developing without a GPU and without this host, in
[desenvolver-sem-gpu.md](../how-to/desenvolver-sem-gpu.md). The server
runs Ubuntu 26.04 LTS (upgraded from 24.04 on 2026-10-08) with an NVIDIA GTX 1660 Super (6 GB). Steps 1 to 8 run **on the
server**; step 9 runs **on the development machine**.

Ports:

| Service | Address |
|---|---|
| other application | `https://192.168.15.199` (443) |
| eclume | `https://192.168.15.199:8443` |

## Actual state of the host (provisioned on 2026-09-24, spec holetz/eclume#4)

| Item | State |
|---|---|
| Machine | `holetz-pc`, user `holetz` (sudo asks for a password since the upgrade to 26.04), 4 CPUs, 15 GB RAM, ~56 GB free on `/` |
| GPU | GTX 1660 SUPER 6 GB, driver 595.99.02 (`nvidia-driver-595-open` and `linux-modules-nvidia-595-open-generic`), `nvidia` runtime already configured in Docker |
| Docker | 29.1.3 from the Ubuntu repository, kept in place of Docker CE (step 3 skipped). `docker.io`, `containerd` and `runc` marked as manual (`apt-mark manual`), and the compose and buildx plugins in `~/.docker/cli-plugins` |
| Coexistence | The host is the user's home server, with Jellyfin, *arr, qBittorrent, homepage, Sunshine and Samba. Those services are **not touched**. Jellyfin may compete for the GPU. |
| Firewall | ufw already active, with rules for 443 (other application) and 8443 (eclume) only for `192.168.15.0/24` |
| SSH | the dev machine's `ed25519` key authorized. **Password login was kept** (step 1.4 not applied), so as not to lock the user out of other devices. |
| Claude | `~/.local/bin/claude` (2.1.282) already logged in |
| Builds | uv and Rust stable in `~/.local/bin` and `~/.cargo/bin`, with the Tauri build deps installed |
| eclume in production | project `eclume` on 8443 since 2026-09-25 (holetz/eclume#14), data in `/srv/eclume`, backup in `holetz`'s cron at 03:30; runbook in [deploy-producao.md](deploy-producao.md) |

**Heavy builds run on the host, not on the dev machine** (it freezes during meetings). A Windows
station is prepared by [estacao-windows.md](estacao-windows.md):

- Images: `docker --context gpu-host compose ... build`, straight on the host's daemon, with no registry.
- Cargo, npm and uv: `remote-run <dir> '<command>'` (`~/.local/bin/remote-run` on the dev machine).
  The helper syncs the directory through rsync (without `.git`, preserving `target/`, `node_modules/`,
  `.venv/` and `dist/` on the host) and runs in `~/build/<path>` with `nice`.
- Files generated on the host (an updated `Cargo.lock`, for example) do not come back on their own: bring them
  with `rsync holetz@192.168.15.199:build/<name>/<file> <local>` **right after** the command that
  generated them, because the next `remote-run` overwrites the host copy with the local one.
- `cmake` (required by the desktop's embedded libopus) is in `~/.local/bin`, installed by
  `uv tool install cmake`, without apt.
- **rsync preserves the modification time.** A file edited here **before** the host finished a
  previous build arrives on the host with a date older than its artifact, and cargo considers it
  up to date: the test runs against the old code, and the error shows up far from the cause (a function
  "not found" that exists). `touch` the changed files (`touch crates/*/src/*.rs`)
  before `remote-run`.
- **The desktop release builds from the commit, not from the tree** (`git archive`): whatever was not
  committed does not go in. The rehearsal (without `--publish`) requires neither a push nor a new version and leaves the
  installers in `~/eclume-build/release/dist-<version>`; the script refuses to start with the host's
  disk at 90% or more.
- Disk: `docker builder prune -f --filter until=720h` is fine when space gets tight.

## 1. Fixed IP and SSH

1. In the router, reserve the IP `192.168.15.199` (DHCP reservation) for the server's network card.
2. On the server:
   ```bash
   sudo apt-get update && sudo apt-get install -y openssh-server
   ```
3. On the development machine:
   ```bash
   ssh-copy-id usuario@192.168.15.199
   ```
4. After confirming that key login works, turn off password login:
   ```bash
   echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/10-hardening.conf
   sudo systemctl restart ssh
   ```

## 2. NVIDIA driver

```bash
sudo ubuntu-drivers install
sudo reboot
nvidia-smi   # the GTX 1660 SUPER should show up with 6144 MiB
```

## 3. Docker Engine and compose plugin (official repository)

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in
```

## 4. NVIDIA Container Toolkit

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

## 5. Data directories

```bash
sudo mkdir -p /srv/eclume
sudo chown "$USER":"$USER" /srv/eclume
df -h /srv   # reserve at least 50 GB for models and audio
```

## 6. Firewall

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.15.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 443 proto tcp
sudo ufw allow from 192.168.15.0/24 to any port 8443 proto tcp
# eclume mDNS announcement (`mdns` service, host network; holetz/eclume#35).
sudo ufw allow from 192.168.15.0/24 to any port 5353 proto udp
sudo ufw enable
```

`mdns` runs with `network_mode: host`, so 5353/udp goes **through** ufw (only the ports
published by Docker bypass it). Ubuntu's default `before.rules` already accepts multicast mDNS
(`224.0.0.251:5353`), and discovery worked without the rule; it makes explicit what
eclume needs, including for unicast queries. The deploy has no sudo: it is a manual step, done
once.

> **Warning:** ports published by Docker (`ports:` in the compose) **bypass ufw**.
> Postgres, Redis and MinIO must not have published `ports:`, or must be bound to
> `127.0.0.1:`. Only each stack's Caddy publishes a port.

## 7. `claude -p` on the server

This production's summarization agents use the `claude-cli` provider, this host's choice (the
matrix of the four providers is in [server-agentes.md](../standards/code/server-agentes.md#what-each-provider-requires)).
The CLI that runs in the worker comes from the image built with `ECLUME_CLAUDE_CLI=1` in the deploy's `.env.prod`;
the host's one only serves to generate the token.

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude setup-token   # long-lived token (1 year) for eclume
```

The eclume agent worker receives the token through the panel (Admin → Agentes → Token do Claude) or through
`ECLUME_CLAUDE_OAUTH_TOKEN` ([deploy-producao.md](deploy-producao.md#secrets)), without mounting the
host's session: the bind mount of `~/.claude/.credentials.json` diverges when the host's `claude`
renews the OAuth. Whether the terms allow this use of the subscription token is a pending decision of the
owner (holetz/eclume#129).

## 8. Hugging Face token (diarization)

1. Create a read token at <https://huggingface.co/settings/tokens>.
2. Accept the terms of `pyannote/speaker-diarization-community-1`, and also of the other
   gated models listed in `holetz/eclume#8`, with the same account.
3. The token goes in `/srv/eclume/secrets/hf_token` or in the admin panel (see
   [worker-gpu.md](worker-gpu.md)). It is never versioned.

## 9. On the development machine: Docker context

```bash
docker context create gpu-host --docker "host=ssh://usuario@192.168.15.199"
docker --context gpu-host info | grep -i runtimes   # should list nvidia
docker --context gpu-host run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

Builds and deploys use `--context gpu-host`. The development loop stays local.

To let the pre-push hook fire the quality gate, record the context once per clone:
`git config eclume.gateContext gpu-host` (activation of the hook is `git config core.hooksPath .githooks`).
`deploy/gate.sh` resolves the context as `--context`, then `ECLUME_DOCKER_CONTEXT`, then this git config; the
repository ships no default. Without any of them the hook prints an error naming this command and the push
still goes through.

## 10. Caddy certificate (after the first deploy)

Each stack uses Caddy with `tls internal`, and each has its own CA. HTTPS is mandatory for
media conversion in the browser (WebCodecs) and for the microphone. The eclume deploy publishes the root
at `https://192.168.15.199:8443/downloads/eclume-root.crt` (`/srv/eclume/downloads/`):

```bash
scp holetz@192.168.15.199:/srv/eclume/downloads/eclume-root.crt .
```

- **Linux:** copy to `/usr/local/share/ca-certificates/eclume-root.crt` and run
  `sudo update-ca-certificates`.
- **Windows:** run `certutil -addstore -f Root eclume-root.crt` as administrator.
- **macOS:** run
  `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain eclume-root.crt`.
- **Firefox:** import it in Settings → Certificates, because it uses its own store.

Checking the fingerprint and use by API integrations are in
[deploy-producao.md](deploy-producao.md#root-ca-on-the-clients).

## Ubuntu version upgrade

The upgrade from 24.04 to 26.04 (2026-10-08) took down the whole host. `do-release-upgrade`
removed `docker-compose` v1, and the following `apt autoremove` took `docker.io`, `containerd` and
`runc`, which had been installed as its dependency. The data in `/var/lib/docker` survives,
because the package is removed without purge. On the next upgrade:

- **Before `autoremove`:** `apt-mark showmanual | grep -E '^(docker.io|containerd|runc)$'` must
  list the three. If any is missing, run `sudo apt-get install -y docker.io` and
  `sudo apt-mark manual docker.io containerd runc`.
- **Third-party repositories:** the upgrade disables the lists from outside Ubuntu. Re-enable the NVIDIA
  Container Toolkit one in deb822 format, in `/etc/apt/sources.list.d/nvidia-container-toolkit.sources`:
  ```
  Types: deb
  URIs: https://nvidia.github.io/libnvidia-container/stable/deb/amd64/
  Suites: /
  Signed-By: /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  ```
- **New kernel driver:** `sudo apt-get install -y linux-modules-nvidia-595-open-generic`, and
  then check with `nvidia-smi`.
- **GPU in containers:** a `systemctl daemon-reload` (which `systemctl enable` and package installation
  also trigger) with GPU containers already up cuts their access to `/dev/nvidia*`.
  In `eclume-worker-gpu-1`, `nvidia-smi` fails with `Failed to initialize NVML: Unknown Error`; in
  `jellyfin`, `: < /dev/nvidia-uvm` gives `Operation not permitted`. The host stays normal and the
  watchdog does not notice, because it tests the host's `nvidia-smi` and the worker's heartbeat. To fix it,
  `docker restart` on both is enough.
- **Containers without a restart policy** do not come back after a boot. The neighbouring application stayed down from
  2026-10-02 to 2026-10-08 this way. It was fixed with
  `docker update --restart unless-stopped` on the long-running services, which is what its
  compose file declares.
- **Proof:** eclume's read-only smoke ([deploy-producao.md](deploy-producao.md)) and
  the neighbouring application's own health check (200).

## Quality gate (`~/eclume-gate`)

The gate (`bash deploy/gate.sh` on the station; standard in
[monorepo.md](../standards/code/monorepo.md)) runs on the host, as user `holetz`:

- `~/eclume-gate/src-<sha>-<epoch>`: the tree extracted from `git archive`, deleted at the end;
  `~/eclume-gate/logs/<sha>.log`: the log of each full run; `~/eclume-gate/.trava-<n>`:
  the slot locks. Up to `ECLUME_GATE_SLOTS` (2) gates run at once, one per slot; a third waits for
  a free slot. Inside a gate, up to `ECLUME_GATE_JOBS` (2) pillars run at once, each from its own
  copy of the tree (`src-<sha>-<epoch>.p-<pillar>`), and `gpu-e2e` runs last, alone, under
  `~/eclume-gate/.trava-gpu`.
  Each pillar container gets `ECLUME_E2E_WORKERS` set to its CPU share (`ECLUME_GATE_CPUS`, 3), and
  both Playwright suites use it as `--workers`: a container sees every host CPU, and Playwright's
  default of half of them put six browsers in a 4 GB container, which the kernel OOM-killed.
- `~/eclume-gate/cache`: cargo target per pillar, cargo registry, uv, npm, Playwright browser and
  `cargo-xwin` caches (~15 GB after two runs; above
  `ECLUME_GATE_CACHE_GB`, 25 GB, the target/ restart). To free disk, delete the whole folder:
  the next run rebuilds.
- Images: `eclume-gate:<Rust>` (`deploy/gate.Dockerfile`), on top of `eclume-desktop-build-windows:<Rust>`
  and `eclume-desktop-build:<Rust>` (the version in `desktop/rust-toolchain.toml`), which the gate builds
  if they are missing; those tagged `24.04` are from the era before pinning and can be deleted. The first build of the
  gate image took ~20 minutes.
- Compose project `eclume-gate-<slot>` (Postgres, Redis, MinIO and the mock on `127.0.0.1:55633`,
  `56580`, `59201` and `4211`, plus the slot number), brought down with `down -v` at the end; it
  never touches the `eclume` project.
- Pillar `gpu-e2e`: runs on the host (not in the container), brings up the compose project `eclume-gpu-test` (Redis
  on `127.0.0.1:16379`, MinIO on `19000`, the worker-gpu with the GPU) and takes it down with `down -v` at the end;
  it uses the models and the Hugging Face token from `/srv/eclume`, shares the 6 GB of VRAM with production and
  waits for `busy` and for free VRAM before coming up (exits 75, inconclusive, if the GPU does not free up).
  Baseline with the host idle (2026-10-07, holetz/eclume#159): 887 MiB occupied by the graphical
  session (Xorg, gnome-shell, Firefox, Discord, Steam), no eclume CUDA process (the worker-gpu
  unloads the models and recycles the process when idle) and ~400 MiB held by the driver; ~4.8 GB
  remain free, above the minimum of 4096 MiB. Check with
  `nvidia-smi --query-compute-apps=pid,used_memory --format=csv` (empty with the host idle).
  Standard in [monorepo.md](../standards/code/monorepo.md).
- Limits per pillar: `--cpus` `ECLUME_GATE_CPUS` (3; the host has had 12 CPUs since October 2026), `--cpu-shares 256` (also on the test services and the mock, through a
  `~/eclume-gate/cpu-shares-<slot>.yml` generated on each run: production wins the CPU when they compete),
  `nice`, memory ceiling `ECLUME_GATE_MEMORY` (4g; the measured peak was ~2.6 GiB in the desktop and
  windows link). The android pillar, measured on 08/10/2026 (holetz/eclume#188) with the container cgroup's
  `memory.peak`: peak at the 4 GiB ceiling, `anon` of 4056 MiB and `oom_kill` 1, with Gradle (2403 MiB), the Kotlin
  daemon (972 MiB) and the Kotlin build-tools (507 MiB) alive at the same time; cargo was not at the
  peak. The cause was the missing `./gradlew --stop`: the Gradle that `tauri android build` leaves up
  (2 GiB) coexisted with the following `gradlew --no-daemon`, and Kotlin compiled in a second JVM. With
  `kotlin.compiler.execution.strategy=in-process`, `-Xmx1536m`, `org.gradle.workers.max=2` and the `--stop`
  in `deploy/pillars.sh`, two consecutive runs passed with `anon` of 2658 and 2870 MiB, cgroup peak of
  3581 MiB (the rest is page cache) and `oom_kill` 0, without raising the ceiling. A full run took 16 to 21 minutes with production up, and refuses with the
  disk at 90%.
- Proportional: the host runs only the pillars that the diff since the last green SHA requires (`--all` on the
  station forces all ten) and abandons the SHA that the pre-push fired and that `main` has already passed
  (`eclume/gate` = `error` "superado por <sha>"); `bash deploy/gate.sh --status <sha>` shows the
  description with the pillars run and the ones skipped. A deploy with no status for the tip SHA is resolved
  with `bash deploy/gate.sh <sha>`, which is never abandoned.
- Pruning on every run: logs older than 30 days, build images of another Rust version (the
  `eclume-gate`, `eclume-desktop-build`, `-windows` and `eclume-mobile-build` without the current tag) and
  `src-*` older than a day. The release `dist-*` (`~/eclume-build/release` and `/movel`) stay at the
  3 most recent, pruned on every `release-desktop.sh` and `release-mobile.sh`.
- The host's `gh` (account `holetz`, scope `repo`) publishes the `eclume/gate` status; the pillar containers
  do not receive the token. The NDK at `~/android-sdk/ndk/28.2.13676358` goes in read-only on the
  `mobile` pillar.

## Desktop installers (without code signing)

The installers come out of `deploy/release-desktop.sh` (it builds on the host and creates the tag
`desktop-v<version>` as a private GitHub Release; the `desktop-release` workflow is just the manual
alternative); the contract is in
[desktop-distribuicao.md](../standards/code/desktop-distribuicao.md). Since the repo is private, the
clients download from the eclume server itself:

- **Served folder:** `/srv/eclume/downloads/`, published at `https://192.168.15.199:8443/downloads/`
  by eclume's Caddy ([deploy-producao.md](deploy-producao.md)). At the root are `latest.json`
  (the updater's manifest), `instaladores.json` (list for the download page) and `INSTALACAO.md`; each version
  lives in `/srv/eclume/downloads/<version>/`, with the three most recent kept.
- **Publish a release** (on the host, where `gh` is authenticated):
  ```bash
  deploy/publish-desktop.sh desktop-v0.1.0
  # from the dev machine, without cloning anything on the host:
  ssh holetz@192.168.15.199 'bash -s -- desktop-v0.1.0' < deploy/publish-desktop.sh
  ```
  The script checks `SHA256SUMS` before swapping the root manifests.
- **Updater key (minisign):** the private key and the password live in
  `/srv/eclume/secrets/tauri-updater.key` and `tauri-updater.key.password` (`chmod 600`), which the
  release on the host reads; the same values are in the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the manual workflow — but a GitHub secret cannot be read
  back and is not a recoverable copy: the copy is the encrypted restic snapshot of `secrets/` that
  `backup.sh` takes off the host ([deploy-producao.md](deploy-producao.md#backup-and-restore)).
  Never in the repo. The public one is in `desktop/src-tauri/tauri.conf.json`. Losing the private key forces
  reinstalling the app by hand on every client.

First-install warnings, detailed for the user in
[desktop/INSTALACAO.md](../../desktop/INSTALACAO.md):

- **Windows:** SmartScreen warns on the first run. Click "Mais informações" and then "Executar assim mesmo".
- **macOS:** Gatekeeper refuses the non-notarized app. Run
  `xattr -dr com.apple.quarantine /Applications/eclume.app`, or try to open it and allow it in System
  Settings → Privacy & Security → "Abrir Mesmo Assim".
- **Linux:** the AppImage needs `chmod +x` (and, on some distros, FUSE 2); the `.deb` installs
  with `sudo apt install ./eclume_<version>_amd64.deb`.
- **All:** the updater and the sync only trust the server after Caddy's root CA is installed
  on the client (step 10).

## Android environment (build and emulator for the mobile app)

The mobile app ([mobile/](../../mobile/README.md)) builds and runs the emulator on the host, which has KVM.
Everything lives in `~/`, without sudo, through the idempotent script
[mobile/scripts/android-sdk.sh](../../mobile/scripts/android-sdk.sh):

```bash
ssh holetz@192.168.15.199 'bash -s' < mobile/scripts/android-sdk.sh
```

- **What it installs:** Android command-line tools 22.0 in `~/android-sdk` (SHA-256 checked), a
  portable JDK 21 in `~/jdk-21` (Ubuntu's OpenJDK on the host only has the runtime, without `javac`), the
  packages `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`, `ndk;28.2.13676358`,
  `emulator` and `system-images;android-35;google_apis;x86_64`, the four Android `rustup` targets and the
  AVD `eclume-35` (Pixel 6, 2 GB of RAM).
- **Environment:** `~/.config/eclume/android-env.sh` exports `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` and
  the `PATH`. Every Android build command starts with
  `source ~/.config/eclume/android-env.sh`, also through `remote-run`.
- **Disk:** the script refuses to install if the disk exceeds 88 % (the deploy refuses above 90 %). The
  SDK takes ~7 GB, the JDK ~350 MB and the AVD ~250 MB (it grows with use). To free space, use
  `docker builder prune -af` and delete eclume's already-merged `~/build/*/target`; never delete
  other projects' images.
- **Second run:** it only checks and prints "nothing to do".
- **KVM:** `/dev/kvm` gives read and write to `holetz` through an ACL; without it, the script warns and the
  emulator runs without acceleration.
- **Command-line tools pinned at 22.0:** 23 swaps `sdkmanager` for `android sdk` and changes the
  output of `--list_installed` (`ndk/28…` in place of `ndk;28…`). 22 still warns that
  `sdkmanager` is obsolete; the warning is expected.
