#!/usr/bin/env bash
# Creates, once, the mobile app's release keystore on the host: RSA 4096, valid for 30 years, alias
# `eclume`, at /srv/eclume/secrets/eclume-android.jks, with the random password in
# /srv/eclume/secrets/android-keystore-password (both 0600; backup.sh takes them in the encrypted
# restic snapshot of secrets/, local and off the host, and a GitHub secret is no recoverable copy).
# Losing the keystore blocks updating the apps already installed: Android only installs over an APK
# signed by the same key. Contract: docs/standards/code/mobile-distribuicao.md.
#
# The keystore never leaves the host: deploy/release-mobile.sh mounts it read-only in the build
# container. The `-dname` (the holder, decided with the app's identity in holetz/eclume#17) is
# required.
#
# Usage (from the dev machine):
#   ssh holetz@192.168.15.199 'bash -s -- --dname "CN=eclume, O=<holder>, C=BR"' < mobile/scripts/create-keystore.sh
# Then: version the printed SHA-256 in mobile/certificado-release.sha256 and confirm the encrypted
# copy of the keystore and the password off the host (holetz/eclume#91).
set -euo pipefail

DNAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dname)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--dname requires the holder (CN=…, O=…, C=…)." >&2; exit 2; }
      DNAME="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DNAME" ]] || { echo "Give the holder: --dname \"CN=eclume, O=<holder>, C=BR\" (holetz/eclume#17)." >&2; exit 2; }

SECRETS="${SECRETS:-/srv/eclume/secrets}"
KEYSTORE="$SECRETS/eclume-android.jks"
PASSWORD_FILE="$SECRETS/android-keystore-password"
ALIAS="${ALIAS:-eclume}"
KEYTOOL="${KEYTOOL:-$(command -v keytool || echo "$HOME/jdk-21/bin/keytool")}"

if [[ -e "$KEYSTORE" ]]; then
  echo "the keystore already exists at $KEYSTORE; not recreating it (losing the key blocks updating the app)." >&2
  exit 1
fi
[[ -x "$KEYTOOL" ]] || { echo "keytool not found; run mobile/scripts/android-sdk.sh" >&2; exit 1; }

umask 077
mkdir -p "$SECRETS"
password=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
printf '%s' "$password" >"$PASSWORD_FILE"
"$KEYTOOL" -genkeypair -v -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass "$password" -keypass "$password" \
  -dname "$DNAME" >/dev/null
chmod 600 "$KEYSTORE" "$PASSWORD_FILE"

echo "keystore created at $KEYSTORE (alias $ALIAS, holder $DNAME); password in $PASSWORD_FILE."
sha=$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -storepass "$password" -alias "$ALIAS" \
  | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | tr -d ':' | tr 'A-F' 'a-f')
cat <<INSTRUCTIONS

SHA-256 of the certificate (public: it goes out in movel.json):
  $sha

1. Version it, from the dev machine:  echo $sha > mobile/certificado-release.sha256
2. Confirm the encrypted copy of the keystore and the password off the host (holetz/eclume#91):
   losing the key blocks updating the installed apps.
INSTRUCTIONS
