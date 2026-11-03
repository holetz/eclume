#!/usr/bin/env bash
# Creates the panel's first admin account on the production stack, only once.
#
#   bash deploy/bootstrap-admin.sh --context NAME --email E [--name NAME]
#
# The context (or $ECLUME_DOCKER_CONTEXT) and the e-mail (or $ECLUME_ADMIN_EMAIL) have no default.
#
# The password is generated ON THE HOST, in <ECLUME_DATA_DIR>/secrets/admin-password (600), and goes
# to `eclume-server admin create --password-stdin` through a pipe: it is never written on the workstation.
# With an admin account already in the database (migration 008 creates the old admins' ones), it does
# nothing. User accounts are born through signup. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
EMAIL="${ECLUME_ADMIN_EMAIL:-}"
NAME="Administrator"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --name) NAME="${2:?}"; shift 2 ;;
    --help|-h) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ -n "$CONTEXT" ]] || { echo "Missing the host Docker context: --context NAME or ECLUME_DOCKER_CONTEXT." >&2; exit 2; }
[[ -n "$EMAIL" ]] || { echo "Missing the admin e-mail: --email E or ECLUME_ADMIN_EMAIL." >&2; exit 2; }

export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
host() { ssh -o BatchMode=yes "$SSH" "$@"; }
ENV_FILE=deploy/.env.prod
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE (run deploy/deploy.sh first)." >&2; exit 2; }
DATA_DIR="$(sed -n 's/^ECLUME_DATA_DIR=//p' "$ENV_FILE" | tail -n 1)"
COMPOSE=(docker compose -p eclume -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE")

admins="$("${COMPOSE[@]}" exec -T postgres psql -U eclume -d eclume -qAtc 'select count(*) from admins')"
if [[ "$admins" != 0 ]]; then
  echo "The database already has $admins admin account(s): bootstrap skipped." >&2
  exit 0
fi

password_file="$DATA_DIR/secrets/admin-password"
host "umask 077; [ -s '$password_file' ] || openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > '$password_file'"
host "cat '$password_file'" \
  | "${COMPOSE[@]}" run --rm -T --no-deps migrate \
      eclume-server admin create --email "$EMAIL" --name "$NAME" --password-stdin
echo "Admin $EMAIL created; the password is in $SSH:$password_file (600)." >&2
