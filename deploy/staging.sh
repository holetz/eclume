#!/usr/bin/env bash
# Ephemeral eclume staging (project `eclume-staging`, deploy/docker-compose.staging.yml), run ON THE
# HOST (<ECLUME_DATA_DIR>/bin/, installed by deploy.sh; the `# eclume-rehearsal` cron runs the rehearsal):
#
#   staging.sh rehearse   restores the backup of the OFF-HOST repository on staging, applies the
#                         `main` migrate, runs smoke_prod.py and the checks, writes estado/ensaio.json
#                         and always leaves with `down -v`; full on Sundays, partial on other days
#   staging.sh up         the same stack (always the full restore), up at https://127.0.0.1:18444 for the proofs
#                         (throwaway account in ~/eclume-staging/conta, CA in ~/eclume-staging/ca/ca.crt)
#   staging.sh down       `down -v` of the stack and of the :staging images
#
# The code is the `main` tarball (gh api, the releases' authenticated `gh`); ECLUME_STAGING_SRC
# points at another tree. Rehearsal checks: sha256 of secrets/ and the PKI against
# estado/secrets.sha256, fingerprint of the restored root against downloads/eclume-root.crt,
# content_hash of a batch of restored audio files and `restic check --read-data-subset` of a
# rotating 1/7 of the off-host repository. Refuses with the disk at 90% or more. Nothing touches
# the `eclume` project. The state file (estado/ensaio.json) and the `conta` file keep their pt-BR
# names: they are host data, read by the watchdog and by mobile/scripts/prove-emulator.sh.
#
# Weight: the `eclume-server:<sha>` and `eclume-web:<sha>` (or `eclume-edge:<sha>`) images the
# deploy kept for the `main` SHA are reused, without build; only what is missing is built. The FULL
# rehearsal (Sunday, or ECLUME_REHEARSAL_DAY=7) restores the whole snapshot, checks the audio batch
# and runs the summary and chat smoke; the PARTIAL one (the other days) restores only database,
# secrets and Caddy plus the batch's audio files, and runs the read-only smoke. Every container gets
# `--cpu-shares 256` (production shares the host with staging) and restic and mc, `GOMAXPROCS=1`.
# Deprecated pt-BR names, still read as a fallback: ECLUME_STAGING_LOTE, ECLUME_ENSAIO_DIA.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
SECRETS="$DATA_DIR/secrets"
STATE="$DATA_DIR/estado"
STAGING_DIR="${STAGING_DIR:-$HOME/eclume-staging}"
REST="$STAGING_DIR/restored"
# The staging Caddy's CA, also mounted in the server (/api/v1/server gives the app its fingerprint).
CA="$STAGING_DIR/ca/ca.crt"
URL=https://127.0.0.1:18444
EMAIL=staging@eclume.invalid
BATCH="${ECLUME_STAGING_BATCH:-${ECLUME_STAGING_LOTE:-20}}"
CPU_SHARES=256
# The rehearsal is full on Sundays (date +%u = 7); ECLUME_REHEARSAL_DAY forces the day. `up` is always full.
DAY="${ECLUME_REHEARSAL_DAY:-${ECLUME_ENSAIO_DIA:-$(date +%u)}}"
SHA="${ECLUME_STAGING_SHA:-}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5}"

case "${1:-}" in
  rehearse|up|down) action="$1" ;;
  --help|-h) sed -n '2,26p' "$0"; exit 0 ;;
  *) sed -n '2,26p' "$0" >&2; exit 2 ;;
esac

full=1
[[ "$action" != rehearse || "$DAY" -eq 7 ]] || full=0

log() { echo "$(date '+%F %T') $*"; }
state() {
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  mkdir -p "$STATE"
  printf '{"ok": %s, "at": "%s", "detalhe": "%s"}\n' "$2" "$(date -Iseconds)" "$detail" > "$STATE/.$1.json.tmp"
  mv -f "$STATE/.$1.json.tmp" "$STATE/$1.json"
}
# The CPU weight of every service comes in through an extra file, without touching `main`'s compose.
CPU_YML="$STAGING_DIR/cpu-shares.yml"
compose() {
  docker compose -p eclume-staging -f "$SRC/deploy/docker-compose.staging.yml" -f "$CPU_YML" "$@"
}
offsite() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --env-file "$SECRETS/restic-fora.env" "${rclone_dest[@]}" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
tear_down() {
  [[ ! -f "$SRC/deploy/docker-compose.staging.yml" ]] || compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm eclume-server:staging eclume-web:staging eclume-edge:staging >/dev/null 2>&1 || true
  rm -rf "$REST"
}

SRC="${ECLUME_STAGING_SRC:-$STAGING_DIR/main}"
install -d -m 700 "$STAGING_DIR"
# Only the services `main`'s compose declares (without `web` since holetz/eclume#151).
write_cpu_yml() {
  printf 'services: {}\n' > "$CPU_YML"
  if [[ -f "$SRC/deploy/docker-compose.staging.yml" ]]; then
    services="$(awk '/^services:/ {d=1; next} /^[^ #]/ {d=0} d && /^  [a-z][a-z0-9-]*:/ {sub(":", "", $1); print $1}' \
      "$SRC/deploy/docker-compose.staging.yml")"
    if [[ -n "$services" ]]; then
      printf 'services:\n' > "$CPU_YML"
      while read -r service; do
        printf '  %s:\n    cpu_shares: %s\n' "$service" "$CPU_SHARES" >> "$CPU_YML"
      done <<< "$services"
    fi
  fi
}
write_cpu_yml
if [[ "$action" == down ]]; then
  tear_down
  rm -rf "$STAGING_DIR"
  log "eclume-staging torn down"
  exit 0
fi

step="start"
finish() {
  local status=$?
  rm -rf "$REST"
  if [[ "$action" == rehearse || "$status" -ne 0 ]]; then tear_down; fi
  if [[ "$action" == rehearse ]]; then
    if [[ "$status" -eq 0 ]]; then
      state ensaio true "$summary"
    else
      log "ERROR in the rehearsal: $step (exit $status)"
      state ensaio false "failed at: $step"
    fi
  fi
}
trap finish EXIT
install -d -m 700 "$STAGING_DIR"

step="disk"
pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
(( pct < 90 )) || { step="disk at ${pct}%: above 90%, staging refused"; exit 3; }
step="no $SECRETS/restic-fora.env: the rehearsal reads the off-host repository"
[[ -s "$SECRETS/restic-fora.env" && -s "$SECRETS/restic-password" ]] || exit 1
step="rclone binary of the off-host destination"
# rclone destination (RESTIC_REPOSITORY=rclone:<remote>:<path>, like OneDrive): the restic image does
# not ship the `rclone` it calls. The pinned image's static binary comes in through a volume, which
# Docker fills with its /usr/local/bin on the first mount; the configuration, from
# secrets/restic-rclone/, comes in writable because rclone renews the OAuth token (and rewrites it as root).
rclone_dest=()
if grep -q '^RESTIC_REPOSITORY=rclone:' "$SECRETS/restic-fora.env"; then
  volume="eclume-rclone-$(cut -c1-12 <<< "${RCLONE_IMAGE##*sha256:}")"
  docker run --rm --network none -v "$volume:/usr/local/bin" --entrypoint true "$RCLONE_IMAGE"
  rclone_dest=(-v "$volume:/usr/local/bin:ro" -v "$SECRETS/restic-rclone:/run/rclone" -e RCLONE_CONFIG=/run/rclone/rclone.conf)
fi

step="main code"
if [[ -z "${ECLUME_STAGING_SRC:-}" ]]; then
  log "code: main tarball"
  SHA="$(gh api repos/holetz/eclume/commits/main --jq .sha)"
  rm -rf "$SRC" && mkdir -p "$SRC"
  gh api "repos/holetz/eclume/tarball/$SHA" | tar -xz --strip-components=1 -C "$SRC"
fi

write_cpu_yml

# restore [--include <snapshot path>…]: the most recent snapshot of the off-host repository in $REST.
restore() {
  offsite -v "$REST:/out" --entrypoint sh "$RESTIC_IMAGE" -c \
    'owner="$1"; shift; restic restore latest --host eclume --no-cache --target /out "$@" && chown -R "$owner" /out' \
    sh "$(id -u):$(id -g)" "$@"
}
step="restore of the off-host repository"
rm -rf "$REST" && install -d -m 700 "$REST"
if [[ "$full" -eq 1 ]]; then
  log "restic: most recent snapshot of the off-host repository, whole"
  restore
else
  log "restic: most recent snapshot of the off-host repository, only database, secrets and Caddy"
  restore --include /eclume/pg --include /eclume/secrets --include /eclume/caddy
fi
R="$REST/eclume"
step="restored env.prod without ECLUME_ENCRYPTION_KEY"
ECLUME_ENCRYPTION_KEY="$(sed -n 's/^ECLUME_ENCRYPTION_KEY=//p' "$R/secrets/env.prod" | tail -n 1)"
[[ -n "$ECLUME_ENCRYPTION_KEY" ]] || exit 1
ECLUME_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ECLUME_CLAUDE_OAUTH_TOKEN=//p' "$R/secrets/env.prod" | tail -n 1)"
install -d -m 755 "$STAGING_DIR/ca"
export ECLUME_ENCRYPTION_KEY ECLUME_CLAUDE_OAUTH_TOKEN ECLUME_DATA_DIR="$DATA_DIR" ECLUME_STAGING_CA_DIR="$STAGING_DIR/ca"

# The `:staging` images come from the SHA's kept ones when they exist (the deploy leaves
# `eclume-server:<sha>` and `eclume-web:<sha>`, or `eclume-edge:<sha>`); only what is missing is
# built. In the full rehearsal the kept server needs `claude` (the summary smoke runs through `claude -p`).
step=":staging images"
web_image="$(grep -oE 'eclume-(web|edge):staging' "$SRC/deploy/docker-compose.staging.yml" | head -n 1 || true)"
web_image="${web_image:-eclume-web:staging}"
web_service="$(awk '/^  [a-z-]+:$/ {s=$1} /image: eclume-(web|edge):staging/ {sub(":", "", s); print s; exit}' \
  "$SRC/deploy/docker-compose.staging.yml")"
web_service="${web_service:-web}"
build=(server "$web_service")
if [[ -n "$SHA" ]]; then
  build=()
  if docker image inspect "eclume-server:$SHA" >/dev/null 2>&1 \
      && { [[ "$full" -eq 0 ]] || docker run --rm --entrypoint claude "eclume-server:$SHA" --version >/dev/null 2>&1; }; then
    docker tag "eclume-server:$SHA" eclume-server:staging
    log "kept image eclume-server:$SHA reused"
  else
    build+=(server)
  fi
  reused=0
  for name in eclume-web eclume-edge; do
    if docker image inspect "$name:$SHA" >/dev/null 2>&1; then
      docker tag "$name:$SHA" "$web_image"
      log "kept image $name:$SHA reused"
      reused=1
      break
    fi
  done
  [[ "$reused" -eq 1 ]] || build+=("$web_service")
fi
if (( ${#build[@]} > 0 )); then
  log "build (:staging): ${build[*]}"
  BUILDKIT_PROGRESS=plain compose build "${build[@]}"
fi
step="restored database and bucket"
compose up -d --wait --wait-timeout 120 postgres redis minio
# The roles come before the dump; "already exists" (the eclume superuser) is expected.
compose exec -T postgres psql -U eclume -q -d postgres < "$R/pg/roles.sql" >/dev/null 2>&1 || true
compose exec -T postgres pg_restore -U eclume -d eclume --exit-on-error < "$R/pg/eclume.dump"
# The batch of checked audio files: drawn from the restored database. In the partial rehearsal only they come back from the snapshot.
step="audio batch from the restored database"
batch="$(compose exec -T postgres psql -U eclume -d eclume -qAt -c \
  "select audio_key, content_hash from recordings where audio_key is not null and content_hash like 'sha256:%' order by random() limit $BATCH")"
if [[ "$full" -eq 0 ]]; then
  step="restore of the batch's audio files"
  include=()
  while IFS='|' read -r key _; do
    [[ -z "$key" ]] || include+=(--include "/eclume/minio/$key")
  done <<< "$batch"
  (( ${#include[@]} == 0 )) || restore "${include[@]}"
fi
step="restored database and bucket"
mkdir -p "$R/minio"
compose run --rm -e GOMAXPROCS=1 -v "$R/minio:/mirror:ro" --entrypoint sh minio-init -c \
  'mc alias set local http://minio:9000 eclume eclume-staging-secret >/dev/null && mc mb --ignore-existing local/eclume >/dev/null && mc mirror --quiet /mirror local/eclume >/dev/null'
step="main migrate on the restored database"
compose run --rm migrate
step="stack start"
# Every long-running service `main`'s compose declares (the one-shots stay in the `tools`
# profile): the same script serves the compose with `web` and the two CPU workers and the edge one with the SPA.
compose up -d --wait --wait-timeout 300

step="throwaway accounts"
compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$CA"
chmod 644 "$CA"
password="$(openssl rand -hex 16)"
printf '%s\n' "$password" | compose run --rm -T migrate \
  eclume-server admin create --email "$EMAIL" --name "Admin staging" --password-stdin >/dev/null
notice="$(curl -sf --cacert "$CA" "$URL/api/v1/auth/signup" | python3 -c 'import json, sys; print(json.load(sys.stdin)["notice"]["version"])')"
curl -sf --cacert "$CA" -H 'Content-Type: application/json' -o /dev/null \
  -d "{\"name\": \"Staging\", \"email\": \"$EMAIL\", \"password\": \"$password\", \"notice_version\": \"$notice\"}" \
  "$URL/api/v1/auth/signup"
(umask 077; printf 'ECLUME_URL=%s\nECLUME_CA=%s\nECLUME_EMAIL=%s\nECLUME_PASSWORD=%s\n' "$URL" "$CA" "$EMAIL" "$password" > "$STAGING_DIR/conta")

if [[ "$action" == up ]]; then
  log "eclume-staging up at $URL (account in $STAGING_DIR/conta, CA in $CA); tear it down with: staging.sh down"
  exit 0
fi

step="sha256 of the restored secrets/ and PKI"
log "checks"
[[ -s "$STATE/secrets.sha256" ]] || exit 1
(cd "$R" && sha256sum --quiet -c "$STATE/secrets.sha256")
step="fingerprint of the restored Caddy root"
fingerprint() { openssl x509 -noout -fingerprint -sha256 -in "$1"; }
[[ "$(fingerprint "$R/caddy/data/caddy/pki/authorities/local/root.crt")" == "$(fingerprint "$DATA_DIR/downloads/eclume-root.crt")" ]]
step="content_hash of the restored audio files"
n=0
while IFS='|' read -r key hash; do
  [[ -n "$key" ]] || continue
  [[ -f "$R/minio/$key" ]] || { step="audio file missing from the backup: $key"; exit 1; }
  [[ "sha256:$(sha256sum "$R/minio/$key" | cut -d' ' -f1)" == "$hash" ]] || { step="content_hash diverges: $key"; exit 1; }
  n=$((n + 1))
done <<< "$batch"
slice="$((10#$(date +%j) % 7 + 1))/7"
step="restic check --read-data-subset $slice of the off-host repository"
offsite "$RESTIC_IMAGE" check --no-cache --read-data-subset "$slice" >/dev/null

step="smoke_prod.py on staging"
log "smoke on staging"
smoke=(--url "$URL" --ca "$CA" --email "$EMAIL" --admin-email "$EMAIL")
# A `main` from before the English rename spells the read-only flag in pt-BR.
read_only=--read-only
grep -q -- "--read-only" "$SRC/deploy/smoke_prod.py" || read_only=--somente-leitura
[[ "$full" -eq 1 ]] || smoke+=("$read_only")
ECLUME_SMOKE_PASSWORD="$password" python3 "$SRC/deploy/smoke_prod.py" "${smoke[@]}"
if [[ "$full" -eq 1 ]]; then
  summary="off-host repository snapshot restored; migrate and smoke ok; $n audio files and the slice $slice checked"
else
  summary="partial rehearsal (database, secrets, Caddy and a sample of audio files); migrate and read-only smoke ok; $n audio files and the slice $slice checked"
fi
log "ok: $summary"
