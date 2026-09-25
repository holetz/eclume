#!/usr/bin/env bash
# Publica um release do app desktop no host: baixa os assets do GitHub Release (privado) para
# /srv/eclume/downloads/<versão>/, confere o SHA256SUMS e só então troca latest.json,
# instaladores.json e INSTALACAO.md na raiz, que o Caddy do eclume serve em /downloads/.
# Contrato: docs/standards/code/desktop-distribuicao.md.
#
# Roda no host (lá o `gh` está autenticado):
#   deploy/publicar-desktop.sh [desktop-v<versão>]       # sem tag: o release desktop-v* mais recente
# ou, da máquina de dev:
#   ssh holetz@192.168.15.199 'bash -s -- desktop-v0.1.0' < deploy/publicar-desktop.sh
#
# Variáveis: DESTINO (padrão /srv/eclume/downloads), REPO (holetz/eclume), MANTER (3 versões),
# FORCAR=1 para apontar latest.json para uma versão mais antiga que a atual.
set -euo pipefail

DESTINO="${DESTINO:-/srv/eclume/downloads}"
REPO="${REPO:-holetz/eclume}"
MANTER="${MANTER:-3}"
FORCAR="${FORCAR:-0}"

tag="${1:-}"
if [ -z "$tag" ]; then
  tag=$(gh release list -R "$REPO" --limit 50 --json tagName \
    --jq '[.[] | select(.tagName | startswith("desktop-v"))][0].tagName // empty')
  [ -n "$tag" ] || { echo "nenhum release desktop-v* em $REPO" >&2; exit 1; }
fi
case "$tag" in
  desktop-v*) ;;
  *) echo "tag inválida: $tag (esperado desktop-v<versão>)" >&2; exit 2 ;;
esac
versao="${tag#desktop-v}"

mkdir -p "$DESTINO"
tmp=$(mktemp -d "$DESTINO/.baixando-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "baixando $tag de $REPO"
gh release download "$tag" -R "$REPO" -D "$tmp"
(cd "$tmp" && sha256sum -c --quiet SHA256SUMS)
publicada=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$tmp/latest.json")
[ "$publicada" = "$versao" ] || { echo "latest.json diz $publicada, a tag diz $versao" >&2; exit 1; }
chmod -R a+rX "$tmp"

# Troca a pasta da versão (republicar a mesma versão substitui a anterior).
if [ -d "$DESTINO/$versao" ]; then
  mv "$DESTINO/$versao" "$tmp.antiga"
fi
mv "$tmp" "$DESTINO/$versao"
rm -rf "$tmp.antiga"
trap - EXIT

# Só aponta os manifestos da raiz para esta versão se ela não for mais antiga que a atual.
atual=""
if [ -f "$DESTINO/latest.json" ]; then
  atual=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DESTINO/latest.json")
fi
maior=$(printf '%s\n%s\n' "$atual" "$versao" | sort -V | tail -n1)
if [ -z "$atual" ] || [ "$maior" = "$versao" ] || [ "$FORCAR" = 1 ]; then
  for f in latest.json instaladores.json INSTALACAO.md; do
    cp "$DESTINO/$versao/$f" "$DESTINO/.$f.novo"
    chmod a+r "$DESTINO/.$f.novo"
    mv -f "$DESTINO/.$f.novo" "$DESTINO/$f"
  done
  atual="$versao"
  echo "latest.json aponta para $versao"
else
  echo "latest.json segue em $atual (mais nova que $versao); use FORCAR=1 para trocar"
fi

# Mantém as $MANTER versões mais recentes, e nunca a que latest.json aponta.
mapfile -t versoes < <(find "$DESTINO" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]+\.[0-9]+\.[0-9]+[^/]*' -printf '%f\n' | sort -V)
excedentes=$(( ${#versoes[@]} - MANTER ))
for ((i = 0; i < excedentes; i++)); do
  v="${versoes[$i]}"
  [ "$v" = "$atual" ] && continue
  echo "removendo a versão antiga $v"
  rm -rf "${DESTINO:?}/$v"
done

echo "publicado: $DESTINO/$versao"
ls -la "$DESTINO"
