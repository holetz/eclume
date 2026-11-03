#!/usr/bin/env bash
# Daily eclume backup, run ON THE HOST by the cron of the user owning /srv/eclume (deploy.sh installs
# this script in <ECLUME_DATA_DIR>/bin/ and the `# eclume-backup` line in the crontab).
#
#   <ECLUME_DATA_DIR>/bin/backup.sh
#
# One encrypted restic snapshot (AES-256, password in secrets/restic-password) in the local
# repository <ECLUME_DATA_DIR>/backups/restic, with the fixed /eclume paths:
#   /eclume/pg/roles.sql, /eclume/pg/eclume.dump   cluster roles and pg_dump -Fc of the database
#   /eclume/pre-deploy/                            dumps from before the migrations (deploy.sh)
#   /eclume/minio/                                 mirror of the bucket (backups/minio/.espelho)
#   /eclume/caddy/data/caddy/pki/                  Caddy's internal CA, with root.key
#   /eclume/secrets/                               env.prod, passwords, tokens and keys (no restic-*)
# Retention: KEEP (7) dailies, in both repositories: the `forget` runs every day and the `prune`
# (which rewrites packs and is the expensive part) only on Sundays. With secrets/restic-fora.env
# (RESTIC_REPOSITORY and the destination's credential), the same snapshot goes by `restic copy` to
# the off-host repository, which uses the same password; an rclone destination (OneDrive) reads its
# configuration from secrets/restic-rclone/. The dumps only exist in clear in a temporary folder
# during the run.
#
# State (contract with watchdog.sh): estado/backup.json and estado/fora.json ({"ok", "at", "detalhe"},
# by rename) and estado/secrets.sha256 (sha256sum of secrets/ and of the PKI, paths relative to
# ECLUME_DATA_DIR). The folder, stage and key names are host data and stay in pt-BR.
# Restore: restore-backup.sh (docs/project/deploy-producao.md).
# Deprecated pt-BR variable names, still read as a fallback: MANTER, ECLUME_BACKUP_DIA.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
KEEP="${KEEP:-${MANTER:-7}}"
# The host is also CI and staging: every backup container gets a low CPU weight, and the Go of
# restic and mc one core. The `prune` is on Sundays (ECLUME_BACKUP_DAY forces the day, 1-7; 7 = Sunday).
CPU_SHARES=256
DAY="${ECLUME_BACKUP_DAY:-${ECLUME_BACKUP_DIA:-$(date +%u)}}"
PRUNE=()
[[ "$DAY" -ne 7 ]] || PRUNE=(--prune)
# backup.log and ensaio.log (the cron appends to them) move to <name>.1 when they reach this size.
LOG_MAX_KB="${ECLUME_LOG_MAX_KB:-5120}"
DEST="$DATA_DIR/backups"
SECRETS="$DATA_DIR/secrets"
STATE="$DATA_DIR/estado"
REPO="$DEST/restic"
PKI="$DATA_DIR/caddy/data/caddy/pki"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5}"
umask 077

log() { echo "$(date '+%F %T') $*"; }
container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
# state <stage> <true|false> <detail>: the stage's json, by rename (the watchdog reads the mtime).
state() {
  local detail="${3//\\/\\\\}"
  detail="${detail//\"/\\\"}"
  printf '{"ok": %s, "at": "%s", "detalhe": "%s"}\n' "$2" "$(date -Iseconds)" "$detail" > "$STATE/.$1.json.tmp"
  mv -f "$STATE/.$1.json.tmp" "$STATE/$1.json"
}
# restic as root in a container (it reads Caddy's PKI, owned by root), with the local repository in /repo.
restic_() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -e RESTIC_CACHE_DIR=/cache -v "$REPO:/repo" -v "$DEST/.restic-cache:/cache" \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}

stage=backup
tmp=""
finish() {
  local status=$?
  [[ -z "$tmp" ]] || rm -rf "$tmp"
  if [[ "$status" -ne 0 ]]; then
    log "ERROR in stage $stage (exit $status)"
    state "$stage" false "${reason:-failed with exit $status; see backups/backup.log}"
  fi
}
trap finish EXIT
mkdir -p "$STATE" "$DEST/minio/.espelho" "$DEST/pre-deploy" "$DEST/.restic-cache"
for name in backup ensaio; do
  if [[ -f "$DEST/$name.log" && "$(wc -c < "$DEST/$name.log")" -ge $((LOG_MAX_KB * 1024)) ]]; then
    mv -f "$DEST/$name.log" "$DEST/$name.log.1"
  fi
done

reason="no $SECRETS/restic-password or repository in $REPO (run deploy.sh)"
[[ -s "$SECRETS/restic-password" && -f "$REPO/config" ]] || exit 1
pg="$(container postgres)"
minio="$(container minio)"
reason="postgres or minio of the eclume project is not running"
[[ -n "$pg" && -n "$minio" ]] || exit 1
unset reason
tmp="$(mktemp -d "$DEST/.run.XXXXXX")"

log "postgres: dump"
docker exec "$pg" pg_dumpall -U eclume --roles-only > "$tmp/roles.sql"
docker exec "$pg" pg_dump -U eclume -Fc eclume > "$tmp/eclume.dump"

log "minio: bucket mirror"
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$SECRETS/env.prod" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$SECRETS/env.prod" | tail -n 1)"
# The project's internal `dados` network (MinIO is also on `fila-gpu`).
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$minio" | grep '_dados$')"
image="$(docker inspect -f '{{.Config.Image}}' "$minio")"
docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e "MC_HOST_src=http://$user:$pass@minio:9000" -v "$DEST/minio:/b" --entrypoint mc "$image" \
  mirror --overwrite --remove --quiet src/eclume /b/.espelho >/dev/null

log "restic: local snapshot"
sources=(-v "$tmp:/eclume/pg:ro" -v "$DEST/pre-deploy:/eclume/pre-deploy:ro"
  -v "$DEST/minio/.espelho:/eclume/minio:ro" -v "$SECRETS:/eclume/secrets:ro")
[[ ! -d "$PKI" ]] || sources+=(-v "$PKI:/eclume/caddy/data/caddy/pki:ro")
# Fixed --host: the container's hostname changes on every run, and forget groups by host and paths.
restic_ "${sources[@]}" "$RESTIC_IMAGE" backup --host eclume --tag eclume --quiet --read-concurrency 1 \
  --exclude '/eclume/secrets/restic-*' /eclume
restic_ "$RESTIC_IMAGE" forget --host eclume --keep-daily "$KEEP" "${PRUNE[@]}" --quiet
# The check of the rehearsal and of the new-host proof: sha256 of what the snapshot took from secrets/ and the PKI.
restic_ "${sources[@]}" --entrypoint sh "$RESTIC_IMAGE" -c \
  'cd /eclume && find secrets $(test -d caddy && echo caddy) -type f ! -path "secrets/restic-*" -exec sha256sum {} + | sort -k 2' \
  > "$STATE/.secrets.sha256.tmp"
mv -f "$STATE/.secrets.sha256.tmp" "$STATE/secrets.sha256"
# The snapshot replaces what the old backup left in clear.
rm -rf "$DEST/pg" "$DEST/caddy"
find "$DEST/minio" -mindepth 1 -maxdepth 1 -name '20*' -exec rm -rf {} +
summary="$(du -sh "$tmp/eclume.dump" | cut -f1) of database, $(find "$DEST/minio/.espelho" -type f | wc -l) files in the bucket"
state backup true "$summary"
log "ok: $summary"

stage=fora
if [[ ! -s "$SECRETS/restic-fora.env" ]]; then
  log "off-host: no $SECRETS/restic-fora.env; off-host copy not configured"
  state fora false "no secrets/restic-fora.env: off-host copy not configured"
  exit 0
fi
log "restic: copy to the off-host repository"
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
offsite_() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --env-file "$SECRETS/restic-fora.env" "${rclone_dest[@]}" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -e RESTIC_CACHE_DIR=/cache -v "$DEST/.restic-cache:/cache" \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
offsite_ -v "$REPO:/repo" "$RESTIC_IMAGE" copy --from-repo /repo \
  --from-password-file /run/restic-password --host eclume --quiet
offsite_ "$RESTIC_IMAGE" forget --host eclume --keep-daily "$KEEP" "${PRUNE[@]}" --quiet
state fora true "snapshot copied; $KEEP dailies kept"
log "ok: off-host copy"
