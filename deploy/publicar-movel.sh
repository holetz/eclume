#!/usr/bin/env bash
# Publica um release do app móvel no host: baixa os assets do GitHub Release (privado) para
# /srv/eclume/downloads/movel/<versão>/, confere o SHA256SUMS e só então troca
# /downloads/movel.json e /downloads/movel/INSTALACAO.md, por cópia e `mv`. O Caddy do eclume serve
# /downloads/. O nome `movel.json` é contrato com a página /app-movel da web e com o app
# instalado. Contrato: docs/standards/code/mobile-distribuicao.md.
#
# Roda no host (lá o `gh` está autenticado):
#   deploy/publicar-movel.sh [mobile-v<versão>]       # sem tag: o release mobile-v* mais recente
# ou, da máquina de dev:
#   ssh holetz@192.168.15.199 'bash -s -- mobile-v0.1.0' < deploy/publicar-movel.sh
#
# Variáveis: DESTINO (padrão /srv/eclume/downloads), REPO (holetz/eclume), MANTER (3 versões),
# FORCAR=1 para apontar o movel.json para uma versão mais antiga que a atual.
set -euo pipefail

DESTINO="${DESTINO:-/srv/eclume/downloads}"
REPO="${REPO:-holetz/eclume}"
MANTER="${MANTER:-3}"
FORCAR="${FORCAR:-0}"
MOVEL="$DESTINO/movel"

tag="${1:-}"
if [ -z "$tag" ]; then
  tag=$(gh release list -R "$REPO" --limit 50 --json tagName \
    --jq '[.[] | select(.tagName | startswith("mobile-v"))][0].tagName // empty')
  [ -n "$tag" ] || { echo "nenhum release mobile-v* em $REPO" >&2; exit 1; }
fi
case "$tag" in
  mobile-v*) ;;
  *) echo "tag inválida: $tag (esperado mobile-v<versão>)" >&2; exit 2 ;;
esac
versao="${tag#mobile-v}"

mkdir -p "$MOVEL"
tmp=$(mktemp -d "$MOVEL/.baixando-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "baixando $tag de $REPO"
gh release download "$tag" -R "$REPO" -D "$tmp"
(cd "$tmp" && sha256sum -c --quiet SHA256SUMS)
publicada=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["versao"])' "$tmp/movel.json")
[ "$publicada" = "$versao" ] || { echo "movel.json diz $publicada, a tag diz $versao" >&2; exit 1; }
chmod -R a+rX "$tmp"

# Troca a pasta da versão (republicar a mesma versão substitui a anterior).
if [ -d "$MOVEL/$versao" ]; then
  mv "$MOVEL/$versao" "$tmp.antiga"
fi
mv "$tmp" "$MOVEL/$versao"
rm -rf "$tmp.antiga"
trap - EXIT

# Só aponta o movel.json para esta versão se ela não for mais antiga que a atual.
atual=""
if [ -f "$DESTINO/movel.json" ]; then
  atual=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["versao"])' "$DESTINO/movel.json")
fi
maior=$(printf '%s\n%s\n' "$atual" "$versao" | sort -V | tail -n1)
if [ -z "$atual" ] || [ "$maior" = "$versao" ] || [ "$FORCAR" = 1 ]; then
  cp "$MOVEL/$versao/movel.json" "$DESTINO/.movel.json.novo"
  cp "$MOVEL/$versao/INSTALACAO.md" "$MOVEL/.INSTALACAO.md.novo"
  chmod a+r "$DESTINO/.movel.json.novo" "$MOVEL/.INSTALACAO.md.novo"
  mv -f "$MOVEL/.INSTALACAO.md.novo" "$MOVEL/INSTALACAO.md"
  mv -f "$DESTINO/.movel.json.novo" "$DESTINO/movel.json"
  atual="$versao"
  echo "movel.json aponta para $versao"
else
  echo "movel.json segue em $atual (mais nova que $versao); use FORCAR=1 para trocar"
fi

# Mantém as $MANTER versões mais recentes, e nunca a que o movel.json aponta.
mapfile -t versoes < <(find "$MOVEL" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]+\.[0-9]+\.[0-9]+[^/]*' -printf '%f\n' | sort -V)
excedentes=$(( ${#versoes[@]} - MANTER ))
for ((i = 0; i < excedentes; i++)); do
  v="${versoes[$i]}"
  [ "$v" = "$atual" ] && continue
  echo "removendo a versão antiga $v"
  rm -rf "${MOVEL:?}/$v"
done

echo "publicado: $MOVEL/$versao"
ls -la "$MOVEL"
