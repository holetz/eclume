#!/usr/bin/env bash
# Web E2E against the real backend, on an ephemeral stack (deploy/docker-compose.e2e.yml, project
# eclume-e2e). Runs ON THE GPU HOST, where the Docker daemon, Google Chrome and the Claude login are:
#
#   remote-run . 'bash deploy/e2e-real.sh'        # from the dev workstation
#   bash deploy/e2e-real.sh [--keep-images]        # on the host itself
#
# Builds server and edge (with the SPA) from the checkout (`:e2e`), generates the disposable root
# restricted to 127.0.0.1 with the image's `eclume-server ca gerar`, starts the stack, migrates (the
# migrator enables the eclume_server role), checks HTTPS through that root, creates a disposable admin
# account through the CLI (the user is born through signup, in the test itself), converts the speech
# fixture to WAV and runs `npm run test:e2e:real`. It always leaves with `down -v` (data, root and the
# downloaded model are gone) and deletes the `:e2e` images, unless --keep-images. Nothing touches the
# production `eclume` project.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP_IMAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-images) KEEP_IMAGES=1; shift ;;
    --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Claude's long-lived token comes from the production env kept on the host (holetz/eclume#28) or,
# without it, from the `claude-cli` provider registered in the production panel (holetz/eclume#29),
# opened by the production server itself: the ciphertext and the encryption key never leave the container.
if [[ -z "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" && -r /srv/eclume/secrets/env.prod ]]; then
  ECLUME_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ECLUME_CLAUDE_OAUTH_TOKEN=//p' /srv/eclume/secrets/env.prod | tail -1)"
fi
if [[ -z "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" ]] && docker inspect eclume-server-1 >/dev/null 2>&1; then
  ECLUME_CLAUDE_OAUTH_TOKEN="$(docker exec -i eclume-server-1 python - <<'PY' 2>/dev/null || true
import asyncio

from sqlalchemy import text

from eclume_server.config import get_settings
from eclume_server.crypto import decrypt
from eclume_server.db.session import make_engine

QUERY = (
    "SELECT api_key_encrypted FROM agent_providers WHERE kind = 'claude-cli' AND enabled"
    " AND api_key_encrypted IS NOT NULL ORDER BY created_at LIMIT 1"
)


async def main() -> None:
    settings = get_settings()
    engine = make_engine(settings.database_url)
    try:
        async with engine.connect() as conn:
            value = (await conn.execute(text(QUERY))).scalar()
    finally:
        await engine.dispose()
    print(decrypt(settings, value) if value else "")


asyncio.run(main())
PY
)"
fi
export ECLUME_CLAUDE_OAUTH_TOKEN
[[ -n "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" ]] || { echo "No ECLUME_CLAUDE_OAUTH_TOKEN (claude setup-token): the summary would fail." >&2; exit 2; }
COMPOSE=(docker compose -p eclume-e2e -f deploy/docker-compose.e2e.yml)
# Outside web/test-results: Playwright cleans that folder when it starts.
WORK="$(mktemp -d)"
# Caddy's disposable root (CA `eclume`, like the switched production); gone with $WORK.
export ECLUME_E2E_CA_DIR="$WORK/ca"

cleanup() {
  "${COMPOSE[@]}" --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [[ "$KEEP_IMAGES" -eq 0 ]]; then
    docker image rm eclume-server:e2e eclume-edge:e2e eclume-web:e2e >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
(( pct < 90 )) || { echo "Disk at ${pct}%: above 90%, E2E refused." >&2; exit 3; }

echo "Building server and edge (:e2e)…" >&2
BUILDKIT_PROGRESS=plain "${COMPOSE[@]}" build server caddy
mkdir -m 700 "$ECLUME_E2E_CA_DIR"
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$ECLUME_E2E_CA_DIR:/ca" eclume-server:e2e \
  eclume-server ca gerar --pasta /ca --host 127.0.0.1 --nomes '' >&2
echo "Starting the eclume-e2e stack…" >&2
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres redis minio
"${COMPOSE[@]}" run --rm minio-init
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 server worker-cpu worker caddy
# Caddy issues through the constrained root: HTTPS validates with it and only with it.
curl -fsS -o /dev/null --cacert "$ECLUME_E2E_CA_DIR/raiz.crt" https://127.0.0.1:18443/api/v1/health \
  || { echo "The e2e Caddy does not serve a chain of the constrained root." >&2; exit 1; }

ADMIN_EMAIL="admin-e2e@eclume.invalid"
ADMIN_PASSWORD="$(openssl rand -hex 16)"
printf '%s\n' "$ADMIN_PASSWORD" | "${COMPOSE[@]}" run --rm -T migrate \
  eclume-server admin create --email "$ADMIN_EMAIL" --name "Admin E2E" --password-stdin >/dev/null

# Real speech (two synthetic voices in pt): WAV to exercise the conversion in the browser.
ffmpeg -loglevel error -y -i worker-gpu/tests/fixtures/two-voices.ogg -ar 48000 -ac 1 "$WORK/two-voices.wav"

[[ -d web/node_modules ]] || npm --prefix web ci --no-audit --no-fund
ECLUME_E2E_URL=https://127.0.0.1:18443 ECLUME_E2E_ADMIN_EMAIL="$ADMIN_EMAIL" ECLUME_E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ECLUME_E2E_AUDIO="$WORK/two-voices.wav" E2E_CHANNEL="${E2E_CHANNEL:-chrome}" \
  npm --prefix web run test:e2e:real || {
    status=$?
    echo "E2E failed; logs of the worker and the CPU worker:" >&2
    "${COMPOSE[@]}" logs --tail 60 worker worker-cpu >&2 || true
    exit "$status"
  }
