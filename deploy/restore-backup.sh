#!/usr/bin/env bash
# Restore of the eclume backup (backup.sh: restic snapshots), run ON THE HOST (<ECLUME_DATA_DIR>/bin/).
#
#   restore-backup.sh [--repository local|offsite] --test [<snap>]   restores into a temporary database
#                                                   and bucket, compares counts with production and deletes it all
#   restore-backup.sh [--repository local|offsite] --apply <snap> --confirm
#                                                   replaces the production database and bucket
#   restore-backup.sh --database <dump> --confirm   replaces only the database, from a pre-deploy
#                                                   dump (backups/pre-deploy/*.dump)
#   restore-backup.sh --new-host <folder>           new host: returns secrets/ and Caddy's PKI from the
#                                                   off-host repository into <folder>, before the first deploy
#
# <snap> is `latest`, the restic id (restic snapshots) or the date YYYY-MM-DD (the day's last
# snapshot); without it, `latest`. The default repository is the local one (backups/restic);
# `offsite` reads the one in secrets/restic-fora.env, with the same password. --new-host needs
# <folder>/secrets/restic-password and <folder>/secrets/restic-fora.env (taken from the vault).
# --apply stops server and workers, recreates the eclume database from the dump, mirrors the
# snapshot's bucket back (without deleting objects that are not in the backup) and starts the
# services again. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
DEST="$DATA_DIR/backups"
# Variables the trap reads (or that change the path) start empty: nothing inherited from the environment is deleted.
work=""
folder=""
dump=""
ENV_FILE="$DATA_DIR/secrets/env.prod"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5}"

repository=local
if [[ "${1:-}" == --repository ]]; then
  repository="${2:-}"
  shift 2 || true
fi
[[ "$repository" == local || "$repository" == offsite ]] || { echo "--repository is local or offsite" >&2; exit 2; }
mode="${1:-}"
case "$mode" in
  --test) snap="${2:-latest}" ;;
  --apply)
    snap="${2:?give the snapshot (latest, id or date)}"
    [[ "${3:-}" == --confirm ]] || { echo "--apply replaces production: repeat it with --confirm." >&2; exit 2; }
    ;;
  --database)
    dump="${2:?give the pre-deploy dump}"
    [[ "${3:-}" == --confirm ]] || { echo "--database replaces the production database: repeat it with --confirm." >&2; exit 2; }
    ;;
  --new-host)
    folder="$(realpath -m "${2:?give the folder of the new host}")"
    repository=offsite
    ;;
  *) sed -n '2,19p' "$0"; exit 2 ;;
esac
SECRETS="${folder:-$DATA_DIR}/secrets"

# restic in a container as root (the restored PKI is owned by root until the chown), no cache.
restic_() {
  local repo=(-e RESTIC_REPOSITORY=/repo -v "$DEST/restic:/repo")
  [[ "$repository" == local ]] || repo=(--env-file "$SECRETS/restic-fora.env" "${rclone_dest[@]}")
  docker run --rm "${repo[@]}" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
# resolve <snap>: a YYYY-MM-DD date becomes the id of the day's last snapshot.
resolve() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "$1"; return; }
  restic_ "$RESTIC_IMAGE" snapshots --host eclume --json --no-cache | python3 -c '
import json, sys
day = sys.argv[1]
ids = [s["short_id"] for s in sorted(json.load(sys.stdin), key=lambda s: s["time"]) if s["time"].startswith(day)]
print(ids[-1] if ids else "")' "$1"
}
# extract <snap> <folder> <include...>: restores the snapshot into <folder>/eclume/ and hands it to the user.
extract() {
  local snap="$1" out="$2"
  shift 2
  local inc=()
  for i in "$@"; do inc+=(--include "$i"); done
  restic_ -v "$out:/out" --entrypoint sh "$RESTIC_IMAGE" -c \
    'snap="$1"; owner="$2"; shift 2; restic restore "$snap" --host eclume --no-cache --target /out "$@" && chown -R "$owner" /out' \
    sh "$snap" "$(id -u):$(id -g)" "${inc[@]}"
}
[[ -s "$SECRETS/restic-password" || "$mode" == --database ]] || { echo "missing $SECRETS/restic-password" >&2; exit 1; }
[[ "$repository" == local || -s "$SECRETS/restic-fora.env" ]] || { echo "missing $SECRETS/restic-fora.env" >&2; exit 1; }
# rclone destination (RESTIC_REPOSITORY=rclone:<remote>:<path>, like OneDrive): the restic image does
# not ship the `rclone` it calls. The pinned image's static binary comes in through a volume, which
# Docker fills with its /usr/local/bin on the first mount; the configuration, from
# secrets/restic-rclone/, comes in writable because rclone renews the OAuth token (and rewrites it as root).
rclone_dest=()
if [[ "$repository" != local ]] && grep -q '^RESTIC_REPOSITORY=rclone:' "$SECRETS/restic-fora.env"; then
  volume="eclume-rclone-$(cut -c1-12 <<< "${RCLONE_IMAGE##*sha256:}")"
  docker run --rm --network none -v "$volume:/usr/local/bin" --entrypoint true "$RCLONE_IMAGE"
  rclone_dest=(-v "$volume:/usr/local/bin:ro" -v "$SECRETS/restic-rclone:/run/rclone" -e RCLONE_CONFIG=/run/rclone/rclone.conf)
fi

# --new-host: only secrets/ and the PKI, into the folder where deploy.sh will create the rest.
if [[ "$mode" == --new-host ]]; then
  install -d -m 700 "$folder/secrets"
  tmp="$(mktemp -d "$folder/.new-host.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  extract latest "$tmp" /eclume/secrets /eclume/caddy
  [[ -s "$tmp/eclume/secrets/env.prod" ]] || { echo "the snapshot has no secrets/env.prod" >&2; exit 1; }
  cp -a "$tmp/eclume/secrets/." "$folder/secrets/"
  if [[ -d "$tmp/eclume/caddy" ]]; then
    mkdir -p "$folder/caddy"
    cp -a "$tmp/eclume/caddy/." "$folder/caddy/"
  fi
  echo "OK: secrets/ and Caddy's PKI restored in $folder; now deploy.sh and --apply latest --confirm"
  exit 0
fi

container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# The cluster's real state: nothing is deleted without proof of another copy (`pg_database` is the
# source of truth). The names eclume_antes (the previous database) and eclume_restore_novo (the
# restored one) are kept from before the English rename: the recovery runbook names them.
sql=()
stopped_ids=()
# exists <db>: 0 exists, 1 does not exist, 2 could not read (never authorizes a delete).
exists() {
  local output
  output="$("${sql[@]}" -c "select 1 from pg_database where datname = '$1'" 2>/dev/null)" || return 2
  [[ "$output" == 1 ]]
}
# drop_with_guarantee <target> <guarantee...>: only drops <target> if some guarantee exists in the cluster.
drop_with_guarantee() {
  local target="$1" g rc
  shift
  for g in "$@"; do
    rc=0
    exists "$g" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      "${sql[@]}" -c "drop database if exists $target" >/dev/null 2>&1 && return 0
      echo "ALERT: could not drop $target; it stays in the cluster" >&2
      return 1
    fi
  done
  echo "ALERT: $target kept: I did not prove there is another copy ($*)" >&2
  return 1
}
# databases_state: what pg_database has now, for the final message.
databases_state() {
  local b rc out=()
  for b in eclume eclume_antes eclume_restore_novo; do
    rc=0
    exists "$b" || rc=$?
    case "$rc" in 0) out+=("$b=yes") ;; 1) out+=("$b=no") ;; *) out+=("$b=?") ;; esac
  done
  echo "${out[*]}"
}
# restart: starts the stopped services, only once; holds on success and on any failure (EXIT trap).
restart() {
  [[ "${#stopped_ids[@]}" -gt 0 ]] || return 0
  local ids=("${stopped_ids[@]}")
  stopped_ids=()
  if docker start "${ids[@]}" >/dev/null; then
    echo "services restarted" >&2
  else
    echo "ALERT: docker start failed; the services may be stopped: ${ids[*]}" >&2
    return 1
  fi
}
cleanup() {
  restart || true
  [[ -z "$work" ]] || rm -rf "$work"
}
# interrupt <code>: INT/TERM in the middle of the swap. Measures pg_database; without a proven
# eclume, it does not restart (starting the services without a database hides the problem) and
# tells the state and how to recover.
interrupt() {
  local rc=0
  trap '' INT TERM
  if [[ "${#sql[@]}" -gt 0 && "${#stopped_ids[@]}" -gt 0 ]]; then
    exists eclume || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      echo "INTERRUPTED: eclume is not proven in pg_database; measured state: $(databases_state). The services stay stopped (${stopped_ids[*]}) and nothing was deleted; recover by hand with: alter database <eclume_antes or eclume_restore_novo> rename to eclume, then docker start ${stopped_ids[*]}" >&2
      stopped_ids=()
    else
      echo "INTERRUPTED: eclume exists; measured state: $(databases_state)" >&2
    fi
  fi
  exit "$1"
}
trap cleanup EXIT
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

# swap_databases: terminates connections and swaps eclume for the temporary one (eclume_antes keeps the old).
swap_databases() {
  local rc=0 tmpdb=eclume_restore_novo before=eclume_antes
  local terminate="select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', '$tmpdb') and pid <> pg_backend_pid()"
  exists eclume || rc=$?
  [[ "$rc" -ne 2 ]] || { echo "FAILURE: could not read pg_database" >&2; return 1; }
  if [[ "$rc" -eq 1 ]]; then
    echo "ALERT: the eclume database does not exist; the restored one is promoted to eclume and $before (if it exists) only goes after eclume is proven" >&2
    "${sql[@]}" -c "$terminate" -c "alter database $tmpdb rename to eclume" >/dev/null || return 1
  else
    drop_with_guarantee "$before" eclume || true
    "${sql[@]}" -c "$terminate" -c "alter database eclume rename to $before" \
      -c "alter database $tmpdb rename to eclume" >/dev/null || return 1
  fi
  exists eclume || { echo "FAILURE: after the swap, eclume is not in pg_database" >&2; return 1; }
  drop_with_guarantee "$before" eclume || true
}
# undo_swap: measures the state, gives the old database its name back if eclume is missing and only then drops the temporary one.
undo_swap() {
  local e=0 a=0
  "${sql[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', 'eclume_antes') and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  exists eclume || e=$?
  exists eclume_antes || a=$?
  if [[ "$e" -eq 1 && "$a" -eq 0 ]]; then
    "${sql[@]}" -c "alter database eclume_antes rename to eclume" >/dev/null 2>&1 || true
    e=0
    exists eclume || e=$?
  fi
  [[ "$e" -ne 0 ]] || drop_with_guarantee eclume_restore_novo eclume || true
  if [[ "$e" -eq 0 ]]; then
    echo "FAILURE: the database swap failed; measured state: $(databases_state)" >&2
  else
    echo "FAILURE: the database swap failed and NO database is called eclume; measured state: $(databases_state). Nothing was deleted; recover by hand with: alter database <eclume_antes or eclume_restore_novo> rename to eclume" >&2
  fi
}
# restore_validating <dump>: the dump proves it restores BEFORE anything destructive.
# 1) pg_restore --list; 2) restores into a temporary database with the services still up; 3) only then
# stops the services (stopped_ids, which the EXIT trap restarts on any failure), swaps the databases and checks pg_database.
restore_validating() {
  local dump="$1" tmpdb=eclume_restore_novo rc=0
  local ids=() s id services=(server worker worker-gpu)
  sql=(docker exec -i "$pg" psql -U eclume -v ON_ERROR_STOP=1 -qAt -d postgres)
  for s in "${services[@]}"; do id="$(container "$s")"; [[ -z "$id" ]] || ids+=("$id"); done
  if ! docker exec -i "$pg" pg_restore --list < "$dump" >/dev/null; then
    echo "FAILURE: the dump $dump is not readable by pg_restore; nothing was changed" >&2
    return 1
  fi
  exists "$tmpdb" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    echo "FAILURE: could not read pg_database; nothing was changed" >&2
    return 1
  elif [[ "$rc" -eq 0 ]] && ! drop_with_guarantee "$tmpdb" eclume eclume_antes; then
    echo "FAILURE: $tmpdb was left over from a previous attempt and there is no other copy; nothing was changed" >&2
    return 1
  fi
  "${sql[@]}" -c "create database $tmpdb" >/dev/null
  if ! docker exec -i "$pg" pg_restore -U eclume -d "$tmpdb" --exit-on-error < "$dump"; then
    "${sql[@]}" -c "drop database if exists $tmpdb" >/dev/null || true
    echo "FAILURE: the dump does not restore into a temporary database; production and services intact" >&2
    return 1
  fi
  echo "dump validated; stopping ${services[*]}"
  stopped_ids=("${ids[@]}")
  if [[ "${#ids[@]}" -gt 0 ]] && ! docker stop "${ids[@]}" >/dev/null; then
    echo "FAILURE: docker stop failed; no database was swapped" >&2
    drop_with_guarantee "$tmpdb" eclume || true
    return 1
  fi
  if ! swap_databases; then
    undo_swap
    return 1
  fi
}

# --database: only the database, from the dump the deploy writes before applying migrations (holetz/eclume#92).
# The bucket does not change: the dump is from minutes before, and the deletion queue and the reconciliation fix the rest.
if [[ "$mode" == --database ]]; then
  [[ -s "$dump" ]] || { echo "missing $dump" >&2; exit 1; }
  pg="$(container postgres)"
  [[ -n "$pg" ]] || { echo "the postgres of the eclume project is not running" >&2; exit 1; }
  restore_validating "$dump"
  restart
  echo "OK: database restored from $dump; start the images of the matching deploy (deploy.sh --rollback)"
  exit 0
fi
pg="$(container postgres)"
minio="$(container minio)"
[[ -n "$pg" && -n "$minio" ]] || { echo "postgres or minio of the eclume project is not running" >&2; exit 1; }
snap="$(resolve "$snap")"
[[ -n "$snap" ]] || { echo "no snapshot on that date" >&2; exit 1; }
# The snapshot stays in clear in a temporary folder only during the restore.
work="$(mktemp -d "$DEST/.restore.XXXXXX")"
echo "restoring the snapshot $snap from the $repository repository"
extract "$snap" "$work" /eclume/pg /eclume/minio
dump="$work/eclume/pg/eclume.dump"
roles="$work/eclume/pg/roles.sql"
snapshot="$work/eclume/minio"
mkdir -p "$snapshot"
for f in "$dump" "$roles"; do [[ -s "$f" ]] || { echo "missing ${f#"$work"/} in the snapshot" >&2; exit 1; }; done
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$ENV_FILE" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$ENV_FILE" | tail -n 1)"
# The project's internal `dados` network (MinIO is also on `fila-gpu`).
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$minio" | grep '_dados$')"
image="$(docker inspect -f '{{.Config.Image}}' "$minio")"
mc() {
  docker run --rm -i --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e "MC_HOST_dst=http://$user:$pass@minio:9000" -v "$snapshot:/snap:ro" --entrypoint mc "$image" "$@"
}
psql_() { docker exec -i "$pg" psql -U eclume -v ON_ERROR_STOP=1 -qAt "$@"; }
# Only tables that exist before and after migration 008 (the per-user account removed `organizations`).
count_sql="select string_agg(t || '=' || n, ' ' order by t) from (
  select 'users' t, count(*) n from users union all
  select 'recordings', count(*) from recordings union all
  select 'transcripts', count(*) from transcripts union all
  select 'summaries', count(*) from summaries) c"

# The roles (eclume_app, eclume_server) belong to the cluster, not the database; on a new cluster they come before the dump.
# "already exists" is expected on a cluster that already has them.
docker exec -i "$pg" psql -U eclume -q -d postgres < "$roles" >/dev/null 2>&1 || true

if [[ "$mode" == --test ]]; then
  db=eclume_restore_test
  bucket=eclume-restore-test
  trap 'psql_ -d postgres -c "drop database if exists $db" >/dev/null; mc rb --force "dst/$bucket" >/dev/null 2>&1 || true; cleanup' EXIT
  psql_ -d postgres -c "drop database if exists $db" -c "create database $db"
  docker exec -i "$pg" pg_restore -U eclume -d "$db" --exit-on-error < "$dump"
  restored="$(psql_ -d "$db" -c "$count_sql")"
  current="$(psql_ -d eclume -c "$count_sql")"
  echo "restored database:   $restored"
  echo "production database: $current"
  mc mb --ignore-existing "dst/$bucket" >/dev/null
  mc mirror --quiet /snap "dst/$bucket" >/dev/null
  n_restored="$(mc ls --recursive "dst/$bucket" | wc -l)"
  n_snapshot="$(find "$snapshot" -type f | wc -l)"
  n_current="$(mc ls --recursive dst/eclume | wc -l)"
  echo "restored bucket: $n_restored objects (snapshot: $n_snapshot; production: $n_current)"
  [[ "$n_restored" == "$n_snapshot" ]] || { echo "FAILURE: the restored bucket does not match the snapshot" >&2; exit 1; }
  # Production may have grown after the backup; equal counts are only required of what was saved.
  if [[ "$restored" == "$current" && "$n_restored" == "$n_current" ]]; then
    echo "OK: restore identical to production"
  else
    echo "OK: restore intact (production changed since the backup)"
  fi
  exit 0
fi

# --apply
restore_validating "$dump"
echo "database: $(psql_ -d eclume -c "$count_sql")"
mc mb --ignore-existing dst/eclume >/dev/null
mc mirror --overwrite --quiet /snap dst/eclume >/dev/null ||
  { echo "FAILURE: mirroring the bucket failed after the swap; the database was already restored" >&2; exit 1; }
echo "bucket: $(mc ls --recursive dst/eclume | wc -l) objects"
restart
echo "OK: production restored from snapshot $snap"
