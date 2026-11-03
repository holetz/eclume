#!/usr/bin/env bash
# Production deploy of eclume on the GPU host, through the Docker context (build on the host's
# daemon, no registry) and over SSH for what belongs to the host (folders, disk, env copy, backup
# scripts and cron).
#
# Usage: bash deploy/deploy.sh --context NAME [--plan] [--services "server caddy worker-gpu"]
#                              [--no-gpu] [--no-build] [--generate-env] [--skip-gate "reason"]
#                              [--off-main "reason"] [--rollback SHA] [--replace-env]
#                              [--gpu-wait MINUTES] [--interrupt-gpu]
#   --plan            only shows what it would do (read-only): SHA in production and target, the
#                     product version and the tag the deploy would create, commits between them,
#                     pending migrations, env × host, busy GPU and the gate state.
#   --context         Docker context of the host (or $ECLUME_DOCKER_CONTEXT); required, no default.
#   --no-gpu          host without an NVIDIA GPU: adds deploy/docker-compose.cpu.yml (transcription
#                     worker on the cpu engine, no GPU reservation and no diarization).
#   --services        services whose images to build (default: server caddy worker-gpu; `web` is
#                     the old name of caddy, the edge with the SPA). The up always starts the whole stack.
#   --no-build        builds nothing; starts the images already on the host.
#   --generate-env    creates deploy/.env.prod with random secrets and exits (refuses if the host has one).
#   --skip-gate       waives only the eclume/gate = success status on HEAD (clean tree and commit on
#                     GitHub are still required) and leaves the eclume/gate-dispensa trace with the reason.
#   --off-main        accepts a HEAD outside origin/main or not descending from the SHA in production;
#                     the reason goes to deploys.log.
#   --rollback SHA    starts the kept image trio of that deploy, without build and without migrate.
#   --replace-env     accepts a deploy/.env.prod that loses or changes a key of the host copy (which
#                     is saved as secrets/env.prod.<date>).
#   --gpu-wait        minutes to wait for a busy GPU before refusing (default 30).
#   --interrupt-gpu   with the GPU still busy at the end of the wait, stops the worker-gpu anyway.
# The build comes from the SHA's `git archive`, never from the working tree. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
NO_GPU=0
ENV_FILE=deploy/.env.prod
BUILD=(server caddy worker-gpu)
# The kept images (`eclume-<name>:<sha>`) and the services of the start come from the SHA's compose
# (`deploy_lib.py topology`): a `--rollback` to a SHA before holetz/eclume#151 has `web`, not
# `edge`, and the two CPU workers. Retention goes through every name, the old ones included.
IMAGES=()
APP=()
RETENTION=(server edge web worker-gpu)
PLAN_ONLY=0
NO_BUILD=0
GEN_ENV=0
SKIP_GATE=""
OFF_MAIN=""
ROLLBACK=""
REPLACE_ENV=0
GPU_WAIT=30
INTERRUPT_GPU=0
REPO=holetz/eclume
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
# ECLUME_DEPLOYS_RETIDOS is the deprecated pt-BR name, still read as a fallback.
KEPT="${ECLUME_DEPLOYS_KEPT:-${ECLUME_DEPLOYS_RETIDOS:-3}}"
PYTHON="$(command -v python3 || command -v python)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context needs the name of a Docker context." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --services)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--services needs a list." >&2; exit 2; }
      read -r -a BUILD <<< "$2"; shift 2 ;;
    --no-gpu) NO_GPU=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --generate-env) GEN_ENV=1; shift ;;
    --skip-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--skip-gate needs the reason." >&2; exit 2; }
      SKIP_GATE="$2"; shift 2 ;;
    --off-main)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--off-main needs the reason." >&2; exit 2; }
      OFF_MAIN="$2"; shift 2 ;;
    --rollback)
      [[ $# -ge 2 && "$2" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--rollback needs the SHA of a kept deploy." >&2; exit 2; }
      ROLLBACK="$2"; shift 2 ;;
    --replace-env) REPLACE_ENV=1; shift ;;
    --gpu-wait)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "--gpu-wait needs the minutes." >&2; exit 2; }
      GPU_WAIT="$2"; shift 2 ;;
    --interrupt-gpu) INTERRUPT_GPU=1; shift ;;
    --help|-h) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done
for i in "${!BUILD[@]}"; do
  case "${BUILD[$i]}" in
    server|caddy|worker-gpu) ;;
    web) BUILD[i]=caddy ;;  # the SPA lives on the edge since holetz/eclume#151
    *) echo "Invalid service in --services: ${BUILD[$i]} (server, caddy or worker-gpu)" >&2; exit 2 ;;
  esac
done
[[ "$NO_BUILD" -eq 0 && -z "$ROLLBACK" ]] || BUILD=()
# No default: an implicit context would publish on someone else's host.
[[ -n "$CONTEXT" ]] || { echo "Missing the host's Docker context: --context NAME or ECLUME_DOCKER_CONTEXT." >&2; exit 2; }

# Remote context: DOCKER_CONTEXT holds for every docker/compose below; DOCKER_HOST would override it.
export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "The context $CONTEXT is not ssh:// ($endpoint); set ECLUME_SSH=user@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }
# The `!reset` of docker-compose.cpu.yml and the prod's `configs.content` need Compose 2.24+.
compose_ver="$(docker compose version --short 2>/dev/null || echo 0)"
"$PYTHON" -c 'import sys; v=[int(x) for x in sys.argv[1].lstrip("v").split("-")[0].split(".")[:2]]+[0]; sys.exit(0 if v[:2]>=[2,24] else 1)' "$compose_ver" \
  || { echo "Docker Compose $compose_ver is old: the deploy needs 2.24 or newer." >&2; exit 2; }

# --- deploy/.env.prod ---------------------------------------------------------------------------
if [[ "$GEN_ENV" -eq 1 ]]; then
  [[ ! -e "$ENV_FILE" ]] || { echo "$ENV_FILE already exists; I do not overwrite secrets." >&2; exit 2; }
  # The production secrets already exist on the host: generating others would lock out their database and bucket.
  if host 'test -s /srv/eclume/secrets/env.prod'; then
    echo "The host already has /srv/eclume/secrets/env.prod: the deploy restores it in this checkout; I do not generate another." >&2
    exit 2
  fi
  umask 077
  sed -e "s|^ECLUME_PG_PASSWORD=.*|ECLUME_PG_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_RUNTIME_PG_PASSWORD=.*|ECLUME_RUNTIME_PG_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_MINIO_PASSWORD=.*|ECLUME_MINIO_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_MINIO_SERVER_PASSWORD=.*|ECLUME_MINIO_SERVER_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_MINIO_GPU_PASSWORD=.*|ECLUME_MINIO_GPU_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_REDIS_SERVER_PASSWORD=.*|ECLUME_REDIS_SERVER_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_REDIS_GPU_PASSWORD=.*|ECLUME_REDIS_GPU_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_SECRET_KEY=.*|ECLUME_SECRET_KEY=$(openssl rand -hex 32)|" \
      -e "s|^ECLUME_ENCRYPTION_KEY=.*|ECLUME_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
      deploy/.env.prod.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Generated $ENV_FILE (600). The deploy keeps the copy in <ECLUME_DATA_DIR>/secrets/env.prod." >&2
  exit 0
fi

# --- gate: what goes to production is a published, clean and proven commit ------------------------
SHA="$(git rev-parse HEAD)"
problems=()
if [[ -n "$ROLLBACK" ]]; then
  # The rollback starts images of a previous deploy, which already passed the gate; HEAD does not matter.
  SHA="$(git rev-parse --verify --quiet "$ROLLBACK^{commit}" || echo "$ROLLBACK")"
  gate_ok=1
  gate="not applicable (--rollback $SHA)"
else
  [[ -z "$(git status --porcelain)" ]] || problems+=("the working tree has changes; the deploy comes from the clean commit $SHA")
  if gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null; then
    gate_ok=1
    gate="$(gh api "repos/$REPO/commits/$SHA/status" | python3 deploy/gate.py decide)" || gate_ok=0
  else
    problems+=("the commit $SHA is not on GitHub (push it first)")
    gate_ok=0
    gate="eclume/gate unreadable (commit not on GitHub)"
  fi
  if [[ "$gate_ok" -eq 0 && -n "$SKIP_GATE" ]]; then
    gate="$gate · waived: $SKIP_GATE"
  elif [[ "$gate_ok" -eq 0 ]]; then
    problems+=("$gate (run bash deploy/gate.sh or waive it with --skip-gate \"reason\")")
  fi
fi

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
# The new key when the env declares it, else the deprecated pt-BR one.
env_value_compat() {
  if grep -q "^$1=" "$ENV_FILE"; then env_value "$1"; else env_value "$2"; fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  # The host's backup copy becomes the source when the checkout has no env (another machine,
  # another worktree).
  if host 'test -s /srv/eclume/secrets/env.prod'; then
    if [[ "$PLAN_ONLY" -eq 1 ]]; then
      echo "Warning: $ENV_FILE is missing; the deploy would restore the copy from /srv/eclume/secrets/env.prod." >&2
    else
      (umask 077; host 'cat /srv/eclume/secrets/env.prod' > "$ENV_FILE")
      echo "Restored $ENV_FILE from the host's copy." >&2
    fi
  elif [[ "$PLAN_ONLY" -eq 0 ]]; then
    echo "Missing $ENV_FILE: run bash deploy/deploy.sh --generate-env." >&2
    exit 2
  else
    echo "Warning: $ENV_FILE is missing (the real deploy refuses without it; --generate-env)." >&2
  fi
fi
if [[ -f "$ENV_FILE" ]]; then
  DATA_DIR="$(env_value ECLUME_DATA_DIR)"
  PUBLIC_URL="$(env_value ECLUME_PUBLIC_URL)"
  COMPOSE_ENV="$ROOT/$ENV_FILE"
else
  DATA_DIR=/srv/eclume
  PUBLIC_URL="?"
  COMPOSE_ENV="$ROOT/deploy/.env.prod.example"
fi
DATA_DIR="${DATA_DIR:-/srv/eclume}"
LOG="$DATA_DIR/deploys.log"

work="$(mktemp -d)"
lock_dir="" ca=""
trap '[[ -z "$lock_dir" ]] || rmdir "$lock_dir"; rm -f "$ca"; rm -rf "$work"' EXIT

# --- the SHA: on origin/main and ahead of what is in production ------------------------------------
host "cat '$LOG' 2>/dev/null || true" > "$work/deploys.log"
PROD_SHA="$(awk -F'\t' 'NF >= 6 { sha = $2 } END { print sha }' "$work/deploys.log")"
git fetch -q origin main 2>/dev/null || problems+=("could not update origin/main")
if [[ -z "$ROLLBACK" ]]; then
  if ! git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
    [[ -n "$OFF_MAIN" ]] || problems+=("the commit $SHA is not on origin/main (a branch: --off-main \"reason\")")
  fi
  if [[ -n "$PROD_SHA" ]] && ! git merge-base --is-ancestor "$PROD_SHA" "$SHA" 2>/dev/null; then
    [[ -n "$OFF_MAIN" ]] || problems+=("the commit $SHA does not descend from what is in production ($PROD_SHA): going back is --rollback, a branch is --off-main")
  fi
fi

# --- local env × host copy, by key (the host's value never leaves it) -------------------------------
env_diverge=""
if [[ -f "$ENV_FILE" ]] && host "test -s '$DATA_DIR/secrets/env.prod'"; then
  host "grep -E '^[A-Za-z_][A-Za-z0-9_]*=' '$DATA_DIR/secrets/env.prod' | while IFS= read -r line; do
      printf '%s\t%s\n' \"\${line%%=*}\" \"\$(printf '%s' \"\${line#*=}\" | sha256sum | cut -d' ' -f1)\"
    done" > "$work/env.host"
  env_diverge="$("$PYTHON" deploy/deploy_lib.py env-diverge "$work/env.host" "$ENV_FILE" | tr '\n' ' ' || true)"
  if [[ -n "$env_diverge" && "$REPLACE_ENV" -eq 0 ]]; then
    problems+=("$ENV_FILE loses or changes a key of the host copy: ${env_diverge% } (check it; replacing is --replace-env)")
  fi
fi

# Env older than a new password (eclume_server role, holetz/eclume#26; per-service Redis and MinIO
# credentials, holetz/eclume#94): generates the missing one, without touching the rest. The
# `minio-init` and the Redis ACL apply it in the same deploy.
for key in ECLUME_RUNTIME_PG_PASSWORD ECLUME_MINIO_SERVER_PASSWORD ECLUME_MINIO_GPU_PASSWORD \
           ECLUME_REDIS_SERVER_PASSWORD ECLUME_REDIS_GPU_PASSWORD; do
  [[ -f "$ENV_FILE" ]] && ! grep -q "^$key=" "$ENV_FILE" || continue
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    echo "Warning: $ENV_FILE without $key; the deploy would generate one." >&2
  elif [[ "${#problems[@]}" -eq 0 ]]; then
    printf '\n# Generated by the deploy.\n%s=%s\n' "$key" "$(openssl rand -hex 24)" >> "$ENV_FILE"
    echo "Generated $key in $ENV_FILE." >&2
  fi
done
# Placeholders of deploy/.env.prod.example: `change-me-`, and `troque-` in examples before the English rename.
if [[ -f "$ENV_FILE" ]] && grep -qE '=(change-me|troque)-' "$ENV_FILE" && [[ "$PLAN_ONLY" -eq 0 ]]; then
  problems+=("$ENV_FILE still has 'change-me-' values: generate real secrets (--generate-env)")
fi
# The `claude` CLI only goes into the image with ECLUME_CLAUDE_CLI=1 (holetz/eclume#129): without the
# declaration, the build would fall back to 0 and production's claude-cli would vanish silently.
if [[ -f "$ENV_FILE" ]] && ! grep -qE '^ECLUME_CLAUDE_CLI=[01]$' "$ENV_FILE"; then
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    echo "Warning: $ENV_FILE does not declare ECLUME_CLAUDE_CLI (0 or 1); the real deploy refuses." >&2
  else
    problems+=("$ENV_FILE does not declare ECLUME_CLAUDE_CLI=0 or 1 (1 keeps the claude-cli CLI in the image)")
  fi
fi

# --- the SHA's tree, in a temporary folder: compose, Dockerfiles and scripts are its own ------------
if git cat-file -e "$SHA^{commit}" 2>/dev/null; then
  git archive "$SHA" | tar -x -C "$work" -f -
  TREE="$work"
  known_migrations="$(git ls-tree --name-only "$SHA" server/src/eclume_server/db/migrations/ \
    | sed -n 's|.*/\([0-9][0-9][0-9]_.*\)\.sql$|\1|p')"
else
  problems+=("the commit $SHA does not exist in this checkout (git fetch)")
  TREE="$ROOT"
  known_migrations=""
fi
export ECLUME_COMMIT="$SHA"
COMPOSE=(docker compose -p eclume -f "$TREE/deploy/docker-compose.prod.yml" --env-file "$COMPOSE_ENV")
[[ "$NO_GPU" -eq 0 ]] || COMPOSE+=(-f "$TREE/deploy/docker-compose.cpu.yml")
# A script of the SHA's tree by its name, or by its pt-BR name in a tree from before the English
# rename (a --rollback to an older SHA); empty when the tree has neither.
tree_script() {
  local name
  for name in "$@"; do
    [[ ! -f "$TREE/deploy/$name" ]] || { echo "$name"; return; }
  done
}

# --- topology of the SHA's compose: kept images, services of the start and the mem/memswap pair ------
# The `config` only resolves the compose (with the env), without touching the daemon.
if "${COMPOSE[@]}" config --format json > "$work/compose.json" 2> "$work/compose.err"; then
  "$PYTHON" deploy/deploy_lib.py topology "$work/compose.json" > "$work/topology.tsv"
else
  problems+=("the compose of $SHA does not resolve: $(head -n 1 "$work/compose.err")")
  : > "$work/topology.tsv"
fi
declare -A IMAGE_SERVICE=()
while IFS=$'\t' read -r kind value service; do
  case "$kind" in
    image) IMAGES+=("$value"); IMAGE_SERVICE[$value]="$service" ;;
    app) APP+=("$value") ;;
    problem) problems+=("$value") ;;
  esac
done < "$work/topology.tsv"
# An image not built now must already be on the host (the first `eclume-edge:prod` comes from the build).
if [[ -z "$ROLLBACK" ]]; then
  for image in "${IMAGES[@]}"; do
    [[ " ${BUILD[*]} " != *" ${IMAGE_SERVICE[$image]} "* ]] || continue
    docker image inspect "eclume-$image:prod" >/dev/null 2>&1 \
      || problems+=("the image eclume-$image:prod is missing on the host: build ${IMAGE_SERVICE[$image]} (--services)")
  done
fi

# --- product version: its first deploy creates the v<version> tag on the SHA (versionamento.md) ------
# No tag on a rollback, with the tag already created or with entries under [Unreleased], which ask
# to cut the version. A tree from before the English rename has deploy/versao.py, which speaks pt-BR.
VERSION=""
VERSION_TAG=""
version_script="$(tree_script version.py versao.py)"
version_of() {
  if [[ "$version_script" == version.py ]]; then
    "$PYTHON" "$TREE/deploy/version.py" --root "$TREE" current product
  else
    "$PYTHON" "$TREE/deploy/versao.py" --raiz "$TREE" atual produto
  fi
}
unreleased_notes() {
  if [[ "$version_script" == version.py ]]; then
    "$PYTHON" "$TREE/deploy/version.py" --root "$TREE" notes product Unreleased
  else
    "$PYTHON" "$TREE/deploy/versao.py" --raiz "$TREE" notas produto "Não lançado"
  fi
}
[[ -z "$version_script" ]] || VERSION="$(version_of || true)"
if [[ -z "$VERSION" ]]; then
  version_plan="no deploy/version.py in the target"
elif [[ -n "$ROLLBACK" ]]; then
  version_plan="$VERSION (rollback: no tag)"
elif git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
  || git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  version_plan="$VERSION (the tag v$VERSION already exists)"
elif [[ -n "$(unreleased_notes || true)" ]]; then
  version_plan="$VERSION, no tag: CHANGELOG.md has entries under [Unreleased]; cut the version first"
else
  VERSION_TAG="v$VERSION"
  version_plan="$VERSION (the deploy creates and pushes the tag $VERSION_TAG)"
fi

# --- HTTPS CA: the active one (ECLUME_TLS_CA) and the own root with a name constraint ---------------
# Rotation in three steps (announce, switch, retire): docs/project/deploy-producao.md, "CA raiz nos
# clientes". A tree without the `eclume` CA (a --rollback to before it) does not use the own root.
TLS_CA=""
[[ ! -f "$ENV_FILE" ]] || TLS_CA="$(env_value ECLUME_TLS_CA)"
TLS_CA="${TLS_CA:-local}"
CA_DIR="$DATA_DIR/secrets/ca"
root_sha() { openssl x509 -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1; }
own_root_sha() {
  local pem
  pem="$(host "cat '$CA_DIR/raiz.crt' 2>/dev/null || true")"
  [[ -z "$pem" ]] || root_sha <<< "$pem"
}
uses_own_ca=0
grep -q 'ca eclume {' "$TREE/deploy/docker-compose.prod.yml" && uses_own_ca=1
own_sha="$(own_root_sha)"
case "$TLS_CA" in
  local|eclume) ;;
  *) problems+=("ECLUME_TLS_CA=$TLS_CA: use local (Caddy's root) or eclume (own root)") ;;
esac
if [[ "$TLS_CA" == eclume && "$uses_own_ca" -eq 0 ]]; then
  problems+=("ECLUME_TLS_CA=eclume, but the compose of $SHA has no eclume CA")
fi
# Switching without announcing would swap the root of whoever already trusts the published one: announce first with `local`.
if [[ "$TLS_CA" == eclume && -z "$own_sha" ]] && host "test -s '$DATA_DIR/downloads/eclume-root.crt'"; then
  problems+=("ECLUME_TLS_CA=eclume without the own root in $CA_DIR: clients trust the published root; first deploy with ECLUME_TLS_CA=local, which generates it and announces it as the next one")
fi
# service_id and gpu_busy, shared with deploy/gpu-e2e.sh.
# shellcheck source=deploy/gpu-lib.sh
source "$ROOT/deploy/gpu-lib.sh"

pg="$(service_id postgres)"
applied=""
[[ -z "$pg" ]] || applied="$(docker exec "$pg" psql -U eclume -d eclume -Atc 'select version from schema_migrations' 2>/dev/null || true)"
printf '%s\n' "$applied" | sed '/^$/d' | sort > "$work/migrations.database"
printf '%s\n' "$known_migrations" | sed '/^$/d' | sort > "$work/migrations.target"
pending="$(comm -13 "$work/migrations.database" "$work/migrations.target" | paste -sd, -)"
[[ -n "$pg" ]] || pending="(database down: the migrate applies whatever is missing)"

busy="$(gpu_busy)"

rollback_decision=""
if [[ -n "$ROLLBACK" ]]; then
  if rollback_decision="$("$PYTHON" deploy/deploy_lib.py rollback "$work/deploys.log" "$SHA" "$work/migrations.database" "$work/migrations.target" --kept "$KEPT")"; then
    :
  else
    problems+=("--rollback refused: $rollback_decision")
  fi
  for image in "${IMAGES[@]}"; do
    docker image inspect "eclume-$image:$SHA" >/dev/null 2>&1 || problems+=("the kept image eclume-$image:$SHA is missing")
  done
fi

disk_pct() { host "df --output=pcent / | tail -n 1 | tr -dc 0-9"; }

# --- plan ------------------------------------------------------------------------------------------
pct="$(disk_pct)"
echo "Target $SHA · gate: $gate" >&2
echo "Product version: $version_plan" >&2
if [[ -n "$PROD_SHA" ]]; then
  if [[ -z "$ROLLBACK" ]] && git cat-file -e "$PROD_SHA^{commit}" 2>/dev/null; then
    between="$(git rev-list --count "$PROD_SHA..$SHA" 2>/dev/null || echo '?')"
  else
    between="?"
  fi
  echo "In production: $PROD_SHA · commits to the target: $between" >&2
else
  echo "In production: no record in $LOG" >&2
fi
[[ -z "$OFF_MAIN" ]] || echo "Off main: $OFF_MAIN" >&2
[[ -z "$ROLLBACK" ]] || echo "Rollback: $rollback_decision" >&2
echo "Pending migrations: ${pending:-none}" >&2
if [[ -n "$env_diverge" ]]; then echo "Env × host: diverges in ${env_diverge% }" >&2; else echo "Env × host: equal by key" >&2; fi
echo "GPU: $([[ "$busy" == 1 ]] && echo "busy (the deploy waits up to ${GPU_WAIT} min)" || echo free)" >&2
for p in "${problems[@]}"; do echo "  warning: $p" >&2; done
echo "Daemon: context $CONTEXT · SSH: $SSH · data: $DATA_DIR · URL: $PUBLIC_URL" >&2
echo "Host disk: ${pct}% (limit ${DISK_LIMIT}%)" >&2
# Age of the last `ok` of each nightly stage (estado/<stage>.json, the same contract as watchdog.sh).
# The stage and folder names on the host stay in pt-BR: they are host data.
host "for e in backup fora ensaio; do
  f='$DATA_DIR/estado/'\$e.json
  if [ ! -f \$f ]; then echo \"  \$e: no state\"
  elif grep -Eq '\"ok\"[[:space:]]*:[[:space:]]*true' \$f; then echo \"  \$e: ok \$(( (\$(date +%s) - \$(stat -c %Y \$f)) / 3600 )) h ago\"
  else echo \"  \$e: failed (\$(stat -c %y \$f | cut -c1-16))\"; fi
done" >&2 || echo "  state of the nightly stages: host did not answer" >&2
if [[ "$uses_own_ca" -eq 1 ]]; then
  echo "Active CA: $TLS_CA · own root: ${own_sha:-absent (the deploy generates it in $CA_DIR)}" >&2
  if [[ "$TLS_CA" == local ]]; then
    echo "Next root (/downloads/eclume-root-proxima.crt): ${own_sha:-the one generated in this deploy}" >&2
  else
    echo "Next root: none (publish-ca deletes /downloads/eclume-root-proxima.crt)" >&2
  fi
else
  echo "Active CA: local (the compose of $SHA has no eclume CA)" >&2
fi
echo "Build: ${BUILD[*]:-nothing}" >&2
echo "Start: postgres redis minio → minio-init, migrate → ${APP[*]:-?} → caddy (removes the orphans) → publish-ca → mdns" >&2
for image in "${IMAGES[@]}"; do
  if docker image inspect "eclume-$image:prod" >/dev/null 2>&1; then echo "  image eclume-$image:prod: present" >&2
  else echo "  image eclume-$image:prod: absent" >&2; fi
done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

# Refuses before writing to the host.
if [[ "${#problems[@]}" -gt 0 ]]; then
  printf 'Deploy refused:\n' >&2; printf '  - %s\n' "${problems[@]}" >&2; exit 2
fi
(( pct < DISK_LIMIT )) || { echo "Host disk at ${pct}%: above ${DISK_LIMIT}%, deploy refused." >&2; exit 3; }
if [[ "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="$(waiver="deploy: $SKIP_GATE"; echo "${waiver:0:140}")" --silent \
    || { echo "Could not publish the eclume/gate-dispensa trace; deploy refused." >&2; exit 2; }
  echo "Gate waived: $SKIP_GATE (eclume/gate-dispensa trace on the commit)." >&2
fi

# Git Bash on the Windows workstation has no flock: there the lock is a directory (mkdir is atomic).
if command -v flock >/dev/null; then
  exec 9>deploy/.deploy.lock
  flock -n 9 || { echo "Another deploy is running." >&2; exit 3; }
else
  mkdir deploy/.deploy.lock.d 2>/dev/null || { echo "Another deploy is running (or deploy/.deploy.lock.d was left over)." >&2; exit 3; }
  lock_dir=deploy/.deploy.lock.d
fi

# --- host: folders, secrets, backup scripts --------------------------------------------------------
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
echo "Preparing $DATA_DIR on the host…" >&2
host "set -e
  mkdir -p '$DATA_DIR'/{pg,redis,minio,caddy/data,caddy/config,models,downloads,backups/pre-deploy,bin}
  install -d -m 700 '$DATA_DIR/secrets'
  if [ ! -e '$DATA_DIR/secrets/hf_token' ]; then
    install -m 600 /dev/null '$DATA_DIR/secrets/hf_token'
    echo 'Warning: no Hugging Face token ($DATA_DIR/secrets/hf_token empty): transcription without diarization.' >&2
  fi"
if [[ -n "$env_diverge" ]]; then
  host "cp -p '$DATA_DIR/secrets/env.prod' '$DATA_DIR/secrets/env.prod.$stamp'"
  echo "Host env saved in $DATA_DIR/secrets/env.prod.$stamp (--replace-env)." >&2
fi
host "umask 077; cat > '$DATA_DIR/secrets/env.prod'" < "$ENV_FILE"
# Each host script goes under the name its tree has (the pt-BR one before the English rename); the
# counterpart under the other name is removed, so bin/ holds exactly one of them.
install_script() {
  local found="$1" other="$2"
  host "cat > '$DATA_DIR/bin/$found' && chmod 755 '$DATA_DIR/bin/$found'" < "$TREE/deploy/$found"
  [[ "$found" == "$other" ]] || host "rm -f '$DATA_DIR/bin/$other'"
}
install_script backup.sh backup.sh
restore_script="$(tree_script restore-backup.sh restaurar-backup.sh)"
install_script "$restore_script" "$([[ "$restore_script" == restore-backup.sh ]] && echo restaurar-backup.sh || echo restore-backup.sh)"
install_script staging.sh staging.sh
# The rehearsal subcommand that the tree's staging.sh speaks.
if grep -qE '^ *rehearse[|)]' "$TREE/deploy/staging.sh"; then rehearse=rehearse; else rehearse=ensaio; fi
# Local restic repository (backup.sh): password generated on the host the first time. The copy of the
# password and the off-host destination (secrets/restic-fora.env) belong to the owner: docs/project/deploy-producao.md.
restic_image="$(sed -n 's/^RESTIC_IMAGE="${RESTIC_IMAGE:-\(.*\)}"$/\1/p' "$TREE/deploy/backup.sh")"
host "set -e
  install -d -m 700 '$DATA_DIR/estado' '$DATA_DIR/backups/restic' '$DATA_DIR/backups/.restic-cache'
  if [ ! -s '$DATA_DIR/secrets/restic-password' ]; then
    (umask 077; openssl rand -base64 32 > '$DATA_DIR/secrets/restic-password')
    echo 'Warning: new backup password in $DATA_DIR/secrets/restic-password; keep a copy off the host.' >&2
  fi
  if [ ! -f '$DATA_DIR/backups/restic/config' ]; then
    docker run --rm -v '$DATA_DIR/backups/restic:/repo' -v '$DATA_DIR/secrets/restic-password:/run/restic-password:ro' \
      '$restic_image' init --repo /repo --password-file /run/restic-password >/dev/null
    echo 'Local restic repository initialized in $DATA_DIR/backups/restic.' >&2
  fi
  [ -s '$DATA_DIR/secrets/restic-fora.env' ] || echo 'Warning: no $DATA_DIR/secrets/restic-fora.env: the backup does not leave the host (owner decision).' >&2"
# User cron (without linger, a systemd user timer would not run outside a session): backup at 03:30
# and, after it, the restore rehearsal of the off-host repository on eclume-staging. Lines with the
# tags from before the English rename (`# eclume-ensaio`, `# eclume-vigia`) are removed too.
host "(crontab -l 2>/dev/null | grep -v '# eclume-backup$' | grep -v '# eclume-rehearsal$' | grep -v '# eclume-ensaio$' || true
  echo '30 3 * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/backup.sh >> $DATA_DIR/backups/backup.log 2>&1 # eclume-backup'
  echo '30 4 * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/staging.sh $rehearse >> $DATA_DIR/backups/ensaio.log 2>&1 # eclume-rehearsal'
) | crontab -"
# Production checker (alerts) every 5 min; state per condition in estado/vigia/.
watchdog_script="$(tree_script watchdog.sh vigia.sh)"
host "install -d -m 700 '$DATA_DIR/estado' '$DATA_DIR/estado/vigia'"
install_script "$watchdog_script" "$([[ "$watchdog_script" == watchdog.sh ]] && echo vigia.sh || echo watchdog.sh)"
host "(crontab -l 2>/dev/null | grep -v '# eclume-watchdog$' | grep -v '# eclume-vigia$' || true
  echo '*/5 * * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/$watchdog_script >> $DATA_DIR/estado/vigia/vigia.log 2>&1 # eclume-watchdog'
) | crontab -"

# --- build on the host's daemon, from the SHA's tree -----------------------------------------------
export BUILDKIT_PROGRESS=plain COMPOSE_PROGRESS=plain
if [[ "${#BUILD[@]}" -gt 0 ]]; then
  echo "Building ${BUILD[*]} of $SHA on the host…" >&2
  "${COMPOSE[@]}" build "${BUILD[@]}"
  pct="$(disk_pct)"
  (( pct < DISK_LIMIT )) || { echo "Host disk at ${pct}% after the build: above ${DISK_LIMIT}%, stopped before the up." >&2; exit 3; }
fi
if [[ -n "$ROLLBACK" ]]; then
  for image in "${IMAGES[@]}"; do docker tag "eclume-$image:$SHA" "eclume-$image:prod"; done
else
  # Each deploy leaves a complete trio tagged with the SHA, built or not.
  for image in "${IMAGES[@]}"; do
    docker image inspect "eclume-$image:$SHA" >/dev/null 2>&1 || docker tag "eclume-$image:prod" "eclume-$image:$SHA"
  done
fi

# --- own root: generated once by the server image, never overwritten -------------------------------
# Caddy does not start without it (`pki` block), even with the active `local`. Only secrets/ca is mounted.
# The server CLI subcommand and its flags (`ca gerar --pasta --nomes`) are still pt-BR.
if [[ "$uses_own_ca" -eq 1 && -z "$own_sha" ]]; then
  echo "Generating the own root in $CA_DIR…" >&2
  host "install -d -m 700 '$CA_DIR'"
  # Without MSYS_NO_PATHCONV, Windows' Git Bash rewrites the host path in `-v` and `--pasta`.
  MSYS_NO_PATHCONV=1 docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$(host 'echo "$(id -u):$(id -g)"')" -v "$CA_DIR:/ca" eclume-server:prod \
    eclume-server ca gerar --pasta /ca --host "$(env_value ECLUME_PUBLIC_HOST)" \
    --nomes "$(env_value_compat ECLUME_CA_NAMES ECLUME_CA_NOMES)" >&2
  own_sha="$(own_root_sha)"
  [[ -n "$own_sha" ]] || { echo "The own root did not show up in $CA_DIR; stopped before the up." >&2; exit 1; }
fi

# --- GPU: does not kill a transcription in progress ------------------------------------------------
deadline=$(( $(date +%s) + GPU_WAIT * 60 ))
while [[ "$(gpu_busy)" == 1 && "$(date +%s)" -lt "$deadline" ]]; do
  echo "GPU busy with a transcription; waiting (up to ${GPU_WAIT} min)…" >&2
  sleep 30
done
interrupted=0
if [[ "$(gpu_busy)" == 1 ]]; then
  [[ "$INTERRUPT_GPU" -eq 1 ]] || {
    echo "The GPU stayed busy for ${GPU_WAIT} min: deploy refused (--interrupt-gpu to stop it anyway)." >&2; exit 3; }
  echo "Interrupting the busy worker-gpu (--interrupt-gpu)…" >&2
  "${COMPOSE[@]}" stop -t 10 worker-gpu
  interrupted=1
fi

# --- start -----------------------------------------------------------------------------------------
# One-shots outside `--wait`: it treats as a failure the exit 0 of a service no other one waits for.
echo "Starting the infrastructure…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 120 postgres redis minio
dump="-"
applied_now="-"
if [[ -z "$ROLLBACK" ]]; then
  "${COMPOSE[@]}" run --rm minio-init
  pg="$(service_id postgres)"
  applied="$(docker exec "$pg" psql -U eclume -d eclume -Atc 'select version from schema_migrations' 2>/dev/null || true)"
  printf '%s\n' "$applied" | sed '/^$/d' | sort > "$work/migrations.database"
  pending="$(comm -13 "$work/migrations.database" "$work/migrations.target" | paste -sd, -)"
  if [[ -n "$pending" ]]; then
    # Before a pending migration, a database dump: the way back beyond one step.
    dump="$DATA_DIR/backups/pre-deploy/eclume-$stamp-${SHA:0:12}.dump"
    echo "Pending migrations ($pending): pre-deploy dump in $dump…" >&2
    host "set -e; umask 077; docker exec '$pg' pg_dump -U eclume -Fc eclume > '$dump.tmp' && mv '$dump.tmp' '$dump'"
    applied_now="$pending"
  fi
  "${COMPOSE[@]}" run --rm migrate
fi
echo "Starting the services…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 180 "${APP[@]}"
# Compose does not recreate a container when only `configs.content` changes: Caddy is always
# recreated, so the SHA's Caddyfile takes effect. The CA is in the volume and survives. With the new
# edge up, the containers of services the SHA's compose no longer has go away (`web`, `worker-cpu`
# and `worker-agents` after holetz/eclume#151; the `worker` on a --rollback to before it).
"${COMPOSE[@]}" up -d --no-build --force-recreate --remove-orphans --wait --wait-timeout 60 caddy
# The `worker`'s `--wait` may have passed on the health keys of the old workers, which renew them
# until they leave as orphans (and delete them when closing): with them gone, both queues must have
# the new worker's health-check again. The server probe (`sonda fila`) is still pt-BR.
if [[ " ${APP[*]} " == *" worker "* ]]; then
  queues_ok=0
  for _ in $(seq 1 15); do
    if "${COMPOSE[@]}" exec -T worker python -m eclume_server.sonda fila default agents >/dev/null 2>&1; then
      queues_ok=1; break
    fi
    sleep 3
  done
  [[ "$queues_ok" -eq 1 ]] || { echo "Refusal: the worker did not renew the health-check of the default and agents queues in 45 s." >&2; exit 1; }
fi

# The `local` root is born on Caddy's first start; waits for the file and publishes in /downloads/
# the active CA's root (and the own one as next, while the active one is `local`).
for _ in $(seq 1 15); do
  if "${COMPOSE[@]}" run --rm --no-deps publish-ca 2>/dev/null; then published=1; break; fi
  sleep 2
done
[[ "${published:-0}" -eq 1 ]] || echo "Warning: Caddy's CA was not published in $DATA_DIR/downloads." >&2
# The mDNS announcement (host network) is born with the CA already published in the TXT; recreated so the new code holds.
"${COMPOSE[@]}" up -d --no-build --force-recreate --wait --wait-timeout 60 mdns

# --- history and retention -------------------------------------------------------------------------
flags=()
[[ -z "$OFF_MAIN" ]] || flags+=(--off-main)
[[ -z "$ROLLBACK" ]] || flags+=(--rollback)
[[ "$interrupted" -eq 0 ]] || flags+=(--interrupt-gpu)
[[ "$NO_GPU" -eq 0 ]] || flags+=(--no-gpu)
[[ "$gate_ok" -eq 1 ]] || flags+=(--skip-gate)
[[ -z "$env_diverge" ]] || flags+=(--replace-env)
reason="${OFF_MAIN:-${SKIP_GATE:--}}"
entry="$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$stamp" "$SHA" "$(IFS=,; echo "${flags[*]:--}")" "${reason//$'\t'/ }" "$applied_now" "$dump")"
printf '%s\n' "$entry" | host "cat >> '$LOG'"
printf '%s\n' "$entry" >> "$work/deploys.log"
"$PYTHON" deploy/deploy_lib.py kept "$work/deploys.log" "$KEPT" > "$work/kept.tsv"
keep="$(sed -n 's/^keep\t//p' "$work/kept.tsv")"
for image in "${RETENTION[@]}"; do
  for tag in $(docker image ls "eclume-$image" --format '{{.Tag}}' | grep -E '^[0-9a-f]{40}$' || true); do
    grep -qx "$tag" <<< "$keep" || docker image rm "eclume-$image:$tag" >/dev/null 2>&1 || true
  done
done
sed -n 's/^remove-dump\t//p' "$work/kept.tsv" | while read -r old_dump; do host "rm -f '$old_dump'"; done
# The `:prod` tag of an image the SHA's topology no longer uses (`eclume-web` after
# holetz/eclume#151): the kept `:<sha>` ones stay for the `--rollback`.
for image in "${RETENTION[@]}"; do
  [[ " ${IMAGES[*]} " == *" $image "* ]] || docker image rm "eclume-$image:prod" >/dev/null 2>&1 || true
done
# eclume images left untagged (the ones outside the window). Nothing from other projects.
docker image prune -f --filter label=org.eclume.image >/dev/null
# BuildKit cache older than 7 days; the recent one stays for the next build.
docker builder prune -f --filter until=168h >/dev/null || echo "Warning: pruning the build cache failed." >&2

# --- check -----------------------------------------------------------------------------------------
ca="$(mktemp)"
host "cat '$DATA_DIR/downloads/eclume-root.crt'" > "$ca"
# Git Bash's curl (Schannel) insists on checking revocation, and Caddy's internal CA publishes no CRL.
revoke=(); curl -V | grep -q Schannel && revoke=(--ssl-no-revoke)
health="$(curl -fsS "${revoke[@]}" --cacert "$ca" "$PUBLIC_URL/api/v1/health" || true)"
if [[ -z "$health" ]]; then
  echo "Deploy is up, but $PUBLIC_URL/api/v1/health failed through the published CA." >&2
  exit 1
fi
# With the server built now (or kept, on --rollback), /health reports this SHA.
if [[ -n "$ROLLBACK" || " ${BUILD[*]} " == *" server "* ]] && [[ "$health" != *"\"commit\":\"$SHA\""* ]]; then
  echo "Deploy is up, but $PUBLIC_URL/api/v1/health does not report the commit $SHA ($health)." >&2
  exit 1
fi
# The descriptor must carry the fingerprint of the published CA (the one mDNS and the QR announce).
fingerprint="$(openssl x509 -in "$ca" -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
descriptor="$(curl -fsS "${revoke[@]}" --cacert "$ca" "$PUBLIC_URL/api/v1/server" || true)"
if [[ "$descriptor" != *"\"ca_sha256\":\"$fingerprint\""* ]]; then
  echo "Deploy is up, but $PUBLIC_URL/api/v1/server does not carry the fingerprint $fingerprint." >&2
  exit 1
fi
# The curl above already proved the published root anchors the served chain; with the active
# `eclume`, it must be the own root, and the next one is only announced while the active is `local`.
if [[ "$uses_own_ca" -eq 1 ]]; then
  if [[ "$TLS_CA" == eclume && "$fingerprint" != "$own_sha" ]]; then
    echo "Deploy is up, but the published eclume-root.crt ($fingerprint) is not the own root ($own_sha)." >&2
    exit 1
  fi
  if [[ "$TLS_CA" == local && "$descriptor" != *"\"ca_next_sha256\":\"$own_sha\""* ]]; then
    echo "Deploy is up, but $PUBLIC_URL/api/v1/server does not announce the next root $own_sha." >&2
    exit 1
  fi
  if [[ "$TLS_CA" == eclume && "$descriptor" == *'"ca_next_sha256":"'* ]]; then
    echo "Deploy is up, but $PUBLIC_URL/api/v1/server still announces a next root with the active eclume." >&2
    exit 1
  fi
fi
echo "Deploy finished: $SHA at $PUBLIC_URL (health and descriptor ok, CA $TLS_CA $fingerprint, disk $(disk_pct)%)." >&2
if [[ -n "$VERSION_TAG" ]]; then
  if git tag -a "$VERSION_TAG" "$SHA" -m "eclume $VERSION" && git push -q origin "refs/tags/$VERSION_TAG"; then
    echo "Tag $VERSION_TAG created on $SHA and pushed." >&2
  else
    echo "Warning: the tag $VERSION_TAG was not created or pushed; create it on $SHA (git tag -a, git push)." >&2
  fi
fi
