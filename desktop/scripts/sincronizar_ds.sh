#!/usr/bin/env bash
# Baixa as fontes da UI do desktop: desktop/ui/fonts/*.woff2 e OFL.txt, Archivo e IBM Plex Mono
# (subconjunto latin) do @fontsource, na mesma versão que o web usa, por `npm pack` num diretório
# temporário. O desktop/ui/eclume.css vem do Design System por design-system/sync.py.
# Uso: bash desktop/scripts/sincronizar_ds.sh
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ui="$raiz/desktop/ui"
versao_fontes="5.3.0"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$ui/fonts"
: >"$tmp/OFL.txt"
for familia in "archivo:Archivo:400 500 600 700 800" "ibm-plex-mono:IBM Plex Mono:400 500"; do
  IFS=: read -r nome titulo pesos <<<"$familia"
  (cd "$tmp" && npm pack --silent "@fontsource/$nome@$versao_fontes" >/dev/null)
  mkdir -p "$tmp/$nome"
  tar -xzf "$tmp/fontsource-$nome-$versao_fontes.tgz" -C "$tmp/$nome"
  for peso in $pesos; do
    cp "$tmp/$nome/package/files/$nome-latin-$peso-normal.woff2" "$ui/fonts/"
  done
  {
    printf '== %s (@fontsource/%s %s) ==\n\n' "$titulo" "$nome" "$versao_fontes"
    cat "$tmp/$nome/package/LICENSE"
    printf '\n\n'
  } >>"$tmp/OFL.txt"
done
cp "$tmp/OFL.txt" "$ui/fonts/OFL.txt"
echo "fontes em $ui/fonts"
