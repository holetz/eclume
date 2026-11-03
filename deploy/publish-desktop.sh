#!/usr/bin/env bash
# Publishes a desktop app release on the host: downloads the GitHub Release assets (private) into
# /srv/eclume/downloads/<version>/, checks SHA256SUMS and only then swaps latest.json,
# instaladores.json and INSTALACAO.md at the root, which eclume's Caddy serves at /downloads/.
# Contract: docs/standards/code/desktop-distribuicao.md.
#
# Runs on the host (where `gh` is authenticated):
#   deploy/publish-desktop.sh [desktop-v<version>]       # without a tag: the latest desktop-v* release
# or, from the dev machine:
#   ssh holetz@192.168.15.199 'bash -s -- desktop-v0.1.0' < deploy/publish-desktop.sh
#
# Variables (names kept from before the English rename): DESTINO (destination, default
# /srv/eclume/downloads), REPO (holetz/eclume), MANTER (versions kept, 3), FORCAR=1 to point
# latest.json at a version older than the current one.
set -euo pipefail

DEST="${DESTINO:-/srv/eclume/downloads}"
REPO="${REPO:-holetz/eclume}"
KEEP="${MANTER:-3}"
FORCE="${FORCAR:-0}"

tag="${1:-}"
if [ -z "$tag" ]; then
  tag=$(gh release list -R "$REPO" --limit 50 --json tagName \
    --jq '[.[] | select(.tagName | startswith("desktop-v"))][0].tagName // empty')
  [ -n "$tag" ] || { echo "no desktop-v* release in $REPO" >&2; exit 1; }
fi
case "$tag" in
  desktop-v*) ;;
  *) echo "invalid tag: $tag (expected desktop-v<version>)" >&2; exit 2 ;;
esac
version="${tag#desktop-v}"

mkdir -p "$DEST"
tmp=$(mktemp -d "$DEST/.downloading-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "downloading $tag from $REPO"
gh release download "$tag" -R "$REPO" -D "$tmp"
(cd "$tmp" && sha256sum -c --quiet SHA256SUMS)
published=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$tmp/latest.json")
[ "$published" = "$version" ] || { echo "latest.json says $published, the tag says $version" >&2; exit 1; }
chmod -R a+rX "$tmp"

# Swaps the version folder (republishing the same version replaces the previous one).
if [ -d "$DEST/$version" ]; then
  mv "$DEST/$version" "$tmp.old"
fi
mv "$tmp" "$DEST/$version"
rm -rf "$tmp.old"
trap - EXIT

# Points the root manifests at this version only if it is not older than the current one.
current=""
if [ -f "$DEST/latest.json" ]; then
  current=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/latest.json")
fi
newest=$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n1)
if [ -z "$current" ] || [ "$newest" = "$version" ] || [ "$FORCE" = 1 ]; then
  for f in latest.json instaladores.json INSTALACAO.md; do
    cp "$DEST/$version/$f" "$DEST/.$f.new"
    chmod a+r "$DEST/.$f.new"
    mv -f "$DEST/.$f.new" "$DEST/$f"
  done
  current="$version"
  echo "latest.json points at $version"
else
  echo "latest.json stays at $current (newer than $version); use FORCAR=1 to swap"
fi

# Keeps the $KEEP most recent versions, and never the one latest.json points at.
mapfile -t versions < <(find "$DEST" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]+\.[0-9]+\.[0-9]+[^/]*' -printf '%f\n' | sort -V)
excess=$(( ${#versions[@]} - KEEP ))
for ((i = 0; i < excess; i++)); do
  v="${versions[$i]}"
  [ "$v" = "$current" ] && continue
  echo "removing the old version $v"
  rm -rf "${DEST:?}/$v"
done

echo "published: $DEST/$version"
ls -la "$DEST"
