#!/usr/bin/env bash
# Smoke do mock server: sobe contra um Prism já em execução (deploy/docker-compose.mock.yml) e
# confere que ele responde com as fixtures do contrato v1.
#
#   docker compose -f deploy/docker-compose.mock.yml up -d
#   bash contracts/tests/smoke-mock.sh            # ECLUME_MOCK_URL=http://127.0.0.1:4010
set -euo pipefail

BASE="${ECLUME_MOCK_URL:-http://127.0.0.1:4010}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/../fixtures"
PAT="Authorization: Bearer eclp_mockmockmockmockmockmockmockmock"
TRANSCRIPT="01928f3a-1c00-7a00-8000-000000000501"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

fail() { echo "FALHOU: $*" >&2; exit 1; }

# Espera o mock subir (até 60 s).
up=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/v1/health" -o /dev/null 2>/dev/null; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || fail "mock não respondeu em $BASE"

status() { curl -sS -o "$OUT" -w '%{http_code}' "$@"; }

code=$(status "$BASE/api/v1/health")
[ "$code" = 200 ] || fail "health → $code"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts/$TRANSCRIPT")
[ "$code" = 200 ] || fail "GET transcript com PAT → $code"
python3 - "$OUT" <<'PY' || fail "transcrição sem 3 locutores"
import json, sys
t = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(t["speakers"]) == 3, t["speakers"]
assert t["speakers"][0]["person"]["name"] == "Mariana Couto"
PY

code=$(status "$BASE/api/v1/transcripts/$TRANSCRIPT")
[ "$code" = 401 ] || fail "GET transcript sem credencial → $code (esperado 401)"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts?since=2026-09-01T00:00:00Z")
[ "$code" = 200 ] || fail "GET transcripts?since → $code"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts/$TRANSCRIPT/export?format=md")
[ "$code" = 200 ] || fail "export md → $code"
grep -q '^\*\*Mariana Couto\*\* \[00:00:03\]: ' "$OUT" || fail "export md sem a linha da Mariana"

code=$(status -X POST -H "$PAT" -H 'Content-Type: application/json' -H 'Prefer: code=201' \
  --data-binary "@$FIXTURES/upload-create-request.json" "$BASE/api/v1/uploads")
[ "$code" = 201 ] || fail "POST uploads → $code"

code=$(status -X PUT -H "$PAT" -H 'Content-Type: application/octet-stream' --data-binary 'parte' \
  "$BASE/api/v1/uploads/01928f3a-1c00-7a00-8000-000000000601/parts/1")
[ "$code" = 200 ] || fail "PUT parte → $code"

code=$(status "$BASE/api/v1/auth/signup")
[ "$code" = 200 ] || fail "GET auth/signup → $code"
python3 - "$OUT" <<'PY' || fail "cadastro sem o aviso"
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
assert s["open"] is True and s["notice"]["version"], s
PY

code=$(status -H "$PAT" "$BASE/api/v1/admin/me")
[ "$code" = 401 ] || fail "GET admin/me com PAT → $code (esperado 401)"

code=$(status -H 'Cookie: eclume_admin_session=mock' "$BASE/api/v1/admin/me")
[ "$code" = 200 ] || fail "GET admin/me com a sessão de admin → $code"

echo "mock ok: $BASE"
