#!/usr/bin/env bash
# Release do app desktop no host GPU, sem GitHub Actions: compila no daemon do host (contexto
# Docker) em contêiner com CPU limitada, assina os pacotes do updater com a chave minisign que só
# existe no host, monta latest.json, instaladores.json e SHA256SUMS e, com --publicar, cria o
# GitHub Release desktop-v<versão> pelo gh do host. Depois, deploy/publicar-desktop.sh leva o
# release para /downloads. Contrato: docs/standards/code/desktop-distribuicao.md.
#
# Uso: bash deploy/release-desktop.sh [--plan] [--context NOME] [--windows] [--publicar]
#                                     [--notas "texto"]
#   --plan      só mostra o que faria (somente leitura).
#   --context   contexto Docker do host (padrão: $ECLUME_DOCKER_CONTEXT ou gpu-host).
#   --windows   inclui o instalador NSIS do Windows (compilação cruzada; desligado por padrão).
#   --publicar  cria a tag e o GitHub Release; sem ele é ensaio e os artefatos ficam no host.
#   --notas     notas do release, que o app mostra no aviso "Atualizado para X".
# Variáveis: ECLUME_SERVER_URL, ECLUME_SERVER_CA_SHA256 e ECLUME_DOWNLOADS_URL (padrão: as variáveis
# do repositório), ECLUME_DISK_LIMIT (90), ECLUME_SSH (quando o contexto não é ssh://).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
REPO=holetz/eclume
SECRETS=/srv/eclume/secrets
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
PLAN_ONLY=0
WINDOWS=0
PUBLICAR=0
NOTAS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context exige o nome de um contexto Docker." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --windows) WINDOWS=1; shift ;;
    --publicar) PUBLICAR=1; shift ;;
    --notas)
      [[ $# -ge 2 ]] || { echo "--notas exige um texto." >&2; exit 2; }
      NOTAS="$2"; shift 2 ;;
    --help|-h) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done

export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "O contexto $CONTEXT não é ssh:// ($endpoint); defina ECLUME_SSH=usuario@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

# --- o que sai ------------------------------------------------------------------------------------
VERSAO="$(python3 -c "import json; print(json.load(open('desktop/src-tauri/tauri.conf.json'))['version'])")"
TAG="desktop-v$VERSAO"
SHA="$(git rev-parse HEAD)"
NOTAS="${NOTAS:-eclume desktop $VERSAO}"
ALVOS=(linux)
[[ "$WINDOWS" -eq 0 ]] || ALVOS+=(windows)
SERVER_URL="${ECLUME_SERVER_URL:-$(gh variable get ECLUME_SERVER_URL -R "$REPO")}"
SERVER_CA="${ECLUME_SERVER_CA_SHA256:-$(gh variable get ECLUME_SERVER_CA_SHA256 -R "$REPO")}"
# Como no workflow: a variável do repositório, se existir, ou o /downloads do host de produção.
DOWNLOADS_URL="${ECLUME_DOWNLOADS_URL:-$(gh variable get ECLUME_DOWNLOADS_URL -R "$REPO" 2>/dev/null || echo https://192.168.15.199:8443/downloads)}"

# shellcheck disable=SC2016 # o $HOME é o do host
BASE="$(host 'echo "$HOME"')/eclume-build/release"
SRC="$BASE/src"
DIST="$BASE/dist-$VERSAO"
REGISTRY="$(dirname "$BASE")/cargo-registry"
IMG_LINUX=eclume-desktop-build:24.04
IMG_WINDOWS=eclume-desktop-build-windows:24.04

# Pré-condições do --publicar: o release aponta para um commit que o GitHub tem, feito de uma árvore
# limpa, e nunca sobrescreve uma tag.
problemas=()
[[ -z "$(git status --porcelain)" ]] || problemas+=("a árvore de trabalho tem mudanças; o release sai do commit $SHA, sem elas")
gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null || problemas+=("o commit $SHA não está no GitHub (faça o push antes)")
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  problemas+=("o release $TAG já existe (suba a versão no tauri.conf.json)")
fi

pct="$(host "df --output=pcent / | tail -n 1 | tr -dc 0-9")"

# --- plano ----------------------------------------------------------------------------------------
echo "Versão $VERSAO · tag $TAG · commit $SHA" >&2
echo "Alvos: ${ALVOS[*]} · $([[ "$PUBLICAR" -eq 1 ]] && echo "publica o GitHub Release" || echo "ensaio (não publica)")" >&2
echo "Host: $SSH (contexto $CONTEXT) · código em $SRC · artefatos em $DIST" >&2
echo "Servidor embutido: $SERVER_URL · CA $SERVER_CA" >&2
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%)" >&2
for p in "${problemas[@]}"; do echo "  aviso: $p" >&2; done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

if [[ "$PUBLICAR" -eq 1 && "${#problemas[@]}" -gt 0 ]]; then
  echo "Publicação recusada: ${problemas[*]}." >&2; exit 2
fi
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: acima de ${DISK_LIMIT}%, release recusado." >&2; exit 3; }
host "test -s $SECRETS/tauri-updater.key && test -s $SECRETS/tauri-updater.key.password" || {
  echo "Falta a chave do updater em $SECRETS no host." >&2; exit 2; }

host "mkdir -p '$BASE' '$REGISTRY' && mkdir '$BASE/.trava'" || {
  echo "Outro release está em execução (ou sobrou $BASE/.trava no host)." >&2; exit 3; }
trap 'host "rmdir \"$BASE/.trava\""' EXIT

# --- código: o commit, não a árvore de trabalho ---------------------------------------------------
echo "Enviando o código de $SHA para o host…" >&2
git archive --format=tar "$SHA" | host "rm -rf '$SRC' && mkdir -p '$SRC' && tar -x -C '$SRC'"
host "rm -rf '$DIST' && mkdir -p '$DIST'"

# --- build ----------------------------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain
echo "Imagem $IMG_LINUX…" >&2
docker build -q -t "$IMG_LINUX" - < desktop/build.Dockerfile >/dev/null
if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Imagem $IMG_WINDOWS…" >&2
  docker build -q -t "$IMG_WINDOWS" - < desktop/build-windows.Dockerfile >/dev/null
fi

# $1: imagem · $2: pasta do target/ no host · $3: pasta extra montada em /tmp/.cache (ou vazio)
# $4…: argumentos do `tauri build`. A chave entra só leitura e vira variável dentro do contêiner.
compilar() {
  local img="$1" target="$2" cache="$3"; shift 3
  host "mkdir -p '$target'"
  [[ -z "$cache" ]] || host "mkdir -p '$cache'"
  docker run --rm --cpus 2 -u 1000:1000 \
    -e HOME=/tmp -e CARGO_BUILD_JOBS=2 -e CARGO_TARGET_DIR=/target \
    -e ECLUME_SERVER_URL="$SERVER_URL" -e ECLUME_SERVER_CA_SHA256="$SERVER_CA" \
    -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=true \
    -v "$SRC:/src" -v "$target:/target" -v "$REGISTRY:/opt/cargo/registry" \
    ${cache:+-v "$cache:/tmp/.cache"} \
    -v "$SECRETS/tauri-updater.key:/run/chave/key:ro" \
    -v "$SECRETS/tauri-updater.key.password:/run/chave/senha:ro" \
    -w /src/desktop/src-tauri "$img" \
    bash -c 'export TAURI_SIGNING_PRIVATE_KEY="$(cat /run/chave/key)"
             export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat /run/chave/senha)"
             exec nice -n 10 npx --yes @tauri-apps/cli@2 build --ci "$@"' tauri "$@"
}

echo "Compilando o Linux (AppImage e deb)…" >&2
compilar "$IMG_LINUX" "$BASE/target-linux" "" --bundles appimage,deb
host "cd '$BASE/target-linux/release/bundle' && cp appimage/*_${VERSAO}_*.AppImage* deb/*_${VERSAO}_*.deb* '$DIST/'"

if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Compilando o Windows (NSIS, cruzado)…" >&2
  compilar "$IMG_WINDOWS" "$BASE/target-windows" "$BASE/xwin-cache" \
    --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
  host "cp '$BASE/target-windows/x86_64-pc-windows-msvc/release/bundle/nsis/'*_${VERSAO}_*-setup.exe* '$DIST/'"
fi

# --- manifestos e publicação ----------------------------------------------------------------------
host "cd '$DIST' && cp '$SRC/desktop/INSTALACAO.md' . \
  && python3 '$SRC/desktop/scripts/manifestos_release.py' --artefatos . --versao '$VERSAO' \
       --base-url '$DOWNLOADS_URL' --notas $(printf '%q' "$NOTAS") \
  && sha256sum -c --quiet SHA256SUMS && ls -la"

if [[ "$PUBLICAR" -eq 0 ]]; then
  echo "Ensaio pronto em $SSH:$DIST (nada publicado)." >&2
  exit 0
fi
host "cd '$DIST' && gh release create '$TAG' ./* --repo '$REPO' --target '$SHA' \
  --title 'eclume desktop $VERSAO' \
  --notes 'Instaladores do app desktop do eclume $VERSAO. Os clientes baixam de /downloads/ no servidor eclume (deploy/publicar-desktop.sh).'"
echo "Publicado $TAG. Para servir em /downloads:" >&2
echo "  ssh $SSH 'bash -s -- $TAG' < deploy/publicar-desktop.sh" >&2
