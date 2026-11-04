#!/usr/bin/env bash
# Authenticode signing of the eclume Windows executables, on Linux, through the `jsign` of the
# eclume-desktop-build-windows image. Tauri calls this script through `bundle.windows.signCommand`
# for each installer executable (before the updater's minisign signature), and the release uses it
# to verify the finished installer. Contract: docs/standards/code/desktop-distribuicao.md
# §Assinatura de código do Windows.
#
# Usage: sign-windows.sh <file>             signs (SHA-256, with an RFC 3161 timestamp) and verifies
#        sign-windows.sh --verify <file>    verifies the signature and the timestamp
#        sign-windows.sh --self-test        signs and verifies an NSIS stub with a self-signed test
#                                           PKCS#12
# Configuration: $ECLUME_SIGNING_DIR (default /run/assinatura, the host folder
# /srv/eclume/secrets/assinatura-windows/ mounted read-only) with `assinatura.env`:
#   JSIGN_STORETYPE   TRUSTEDSIGNING, AZUREKEYVAULT, GOOGLECLOUD, DIGICERTONE, PKCS11, PKCS12…
#   JSIGN_KEYSTORE    the keystore of that type (a file relative to the folder, an endpoint or config)
#   JSIGN_ALIAS       the key or certificate in the keystore (when the type needs one)
#   JSIGN_CERTFILE    the certificate chain, when the keystore does not carry it (optional)
#   JSIGN_TSAURL      the timestamp authority (required)
# and the password or token: the folder's `storepass` file, or JSIGN_STOREPASS_CMD, a command that
# prints a short-lived token. ECLUME_SIGNING_CAFILE replaces the CA file used for verification.
# The host folder and file names (/run/assinatura, assinatura.env) are on-disk names the host
# already has; ECLUME_ASSINATURA_DIR and ECLUME_ASSINATURA_CAFILE still work as fallbacks.
set -euo pipefail

CONF_DIR="${ECLUME_SIGNING_DIR:-${ECLUME_ASSINATURA_DIR:-/run/assinatura}}"
SYSTEM_CAS=/etc/ssl/certs/ca-certificates.crt

fail() { echo "sign-windows: $*" >&2; exit 1; }

# A relative path in the configuration is relative to its folder.
in_conf_dir() {
  local value="$1"
  if [[ -n "$value" && "$value" != /* && -e "$CONF_DIR/$value" ]]; then
    echo "$CONF_DIR/$value"
  else
    echo "$value"
  fi
}

verify() {
  local file="$1" cas="${ECLUME_SIGNING_CAFILE:-${ECLUME_ASSINATURA_CAFILE:-$SYSTEM_CAS}}" output
  [[ -f "$file" ]] || fail "file not found: $file"
  output="$(osslsigncode verify -in "$file" -CAfile "$cas" -TSA-CAfile "$SYSTEM_CAS" 2>&1)" \
    || { echo "$output" >&2; fail "invalid or missing signature in $file"; }
  grep -q "Timestamp Server Signature verification: ok" <<<"$output" \
    || { echo "$output" >&2; fail "signature without a timestamp in $file"; }
  echo "signature ok: $(basename "$file")" >&2
}

sign() {
  local file="$1" password=""
  [[ -f "$file" ]] || fail "file not found: $file"
  [[ -f "$CONF_DIR/assinatura.env" ]] || fail "no configuration at $CONF_DIR/assinatura.env"
  # shellcheck disable=SC1091 # the configuration belongs to the host
  source "$CONF_DIR/assinatura.env"
  [[ -n "${JSIGN_STORETYPE:-}" ]] || fail "JSIGN_STORETYPE missing"
  [[ -n "${JSIGN_TSAURL:-}" ]] || fail "JSIGN_TSAURL missing: the timestamp is required"
  if [[ -n "${JSIGN_STOREPASS_CMD:-}" ]]; then
    password="$(bash -c "$JSIGN_STOREPASS_CMD")" || fail "JSIGN_STOREPASS_CMD failed"
  elif [[ -s "$CONF_DIR/storepass" ]]; then
    password="$(<"$CONF_DIR/storepass")"
  fi
  local args=(--storetype "$JSIGN_STORETYPE" --alg SHA-256 --tsmode RFC3161
              --tsaurl "$JSIGN_TSAURL" --tsretries 3 --tsretrywait 5 --replace)
  [[ -z "${JSIGN_KEYSTORE:-}" ]] || args+=(--keystore "$(in_conf_dir "$JSIGN_KEYSTORE")")
  [[ -z "${JSIGN_ALIAS:-}" ]] || args+=(--alias "$JSIGN_ALIAS")
  [[ -z "${JSIGN_CERTFILE:-}" ]] || args+=(--certfile "$(in_conf_dir "$JSIGN_CERTFILE")")
  # The password goes through a temporary file, off the command line (visible in `ps`).
  local password_file="" status=0
  if [[ -n "$password" ]]; then
    password_file="$(mktemp)"
    printf '%s' "$password" >"$password_file"
    args+=(--storepass "file:$password_file")
  fi
  jsign "${args[@]}" "$file" >&2 || status=$?
  [[ -z "$password_file" ]] || rm -f "$password_file"
  [[ "$status" -eq 0 ]] || fail "jsign did not sign $file"
  verify "$file"
}

self_test() {
  local dir stub
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # the folder is fixed now
  trap "rm -rf '$dir'" EXIT
  stub="$(find /usr/share/nsis/Stubs -maxdepth 1 -type f -name 'zlib-x86-unicode' | head -n 1)"
  [[ -n "$stub" ]] || fail "NSIS stub not found"
  cp "$stub" "$dir/test.exe"
  cp "$stub" "$dir/unsigned.exe"
  openssl req -x509 -newkey rsa:3072 -nodes -days 2 -subj "/CN=eclume self-test" \
    -addext "extendedKeyUsage=codeSigning" -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
  openssl pkcs12 -export -inkey "$dir/key.pem" -in "$dir/cert.pem" -name eclume \
    -passout pass:self-test -out "$dir/test.p12"
  printf 'self-test' >"$dir/storepass"
  cat >"$dir/assinatura.env" <<'ENV'
JSIGN_STORETYPE=PKCS12
JSIGN_KEYSTORE=test.p12
JSIGN_ALIAS=eclume
JSIGN_TSAURL=http://timestamp.digicert.com
ENV
  CONF_DIR="$dir"
  export ECLUME_SIGNING_CAFILE="$dir/cert.pem"
  sign "$dir/test.exe"
  if (verify "$dir/unsigned.exe") 2>/dev/null; then
    fail "verification accepted an unsigned executable"
  fi
  echo "self-test ok: signs with a timestamp, verifies and rejects what has no signature" >&2
}

case "${1:-}" in
  --verify) [[ $# -eq 2 ]] || fail "usage: --verify <file>"; verify "$2" ;;
  --self-test) self_test ;;
  --help|-h|"") sed -n '2,24p' "$0" 2>/dev/null || true; [[ -n "${1:-}" ]] ;;
  -*) fail "unknown option: $1" ;;
  *) sign "$1" ;;
esac
