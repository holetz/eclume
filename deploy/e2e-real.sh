#!/usr/bin/env bash
# E2E do web contra o backend real, num stack efêmero (deploy/docker-compose.e2e.yml, projeto
# eclume-e2e). Roda NO HOST GPU, onde estão o daemon Docker, o Google Chrome e o login do Claude:
#
#   remote-run . 'bash deploy/e2e-real.sh'        # da estação de dev
#   bash deploy/e2e-real.sh [--manter-imagens]     # no próprio host
#
# Constrói server e web do checkout (`:e2e`), sobe o stack, migra (o migrador liga o papel
# eclume_server), cria uma organização e um admin descartáveis, converte a fixture de fala em WAV e
# roda `npm run test:e2e:real`. Sai sempre com `down -v` (dados e o modelo baixado somem) e apaga
# as imagens `:e2e`, a não ser com --manter-imagens. Nada toca o projeto `eclume` de produção.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP_IMAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manter-imagens) KEEP_IMAGES=1; shift ;;
    --help|-h) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done

# O token de longa duração do Claude vem do env de produção guardado no host (holetz/eclume#28).
if [[ -z "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" && -r /srv/eclume/secrets/env.prod ]]; then
  ECLUME_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ECLUME_CLAUDE_OAUTH_TOKEN=//p' /srv/eclume/secrets/env.prod | tail -1)"
fi
export ECLUME_CLAUDE_OAUTH_TOKEN
[[ -n "${ECLUME_CLAUDE_OAUTH_TOKEN:-}" ]] || { echo "Sem ECLUME_CLAUDE_OAUTH_TOKEN (claude setup-token): o resumo falharia." >&2; exit 2; }
COMPOSE=(docker compose -p eclume-e2e -f deploy/docker-compose.e2e.yml)
# Fora de web/test-results: o Playwright limpa aquela pasta ao começar.
WORK="$(mktemp -d)"

cleanup() {
  "${COMPOSE[@]}" --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [[ "$KEEP_IMAGES" -eq 0 ]]; then
    docker image rm eclume-server:e2e eclume-web:e2e >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
(( pct < 90 )) || { echo "Disco em ${pct}%: acima de 90%, E2E recusado." >&2; exit 3; }

echo "Construindo server e web (:e2e)…" >&2
BUILDKIT_PROGRESS=plain "${COMPOSE[@]}" build server web
echo "Subindo o stack eclume-e2e…" >&2
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres redis minio
"${COMPOSE[@]}" run --rm minio-init
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 server worker-cpu worker web caddy

EMAIL="e2e@eclume.invalid"
PASSWORD="$(openssl rand -hex 16)"
printf '%s\n' "$PASSWORD" | "${COMPOSE[@]}" run --rm -T migrate \
  eclume-server admin bootstrap --org "E2E" --email "$EMAIL" --name "E2E" --password-stdin >/dev/null

# Fala real (duas vozes sintéticas em pt): WAV para exercitar a conversão no navegador.
ffmpeg -loglevel error -y -i worker-gpu/tests/fixtures/duas-vozes.ogg -ar 48000 -ac 1 "$WORK/duas-vozes.wav"

[[ -d web/node_modules ]] || npm --prefix web ci --no-audit --no-fund
ECLUME_E2E_URL=https://127.0.0.1:18443 ECLUME_E2E_EMAIL="$EMAIL" ECLUME_E2E_PASSWORD="$PASSWORD" \
  ECLUME_E2E_AUDIO="$WORK/duas-vozes.wav" E2E_CHANNEL="${E2E_CHANNEL:-chrome}" \
  npm --prefix web run test:e2e:real || {
    status=$?
    echo "E2E falhou; logs do worker e do worker CPU:" >&2
    "${COMPOSE[@]}" logs --tail 60 worker worker-cpu >&2 || true
    exit "$status"
  }
