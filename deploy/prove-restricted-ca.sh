#!/usr/bin/env bash
# Proof of the eclume root's name constraint on the workstation clients (holetz/eclume#101, 1.2).
# Generates a disposable 127.0.0.1 root (`eclume-server ca gerar --prova`), starts two
# `openssl s_server`: 127.0.0.1:18445 with a leaf inside the constraint and 127.0.0.2:18446 with a leaf
# outside it, and checks `curl`. With the servers up, install the disposable root in the user store
# and open both addresses in Chrome, Edge and Firefox: the first opens, the second is refused. Enter
# stops the servers; then remove the disposable root (command printed at the end). Write the result
# under the spec's `## Discoveries`. Runbook: docs/project/deploy-producao.md, "CA raiz".
# Variable: ECLUME_PROOF_CA (folder of the disposable root; default a temporary one). ECLUME_PROVA_CA
# is the deprecated pt-BR name, still read.
set -euo pipefail
cd "$(dirname "$0")/.."

FOLDER="${ECLUME_PROOF_CA:-${ECLUME_PROVA_CA:-$(mktemp -d)}}"
INSIDE=127.0.0.1:18445
OUTSIDE=127.0.0.2:18446

uv run eclume-server ca gerar --prova "$FOLDER"

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
# `dentro` and `fora` are the leaf file names the server CLI writes.
for pair in "dentro $INSIDE" "fora $OUTSIDE"; do
  read -r name address <<< "$pair"
  openssl s_server -quiet -www -accept "$address" -cert "$FOLDER/$name.crt" -key "$FOLDER/$name.key" &
  pids+=("$!")
done
sleep 2

# `--ssl-no-revoke`: Windows curl (Schannel) tries revocation, which the disposable root does not publish.
revocation=()
curl --help all 2>/dev/null | grep -q -- --ssl-no-revoke && revocation=(--ssl-no-revoke)
failed=0
if curl -fsS -o /dev/null "${revocation[@]}" --cacert "$FOLDER/raiz.crt" "https://$INSIDE/"; then
  echo "curl: $INSIDE accepted (expected)"
else
  echo "curl: $INSIDE REFUSED — the root should hold inside the constraint" >&2
  failed=1
fi
if curl -fsS -o /dev/null "${revocation[@]}" --cacert "$FOLDER/raiz.crt" "https://$OUTSIDE/" 2>/dev/null; then
  echo "curl: $OUTSIDE ACCEPTED — the name constraint was not applied" >&2
  failed=1
else
  echo "curl: $OUTSIDE refused (expected)"
fi

cat <<MSG

Disposable root: $FOLDER/raiz.crt
  Windows (Chrome, Edge): certutil -user -addstore Root "$(cygpath -w "$FOLDER/raiz.crt" 2>/dev/null || echo "$FOLDER/raiz.crt")"
  Firefox: Settings > Privacy > Certificates > Authorities > Import (trust for websites).
Open https://$INSIDE/ (must open) and https://$OUTSIDE/ (must be refused) in each browser.
Then: certutil -user -delstore Root "eclume CA raiz" and remove the root from Firefox.
MSG
read -r -p "Enter stops the servers. " _
exit "$failed"
