#!/usr/bin/env bash
# Publishes a mobile app release on the host: downloads the GitHub Release assets (private) into
# /srv/eclume/downloads/movel/<version>/, checks SHA256SUMS and only then swaps
# /downloads/movel.json and /downloads/movel/INSTALACAO.md, by copy and `mv`. eclume's Caddy serves
# /downloads/. The `movel.json` name (and its keys) is a contract with the web /app-movel page and
# with the installed app. Contract: docs/standards/code/mobile-distribuicao.md.
#
# Runs on the host (where `gh` is authenticated):
#   deploy/publish-mobile.sh [mobile-v<version>]       # without a tag: the latest mobile-v* release
# or, from the dev machine:
#   ssh holetz@192.168.15.199 'bash -s -- mobile-v0.1.0' < deploy/publish-mobile.sh
#
# Variables: DEST (default /srv/eclume/downloads), REPO (holetz/eclume), KEEP (versions kept, 3),
# FORCE=1 to point movel.json at a version older than the current one, SWAP_CERTIFICATE="<reason>" to accept a
# signing certificate different from the published one (Android does not install an APK of another
# key over the app: only on a declared swap, like #17's). The deprecated pt-BR names (DESTINO,
# MANTER, FORCAR, TROCAR_CERTIFICADO) still work as a fallback.
set -euo pipefail

DEST="${DEST:-${DESTINO:-/srv/eclume/downloads}}"
REPO="${REPO:-holetz/eclume}"
KEEP="${KEEP:-${MANTER:-3}}"
FORCE="${FORCE:-${FORCAR:-0}}"
SWAP_CERT="${SWAP_CERTIFICATE:-${TROCAR_CERTIFICADO:-}}"
MOBILE="$DEST/movel"

tag="${1:-}"
if [ -z "$tag" ]; then
  tag=$(gh release list -R "$REPO" --limit 50 --json tagName \
    --jq '[.[] | select(.tagName | startswith("mobile-v"))][0].tagName // empty')
  [ -n "$tag" ] || { echo "no mobile-v* release in $REPO" >&2; exit 1; }
fi
case "$tag" in
  mobile-v*) ;;
  *) echo "invalid tag: $tag (expected mobile-v<version>)" >&2; exit 2 ;;
esac
version="${tag#mobile-v}"

mkdir -p "$MOBILE"
tmp=$(mktemp -d "$MOBILE/.downloading-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "downloading $tag from $REPO"
gh release download "$tag" -R "$REPO" -D "$tmp"
(cd "$tmp" && sha256sum -c --quiet SHA256SUMS)
published=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["versao"])' "$tmp/movel.json")
[ "$published" = "$version" ] || { echo "movel.json says $published, the tag says $version" >&2; exit 1; }

# The signing certificate does not change without notice: Android only updates an app with the same key.
certificate() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["certificado_sha256"].replace(":", "").lower())' "$1"
}
if [ -f "$DEST/movel.json" ]; then
  previous=$(certificate "$DEST/movel.json")
  new=$(certificate "$tmp/movel.json")
  if [ "$previous" != "$new" ]; then
    if [ -z "$SWAP_CERT" ]; then
      echo "the certificate of $tag ($new) differs from the published one ($previous): installed apps will not update." >&2
      echo "A key swap only when declared: SWAP_CERTIFICATE=\"<reason>\"." >&2
      exit 1
    fi
    echo "CERTIFICATE SWAP declared ($previous → $new): $SWAP_CERT"
  fi
fi
chmod -R a+rX "$tmp"

# Swaps the version folder (republishing the same version replaces the previous one).
if [ -d "$MOBILE/$version" ]; then
  mv "$MOBILE/$version" "$tmp.old"
fi
mv "$tmp" "$MOBILE/$version"
rm -rf "$tmp.old"
trap - EXIT

# Points movel.json at this version only if it is not older than the current one.
current=""
if [ -f "$DEST/movel.json" ]; then
  current=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["versao"])' "$DEST/movel.json")
fi
newest=$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n1)
if [ -z "$current" ] || [ "$newest" = "$version" ] || [ "$FORCE" = 1 ]; then
  cp "$MOBILE/$version/movel.json" "$DEST/.movel.json.new"
  cp "$MOBILE/$version/INSTALACAO.md" "$MOBILE/.INSTALACAO.md.new"
  chmod a+r "$DEST/.movel.json.new" "$MOBILE/.INSTALACAO.md.new"
  mv -f "$MOBILE/.INSTALACAO.md.new" "$MOBILE/INSTALACAO.md"
  mv -f "$DEST/.movel.json.new" "$DEST/movel.json"
  current="$version"
  echo "movel.json points at $version"
else
  echo "movel.json stays at $current (newer than $version); use FORCE=1 to swap"
fi

# Keeps the $KEEP most recent versions, and never the one movel.json points at.
mapfile -t versions < <(find "$MOBILE" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]+\.[0-9]+\.[0-9]+[^/]*' -printf '%f\n' | sort -V)
excess=$(( ${#versions[@]} - KEEP ))
for ((i = 0; i < excess; i++)); do
  v="${versions[$i]}"
  [ "$v" = "$current" ] && continue
  echo "removing the old version $v"
  rm -rf "${MOBILE:?}/$v"
done

echo "published: $MOBILE/$version"
ls -la "$MOBILE"
