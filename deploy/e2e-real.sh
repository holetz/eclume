#!/usr/bin/env bash
# E2E do web contra o backend real, num stack efêmero (deploy/docker-compose.e2e.yml, projeto
# eclume-e2e). Roda NO HOST GPU, onde estão o daemon Docker, o Google Chrome e o login do Claude:
#
#   remote-run . 'bash deploy/e2e-real.sh'        # da estação de dev
#   bash deploy/e2e-real.sh [--manter-imagens]     # no próprio host
#
# Constrói server e borda (com o SPA) do checkout (`:e2e`), gera a raiz descartável restrita a
# 127.0.0.1 com o `eclume-server ca gerar` da imagem, sobe o stack, migra (o migrador liga o papel
# eclume_server),
# confere o HTTPS por essa raiz, cria uma conta de admin descartável pelo CLI (o usuário nasce pelo
# cadastro, no próprio teste), converte a fixture de fala em WAV e roda `npm run test:e2e:real`.
# Sai sempre com `down -v` (dados, raiz e o modelo baixado somem) e apaga as imagens `:e2e`, a não
# ser com --manter-imagens. Nada toca o projeto `eclume` de produção.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP_IMAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manter-imagens) KEEP_IMAGES=1; shift ;;
    --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done

# O token de longa duração do Claude vem do env de produção guardado no host (holetz/eclume#28) ou,
# sem ele, do provider `claude-cli` cadastrado no painel de produção (holetz/eclume#29), aberto pelo
# próprio server de produção: o texto cifrado e a chave de cifra nunca saem do container.
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
[[ -n "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" ]] || { echo "Sem ECLUME_CLAUDE_OAUTH_TOKEN (claude setup-token): o resumo falharia." >&2; exit 2; }
COMPOSE=(docker compose -p eclume-e2e -f deploy/docker-compose.e2e.yml)
# Fora de web/test-results: o Playwright limpa aquela pasta ao começar.
WORK="$(mktemp -d)"
# A raiz descartável do Caddy (CA `eclume`, como a produção virada); some com o $WORK.
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
(( pct < 90 )) || { echo "Disco em ${pct}%: acima de 90%, E2E recusado." >&2; exit 3; }

echo "Construindo server e borda (:e2e)…" >&2
BUILDKIT_PROGRESS=plain "${COMPOSE[@]}" build server caddy
mkdir -m 700 "$ECLUME_E2E_CA_DIR"
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$ECLUME_E2E_CA_DIR:/ca" eclume-server:e2e \
  eclume-server ca gerar --pasta /ca --host 127.0.0.1 --nomes '' >&2
echo "Subindo o stack eclume-e2e…" >&2
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres redis minio
"${COMPOSE[@]}" run --rm minio-init
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 server worker-cpu worker caddy
# O Caddy emite pela raiz restrita: o HTTPS valida com ela e só com ela.
curl -fsS -o /dev/null --cacert "$ECLUME_E2E_CA_DIR/raiz.crt" https://127.0.0.1:18443/api/v1/health \
  || { echo "O Caddy do e2e não serve uma cadeia da raiz restrita." >&2; exit 1; }

ADMIN_EMAIL="admin-e2e@eclume.invalid"
ADMIN_PASSWORD="$(openssl rand -hex 16)"
printf '%s\n' "$ADMIN_PASSWORD" | "${COMPOSE[@]}" run --rm -T migrate \
  eclume-server admin create --email "$ADMIN_EMAIL" --name "Admin E2E" --password-stdin >/dev/null

# Fala real (duas vozes sintéticas em pt): WAV para exercitar a conversão no navegador.
ffmpeg -loglevel error -y -i worker-gpu/tests/fixtures/duas-vozes.ogg -ar 48000 -ac 1 "$WORK/duas-vozes.wav"

[[ -d web/node_modules ]] || npm --prefix web ci --no-audit --no-fund
ECLUME_E2E_URL=https://127.0.0.1:18443 ECLUME_E2E_ADMIN_EMAIL="$ADMIN_EMAIL" ECLUME_E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ECLUME_E2E_AUDIO="$WORK/duas-vozes.wav" E2E_CHANNEL="${E2E_CHANNEL:-chrome}" \
  npm --prefix web run test:e2e:real || {
    status=$?
    echo "E2E falhou; logs do worker e do worker CPU:" >&2
    "${COMPOSE[@]}" logs --tail 60 worker worker-cpu >&2 || true
    exit "$status"
  }
