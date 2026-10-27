#!/usr/bin/env bash
# Mock server smoke test: runs against an already running Prism (deploy/docker-compose.mock.yml)
# and checks that it answers with the v1 contract fixtures.
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

fail() { echo "FAILED: $*" >&2; exit 1; }

# Wait for the mock to come up (up to 60 s).
up=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/api/v1/health" -o /dev/null 2>/dev/null; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || fail "mock did not answer at $BASE"

status() { curl -sS -o "$OUT" -w '%{http_code}' "$@"; }

code=$(status "$BASE/api/v1/health")
[ "$code" = 200 ] || fail "health → $code"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts/$TRANSCRIPT")
[ "$code" = 200 ] || fail "GET transcript with PAT → $code"
python3 - "$OUT" <<'PY' || fail "transcript without 3 speakers"
import json, sys
t = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(t["speakers"]) == 3, t["speakers"]
assert t["speakers"][0]["person"]["name"] == "Mariana Couto"
PY

code=$(status "$BASE/api/v1/transcripts/$TRANSCRIPT")
[ "$code" = 401 ] || fail "GET transcript without credential → $code (expected 401)"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts?since=2026-09-01T00:00:00Z")
[ "$code" = 200 ] || fail "GET transcripts?since → $code"

code=$(status -H "$PAT" "$BASE/api/v1/transcripts/$TRANSCRIPT/export?format=md")
[ "$code" = 200 ] || fail "export md → $code"
grep -q '^\*\*Mariana Couto\*\* \[00:00:03\]: ' "$OUT" || fail "export md without Mariana's line"

code=$(status -X POST -H "$PAT" -H 'Content-Type: application/json' -H 'Prefer: code=201' \
  --data-binary "@$FIXTURES/upload-create-request.json" "$BASE/api/v1/uploads")
[ "$code" = 201 ] || fail "POST uploads → $code"

code=$(status -X PUT -H "$PAT" -H 'Content-Type: application/octet-stream' --data-binary 'parte' \
  "$BASE/api/v1/uploads/01928f3a-1c00-7a00-8000-000000000601/parts/1")
[ "$code" = 200 ] || fail "PUT part → $code"

code=$(status "$BASE/api/v1/auth/signup")
[ "$code" = 200 ] || fail "GET auth/signup → $code"
python3 - "$OUT" <<'PY' || fail "signup without the notice"
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
assert s["open"] is True and s["notice"]["version"], s
PY

code=$(status -H "$PAT" "$BASE/api/v1/admin/me")
[ "$code" = 401 ] || fail "GET admin/me with PAT → $code (expected 401)"

code=$(status -H 'Cookie: eclume_admin_session=mock' "$BASE/api/v1/admin/me")
[ "$code" = 200 ] || fail "GET admin/me with the admin session → $code"

echo "mock ok: $BASE"
