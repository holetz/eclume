#!/usr/bin/env bash
# The eclume quality gate, the part that runs on the GPU host from the tree extracted from the
# commit's `git archive` (deploy/gate.sh sends it and calls this script). Runs the pillars of
# deploy/pillars.sh, each in a container of the eclume-gate:<Rust> image (CPU, memory and priority
# limited, uid 1000, no Docker socket and no gh token), against the test services and the mock of
# the eclume-gate compose project, and publishes the result on the commit as the `eclume/gate` status.
# Contract: docs/standards/code/monorepo.md.
#
# The pillars are the ones the diff since the last green SHA in the history requires (path map in
# deploy/gate.py, the same as the CI filters); the others are skipped and the status names them.
# With no green SHA to find (first run, rewritten history), it runs them all.
#
# A gate the pre-push hook fires (`--supersedable`) exits without running when `main` has already
# moved past the SHA (publishes `eclume/gate` = error "superseded by <sha>"; the deploy uses the tip);
# a gate requested by hand for a SHA is never abandoned.
# The gpu-e2e pillar (gate only) runs on the host, outside the container, through deploy/gpu-e2e.sh.
# Every gate container carries `--cpu-shares 256`: production shares the host with the gate and wins the CPU.
# Each run prunes logs older than 30 days, build images of old Rust versions and abandoned
# `src-*` trees.
#
# Usage: bash <tree>/deploy/gate-host.sh --sha <sha> [--pillars a,b] [--all] [--supersedable]
#   --pillars       runs only these pillars and publishes no status (partial run).
#   --supersedable  abandons the SHA if `main` has moved past it (pre-push uses it; a manual request does not).
#   --all           publishes the status running every pillar, without looking at the diff.
# Variables: ECLUME_DISK_LIMIT (90), ECLUME_GATE_MEMORY (ceiling per container, 4g),
#            ECLUME_GATE_CACHE_GB (cache budget, 25), ECLUME_GATE_DIR (~/eclume-gate),
#            ECLUME_GATE_SLOTS (gates at once, 2), ECLUME_GATE_JOBS (pillars at once per gate, 2),
#            ECLUME_GATE_CPUS (CPUs per pillar container, 3).
# Measured on 2026-10-01 (holetz/eclume#89), with production up: 16 to 21 minutes; memory peak of
# ~2.6 GiB (windows and desktop, at link time), ~1.7 GiB in web-browser and < 1 GiB in the others;
# ~15 GB of caches after two runs.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"

REPO=holetz/eclume
CONTEXT=eclume/gate
GATE_DIR="${ECLUME_GATE_DIR:-$HOME/eclume-gate}"
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
MEMORY="${ECLUME_GATE_MEMORY:-4g}"
CACHE_GB="${ECLUME_GATE_CACHE_GB:-25}"
SLOTS="${ECLUME_GATE_SLOTS:-2}"
JOBS="${ECLUME_GATE_JOBS:-2}"
CPUS="${ECLUME_GATE_CPUS:-3}"
NDK="${ECLUME_GATE_NDK:-$HOME/android-sdk/ndk/28.2.13676358}"
# The SDK and JDK of mobile/scripts/android-sdk.sh, read-only, for the android pillar.
ANDROID_SDK="${ECLUME_GATE_ANDROID_SDK:-$HOME/android-sdk}"
JDK="${ECLUME_GATE_JDK:-$HOME/jdk-21}"
# The images carry the Rust version of desktop/rust-toolchain.toml in their tag.
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml)"
IMG="eclume-gate:$RUST"
SHA=""
REQUESTED=""
FORCE_ALL=0
SUPERSEDABLE=0
CPU_SHARES=256

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:?--sha needs the commit}"; shift 2 ;;
    --pillars) REQUESTED="${2:?--pillars needs the list}"; shift 2 ;;
    --all) FORCE_ALL=1; shift ;;
    --supersedable) SUPERSEDABLE=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "--sha needs the commit's full SHA." >&2; exit 2; }

mapfile -t EVERY < <(bash deploy/pillars.sh --list)
if [[ -n "$REQUESTED" ]]; then
  IFS=, read -r -a PILLARS <<< "$REQUESTED"
  PUBLISH=0
else
  PILLARS=("${EVERY[@]}")
  PUBLISH=1
fi
SKIPPED=()
SINCE=""

CACHE="$GATE_DIR/cache"
LOG="$GATE_DIR/logs/$SHA.log"
mkdir -p "$CACHE/registry" "$CACHE/home" "$CACHE/gradle" "$GATE_DIR/logs"

# Up to $SLOTS gates run at once, each holding one slot lock; the next one waits for a free slot.
# The slot names the compose project and offsets its ports, so concurrent gates never share services.
# The lock files keep their `.trava-*` names: gates of older SHAs, running the older script, take the
# same locks, so the name must not change between versions.
SLOT=""
while [[ -z "$SLOT" ]]; do
  for ((i = 0; i < SLOTS; i++)); do
    exec 9>"$GATE_DIR/.trava-$i"
    if flock -n 9; then SLOT=$i; break; fi
    exec 9>&-
  done
  if [[ -z "$SLOT" ]]; then
    echo "Waiting for a free gate slot ($SLOTS busy)…" >&2
    sleep 15
  fi
done
PROJECT="eclume-gate-$SLOT"
echo "Gate slot $SLOT (project $PROJECT)" >&2

[[ "$PUBLISH" -eq 0 ]] || exec > >(tee "$LOG") 2>&1
echo "Gate of $SHA · $(date -Is)"

# Publishes the status through the host's gh, retrying until the commit exists on GitHub (the
# pre-push hook fires the gate before the push finishes). Failing for 30 minutes, the result stays in the log.
published=0
publish() {
  local state="$1" description="$2" deadline=$((SECONDS + 1800))
  [[ "$PUBLISH" -eq 1 ]] || return 0
  until gh api "repos/$REPO/statuses/$SHA" -f state="$state" -f context="$CONTEXT" \
      -f description="$description" --silent 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "Could not publish $CONTEXT = $state in 30 minutes; the result stays in this log."
      return 0
    fi
    sleep 15
  done
  echo "Published $CONTEXT = $state: $description"
}

# The CPU weight of the test services and the mock comes in through an extra file, without touching
# the compose files CI also uses.
CPU_YML="$GATE_DIR/cpu-shares-$SLOT.yml"
printf 'services:\n' > "$CPU_YML"
for service in postgres redis minio mock; do
  printf '  %s:\n    cpu_shares: %s\n' "$service" "$CPU_SHARES" >> "$CPU_YML"
done
compose() {
  ECLUME_TEST_PG_PORT=$((55633 + SLOT)) ECLUME_TEST_REDIS_PORT=$((56580 + SLOT)) \
    ECLUME_TEST_MINIO_PORT=$((59201 + SLOT)) ECLUME_MOCK_BIND=127.0.0.1 ECLUME_MOCK_PORT=$((4211 + SLOT)) \
    docker compose -p "$PROJECT" -f deploy/docker-compose.test.yml -f deploy/docker-compose.mock.yml \
    -f "$CPU_YML" "$@"
}

finish() {
  local code=$?
  if [[ "$PUBLISH" -eq 1 && "$published" -eq 0 ]]; then
    publish error "the gate could not prove (exit $code) · log $LOG"
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  cd / && rm -rf "$SRC" "$SRC".p-*
}
trap finish EXIT

# A gate fired by pre-push that `main` has already passed does not run: the tip has its own gate
# (and its diff since the last green covers this SHA). A tip that is equal, behind, diverged or
# unreadable (the push still in flight) abandons nothing.
if [[ "$SUPERSEDABLE" -eq 1 && "$PUBLISH" -eq 1 ]]; then
  tip="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha 2>/dev/null || true)"
  if [[ -n "$tip" && "$tip" != "$SHA" ]] \
      && [[ "$(gh api "repos/$REPO/compare/$SHA...$tip" --jq .status 2>/dev/null || true)" == ahead ]]; then
    publish error "superseded by ${tip:0:7}"
    published=1
    exit 0
  fi
fi

# The nearest green SHA in the history of $1 (the `eclume/gate` status in success); empty if none.
last_green() {
  local c
  while read -r c; do
    [[ "$c" != "$1" ]] || continue
    if gh api "repos/$REPO/commits/$c/status" 2>/dev/null | python3 deploy/gate.py decide >/dev/null; then
      echo "$c"; return 0
    fi
  done < <(gh api "repos/$REPO/commits?sha=$1&per_page=30" --jq '.[].sha' 2>/dev/null)
}

# The pillars the diff from the last green SHA to the SHA requires, decided after the lock (the
# previous run may have just published a newer green). Any failure to know the diff runs them all.
if [[ "$PUBLISH" -eq 1 && "$FORCE_ALL" -eq 0 ]]; then
  # The hook fires the gate before the push reaches GitHub: without the commit there, the history
  # would not find the green and would run them all.
  for _ in $(seq 1 20); do
    gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null && break
    sleep 15
  done
  green="$(last_green "$SHA" || true)"
  if [[ -z "$green" ]]; then
    echo "No green SHA in the history of $SHA: running every pillar."
  elif files="$(gh api "repos/$REPO/compare/$green...$SHA" --paginate \
      --jq '.files[] | .filename, (.previous_filename // empty)' 2>/dev/null)" \
      && required_txt="$(printf '%s\n' "$files" | python3 deploy/gate.py pillars --stdin)"; then
    mapfile -t required <<< "$required_txt"
    [[ -n "${required[0]:-}" ]] || required=()
    # GitHub's compare lists at most 300 files: from there on the diff may be truncated.
    if (( $(printf '%s\n' "$files" | grep -c .) >= 300 )); then
      echo "Diff from $green to $SHA too large to list: running every pillar."
    else
      PILLARS=("${required[@]}")
      SINCE="$green"
      for p in "${EVERY[@]}"; do
        [[ " ${PILLARS[*]} " == *" $p "* ]] || SKIPPED+=("$p")
      done
      echo "Diff since the last green $green: required ${PILLARS[*]:-none}; skipped ${SKIPPED[*]:-none}."
    fi
  else
    echo "Could not get the diff from $green to $SHA: running every pillar."
  fi
fi
echo "Pillars: ${PILLARS[*]:-none}"

publish pending "running ${#PILLARS[@]} pillars · log $LOG"

# --- pruning: what the gate leaves behind -------------------------------------------------------
find "$GATE_DIR/logs" -name '*.log' -mtime +30 -delete 2>/dev/null || true
find "$GATE_DIR" -maxdepth 1 -name 'src-*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
# Build images of old Rust versions (not the current one); docker refuses to remove the ones in use.
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E '^eclume-(gate|desktop-build|desktop-build-windows|mobile-build):' \
  | grep -vF ":$RUST" | xargs -r docker rmi >/dev/null 2>&1 || true

pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
echo "Host disk: ${pct}% (limit ${DISK_LIMIT}%) · memory ceiling per pillar: $MEMORY"
(( pct < DISK_LIMIT )) || { echo "Host disk at ${pct}%: gate refused."; exit 3; }
# Cache budget: above it, the cargo target/ folders (most of it) start from scratch.
cache_gb="$(du -s --block-size=1G "$CACHE" | cut -f1)"
if (( cache_gb > CACHE_GB )); then
  echo "Caches at ${cache_gb} GB, above ${CACHE_GB} GB: deleting the cargo target/ folders."
  rm -rf "$CACHE"/target-*
fi

declare -A RESULT=()
start=$SECONDS
if (( ${#PILLARS[@]} > 0 )); then
# --- images: the release base images, if missing, and the gate's (layers cached) -----------------
export BUILDKIT_PROGRESS=plain
docker image inspect "eclume-desktop-build:$RUST" >/dev/null 2>&1 \
  || docker build -q -t "eclume-desktop-build:$RUST" -f desktop/build.Dockerfile desktop
docker image inspect "eclume-desktop-build-windows:$RUST" >/dev/null 2>&1 \
  || docker build -q --build-arg "RUST=$RUST" -t "eclume-desktop-build-windows:$RUST" - < desktop/build-windows.Dockerfile
docker build -q --build-arg "RUST=$RUST" -t "$IMG" - < deploy/gate.Dockerfile

# --- services: Postgres, Redis, MinIO and the mock, on the project network ----------------------
compose up -d --wait

# Each pillar runs from its own copy of the tree: npm ci, uv sync and the builds write into it, and
# two pillars sharing one tree would race. Up to $JOBS run at once; gpu-e2e runs alone at the end,
# under a host-wide GPU lock, because it needs the host's docker and the only GPU.
PARTS="$GATE_DIR/parts-$SHA-$SLOT"
rm -rf "$PARTS" && mkdir -p "$PARTS"
run_pillar() {
  local pillar="$1" tree="$SRC.p-$1" t0=$SECONDS
  set +e
  echo "=== pillar $pillar · $(date -Is) ==="
  mkdir -p "$CACHE/target-$pillar"
  rm -rf "$tree" && cp -a "$SRC" "$tree"
  # The mock only for the pillars that have it in CI: with ECLUME_MOCK_URL, the eclume-sync test in
  # desktop would stop skipping, and some fixture URLs (127.0.0.1:4010) do not reach the mock.
  local mock=()
  case "$pillar" in contracts|web-browser) mock=(-e ECLUME_MOCK_URL=http://mock:4010) ;; esac
  # The real claude (test_agents_real) runs only in the python pillar, with the host's Claude
  # credential mounted read-only and the CLI binary; without it the pillar fails the skip check.
  local claude=()
  if [[ "$pillar" == python ]]; then
    claude=(-e ECLUME_SKIPS=gate -e ECLUME_TEST_CLAUDE=1
      -v "$HOME/.claude/.credentials.json:/tmp/.claude/.credentials.json:ro"
      -v "$(readlink -f "$HOME/.local/bin/claude"):/usr/local/bin/claude:ro")
  fi
  docker run --rm --name "$PROJECT-$pillar" --network "${PROJECT}_default" \
    --cpus "$CPUS" --cpu-shares "$CPU_SHARES" --memory "$MEMORY" --memory-swap "$MEMORY" --shm-size 1g -u 1000:1000 \
    -e HOME=/tmp -e CI=1 -e CARGO_BUILD_JOBS="$CPUS" -e ECLUME_E2E_WORKERS="$CPUS" -e CARGO_TARGET_DIR=/target \
    -e npm_config_cache=/tmp/.cache/npm -e UV_PYTHON_INSTALL_DIR=/tmp/.cache/uv-python \
    -e UV_LINK_MODE=copy -e ECLUME_ANDROID_NDK=/opt/ndk \
    -e ECLUME_ANDROID_SDK=/opt/android-sdk -e ECLUME_ANDROID_JDK=/opt/jdk -e GRADLE_USER_HOME=/opt/gradle \
    -e ECLUME_TEST_DATABASE_URL=postgresql+asyncpg://eclume:eclume@postgres:5432/eclume \
    -e ECLUME_TEST_REDIS_URL=redis://redis:6379 -e ECLUME_TEST_S3_ENDPOINT=http://minio:9000 \
    "${mock[@]}" "${claude[@]}" \
    -v "$tree:/src" -v "$CACHE/target-$pillar:/target" -v "$CACHE/registry:/opt/cargo/registry" \
    -v "$CACHE/home:/tmp/.cache" -v "$NDK:/opt/ndk:ro" \
    -v "$ANDROID_SDK:/opt/android-sdk:ro" -v "$JDK:/opt/jdk:ro" -v "$CACHE/gradle:/opt/gradle" \
    -w /src "$IMG" nice -n 10 bash deploy/pillars.sh "$pillar"
  local code=$?
  rm -rf "$tree"
  echo "=== pillar $pillar: exit $code in $((SECONDS - t0))s ==="
  echo "$code" > "$PARTS/$pillar.rc"
}

GPU=0
for pillar in "${PILLARS[@]}"; do
  if [[ "$pillar" == gpu-e2e ]]; then GPU=1; continue; fi
  while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n || true; done
  echo "=== pillar $pillar started · $(date -Is) ==="
  run_pillar "$pillar" > "$PARTS/$pillar.log" 2>&1 &
done
wait || true
for pillar in "${PILLARS[@]}"; do
  [[ "$pillar" != gpu-e2e ]] || continue
  cat "$PARTS/$pillar.log"
  RESULT[$pillar]="$(cat "$PARTS/$pillar.rc" 2>/dev/null || echo 1)"
done
rm -rf "$PARTS"

# gpu-e2e needs the host's docker and GPU, which the pillar container lacks: it runs here, on the
# host, and the script starts the eclume-gpu-test compose and runs pytest in a separate eclume-gate container.
# Exits 75 (inconclusive) with the GPU busy past the wait; the status becomes "no proof: gpu-e2e".
if [[ "$GPU" -eq 1 ]]; then
  pillar=gpu-e2e
  echo "=== pillar $pillar · $(date -Is) ==="
  t0=$SECONDS
  set +e
  (
    flock 8
    ECLUME_GATE_IMAGE="$IMG" ECLUME_GATE_CACHE_HOME="$CACHE/home" bash deploy/gpu-e2e.sh
  ) 8>"$GATE_DIR/.trava-gpu"
  RESULT[$pillar]=$?
  set -e
  echo "=== pillar $pillar: exit ${RESULT[$pillar]} in $((SECONDS - t0))s ==="
fi
fi

results=""
for pillar in "${PILLARS[@]}"; do results+="$pillar ${RESULT[$pillar]}"$'\n'; done
echo "Result:"; printf '%s' "$results"

if [[ "$PUBLISH" -eq 0 ]]; then
  published=1
  out=0
  for pillar in "${PILLARS[@]}"; do
    [[ "${RESULT[$pillar]}" -eq 0 ]] || out=1
  done
  # Only an inconclusive gpu-e2e (75): the partial run exits 75, distinct from failure.
  if [[ "$out" -eq 1 ]]; then
    for pillar in "${PILLARS[@]}"; do
      [[ "${RESULT[$pillar]}" -eq 0 || ( "$pillar" == gpu-e2e && "${RESULT[$pillar]}" -eq 75 ) ]] || exit 1
    done
    exit 75
  fi
  exit 0
fi
mapfile -t out < <(printf '%s' "$results" | python3 deploy/gate.py describe --duration "$((SECONDS - start))" --log "$LOG" \
  --skipped "$(IFS=,; echo "${SKIPPED[*]:-}")" --since "$SINCE")
publish "${out[0]}" "${out[1]}"
published=1
[[ "${out[0]}" == success ]]
