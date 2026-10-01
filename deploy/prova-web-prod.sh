#!/usr/bin/env bash
# Prova do web do usuário num navegador real (holetz/eclume#38): Organizar, Minhas configurações e
# Central de ajuda, pelo web/e2e-prod/prova.spec.ts. Escreve dados, por isso roda no staging
# (holetz/eclume#91), nunca na produção: suba-o no host com `staging.sh subir`. Roda na estação, com o
# Chrome (ou E2E_CHANNEL=msedge), por um túnel `ssh -L 18444:127.0.0.1:18444`; a conta é a
# descartável de ~/eclume-staging/conta no host. Imprime OK no fim; os screenshots ficam em
# web/test-results/prod/. Runbook: docs/project/deploy-producao.md, "Prova do web".
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="${ECLUME_PROD_SSH:?defina ECLUME_PROD_SSH=usuario@host do staging}"
export ECLUME_PROVA_URL="${ECLUME_PROVA_URL:-https://127.0.0.1:18444}"
if [ -z "${ECLUME_PROD_PASSWORD:-}" ]; then
  conta="$(ssh "$SSH_HOST" cat eclume-staging/conta)"
  ECLUME_PROD_EMAIL="$(sed -n 's/^ECLUME_EMAIL=//p' <<< "$conta")"
  ECLUME_PROD_PASSWORD="$(sed -n 's/^ECLUME_PASSWORD=//p' <<< "$conta")"
fi
export ECLUME_PROD_EMAIL ECLUME_PROD_PASSWORD

if [ "$ECLUME_PROVA_URL" = https://127.0.0.1:18444 ]; then
  ssh -N -o ExitOnForwardFailure=yes -L 18444:127.0.0.1:18444 "$SSH_HOST" &
  tunel=$!
  trap 'kill "$tunel" 2>/dev/null || true' EXIT
  sleep 2
fi

npm --prefix web run test:e2e:prod -- prova.spec.ts
echo OK
