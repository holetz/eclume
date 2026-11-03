#!/usr/bin/env bash
# Proof of the user web in a real browser (holetz/eclume#38): Organize, My settings and Help center,
# through web/e2e-prod/prova.spec.ts. It writes data, so it runs on staging (holetz/eclume#91), never
# on production: start it on the host with `staging.sh up`. Runs on the workstation, with Chrome (or
# E2E_CHANNEL=msedge), through an `ssh -L 18444:127.0.0.1:18444` tunnel; the account is the disposable
# one in ~/eclume-staging/conta on the host. Prints OK at the end; the screenshots stay in
# web/test-results/prod/. Runbook: docs/project/deploy-producao.md, "Prova do web".
# Variables: ECLUME_PROD_SSH (user@host of staging), ECLUME_PROOF_URL (default the tunnel);
# ECLUME_PROVA_URL is the deprecated pt-BR name, still read.
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="${ECLUME_PROD_SSH:?set ECLUME_PROD_SSH=user@host of staging}"
export ECLUME_PROOF_URL="${ECLUME_PROOF_URL:-${ECLUME_PROVA_URL:-https://127.0.0.1:18444}}"
if [ -z "${ECLUME_PROD_PASSWORD:-}" ]; then
  account="$(ssh "$SSH_HOST" cat eclume-staging/conta)"
  ECLUME_PROD_EMAIL="$(sed -n 's/^ECLUME_EMAIL=//p' <<< "$account")"
  ECLUME_PROD_PASSWORD="$(sed -n 's/^ECLUME_PASSWORD=//p' <<< "$account")"
fi
export ECLUME_PROD_EMAIL ECLUME_PROD_PASSWORD

if [ "$ECLUME_PROOF_URL" = https://127.0.0.1:18444 ]; then
  ssh -N -o ExitOnForwardFailure=yes -L 18444:127.0.0.1:18444 "$SSH_HOST" &
  tunnel=$!
  trap 'kill "$tunnel" 2>/dev/null || true' EXIT
  sleep 2
fi

npm --prefix web run test:e2e:prod -- prova.spec.ts
echo OK
