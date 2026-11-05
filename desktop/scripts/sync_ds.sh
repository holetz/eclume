#!/usr/bin/env bash
# Downloads the desktop UI fonts: desktop/ui/fonts/*.woff2 and OFL.txt, Archivo and IBM Plex Mono
# (latin subset) from @fontsource, at the same version the web uses, through `npm pack` in a
# temporary directory. desktop/ui/eclume.css comes from the Design System through design-system/sync.py.
# Usage: bash desktop/scripts/sync_ds.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ui="$root/desktop/ui"
fonts_version="5.3.0"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$ui/fonts"
: >"$tmp/OFL.txt"
for family in "archivo:Archivo:400 500 600 700 800" "ibm-plex-mono:IBM Plex Mono:400 500"; do
  IFS=: read -r name title weights <<<"$family"
  (cd "$tmp" && npm pack --silent "@fontsource/$name@$fonts_version" >/dev/null)
  mkdir -p "$tmp/$name"
  tar -xzf "$tmp/fontsource-$name-$fonts_version.tgz" -C "$tmp/$name"
  for weight in $weights; do
    cp "$tmp/$name/package/files/$name-latin-$weight-normal.woff2" "$ui/fonts/"
  done
  {
    printf '== %s (@fontsource/%s %s) ==\n\n' "$title" "$name" "$fonts_version"
    cat "$tmp/$name/package/LICENSE"
    printf '\n\n'
  } >>"$tmp/OFL.txt"
done
cp "$tmp/OFL.txt" "$ui/fonts/OFL.txt"
echo "fonts in $ui/fonts"
