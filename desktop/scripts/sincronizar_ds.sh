#!/usr/bin/env bash
# Sincroniza a base visual da UI do desktop com o Design System do eclume:
#   - desktop/ui/eclume.css: a mesma cópia fiel que o web usa (web/src/styles/eclume.css), ou,
#     sem ela, o styles.css do eclume-design sem o @import do Google Fonts;
#   - desktop/ui/fonts/*.woff2 e OFL.txt: Archivo e IBM Plex Mono (subconjunto latin) do
#     @fontsource, na mesma versão que o web usa, baixados por `npm pack` num diretório temporário.
# Uso: bash desktop/scripts/sincronizar_ds.sh [caminho-do-eclume-design]
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ds="${1:-${ECLUME_DESIGN_DIR:-$raiz/../eclume-design}}"
ui="$raiz/desktop/ui"
versao_fontes="5.3.0"

web_css="$raiz/web/src/styles/eclume.css"
if [[ -f "$web_css" ]]; then
  cp "$web_css" "$ui/eclume.css"
  echo "eclume.css copiado de web/src/styles/eclume.css"
else
  [[ -f "$ds/styles.css" ]] || { echo "styles.css não encontrado em $ds" >&2; exit 1; }
  {
    printf '/* Cópia fiel de eclume-design/styles.css (sync %s), sem o @import do Google Fonts:\n' \
      "$(date -u +%Y-%m-%dT%H:%MZ)"
    printf '   as fontes vêm de fonts.css. Não edite: ajuste de produto vai em app.css. */\n'
    grep -v '^@import url(.https://fonts.googleapis.com' "$ds/styles.css"
  } >"$ui/eclume.css"
  echo "eclume.css gerado de $ds/styles.css"
fi

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
