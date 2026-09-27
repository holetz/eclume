#!/usr/bin/env bash
# Prova do web do usuário em produção num navegador real (holetz/eclume#38): Organizar, Minhas
# configurações e Central de ajuda, pelo web/e2e-prod/prova.spec.ts. Roda na estação, com o Chrome
# (ou E2E_CHANNEL=msedge). A conta é a do smoke (deploy/smoke_prod.py): o e-mail padrão e a senha
# lida no host, em /srv/eclume/secrets/admin-password. Imprime OK no fim; os screenshots ficam em
# web/test-results/prod/. Runbook: docs/project/deploy-producao.md, "Prova do web".
set -euo pipefail
cd "$(dirname "$0")/.."

export ECLUME_PROD_URL="${ECLUME_PROD_URL:-https://192.168.15.199:8443}"
export ECLUME_PROD_EMAIL="${ECLUME_PROD_EMAIL:-admin@example.com}"
if [ -z "${ECLUME_PROD_PASSWORD:-}" ]; then
  ECLUME_PROD_PASSWORD="$(ssh "${ECLUME_PROD_SSH:-holetz@192.168.15.199}" cat /srv/eclume/secrets/admin-password)"
fi
export ECLUME_PROD_PASSWORD

npm --prefix web run test:e2e:prod -- prova.spec.ts
echo OK
