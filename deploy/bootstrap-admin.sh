#!/usr/bin/env bash
# Cria a primeira organização e o seu admin no stack de produção, uma vez só.
#
#   bash deploy/bootstrap-admin.sh [--context gpu-host] [--org EK] [--email E] [--name NOME]
#
# A senha é gerada NO HOST, em <ECLUME_DATA_DIR>/secrets/admin-password (600), e passa ao
# `eclume-server admin bootstrap --password-stdin` por um pipe: nunca é gravada na estação.
# Com alguma organização já no banco, não faz nada. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
ORG=EK
EMAIL=admin@example.com
NAME="Consultoria EK"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="${2:?}"; shift 2 ;;
    --org) ORG="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --name) NAME="${2:?}"; shift 2 ;;
    --help|-h) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done

export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
host() { ssh -o BatchMode=yes "$SSH" "$@"; }
ENV_FILE=deploy/.env.prod
[[ -f "$ENV_FILE" ]] || { echo "Falta $ENV_FILE (rode deploy/deploy.sh antes)." >&2; exit 2; }
DATA_DIR="$(sed -n 's/^ECLUME_DATA_DIR=//p' "$ENV_FILE" | tail -n 1)"
COMPOSE=(docker compose -p eclume -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE")

orgs="$("${COMPOSE[@]}" exec -T postgres psql -U eclume -d eclume -qAtc 'select count(*) from organizations')"
if [[ "$orgs" != 0 ]]; then
  echo "O banco já tem $orgs organização(ões): bootstrap dispensado." >&2
  exit 0
fi

password_file="$DATA_DIR/secrets/admin-password"
host "umask 077; [ -s '$password_file' ] || openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > '$password_file'"
host "cat '$password_file'" \
  | "${COMPOSE[@]}" run --rm -T --no-deps server \
      eclume-server admin bootstrap --org "$ORG" --email "$EMAIL" --name "$NAME" --password-stdin
echo "Admin $EMAIL criado; a senha está em $SSH:$password_file (600)." >&2
