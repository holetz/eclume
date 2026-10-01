#!/usr/bin/env bash
# Release do app desktop no host GPU, sem GitHub Actions: compila no daemon do host (contexto
# Docker) em contêiner com CPU limitada e sem nenhum segredo montado; depois empacota, assinando os
# executáveis Windows por Authenticode (quando o host tem a configuração em
# $SECRETS/assinatura-windows/) e os pacotes do updater com a chave minisign que só existe no host;
# confere a assinatura do instalador Windows, monta latest.json, instaladores.json e SHA256SUMS e,
# com --publicar, cria o GitHub Release desktop-v<versão> pelo gh do host. Depois,
# deploy/publicar-desktop.sh leva o release para /downloads.
# Contrato: docs/standards/code/desktop-distribuicao.md.
#
# Uso: bash deploy/release-desktop.sh [--plan] [--context NOME] [--sem-windows] [--publicar]
#                                     [--notas "texto"] [--sem-gate "motivo"] [--sem-assinatura]
#   --plan      só mostra o que faria (somente leitura).
#   --context   contexto Docker do host (ou $ECLUME_DOCKER_CONTEXT); obrigatório, sem padrão.
#   --sem-windows  deixa o Windows de fora (por padrão o release inclui o instalador NSIS,
#               compilado por compilação cruzada; `--windows` segue aceito e não muda nada).
#   --publicar  cria a tag e o GitHub Release; sem ele é ensaio e os artefatos ficam no host.
#   --notas     notas do release, que o app mostra no aviso "Atualizado para X".
#   --sem-gate  com --publicar, dispensa só o status eclume/gate = success no commit e deixa nele o
#               rastro eclume/gate-dispensa com o motivo; o ensaio não exige gate.
#   --sem-assinatura  aceita publicar o instalador Windows sem assinatura de código quando o host
#               não tem a configuração; sem ele, --publicar recusa (o ensaio só avisa).
# Variáveis: ECLUME_SERVER_URL, ECLUME_SERVER_CA_SHA256 e ECLUME_DOWNLOADS_URL (padrão: as variáveis
# do repositório; sem elas, recusa), ECLUME_DISK_LIMIT (90), ECLUME_SSH (quando o contexto não é ssh://).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
REPO=holetz/eclume
SECRETS=/srv/eclume/secrets
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
PLAN_ONLY=0
WINDOWS=1
PUBLICAR=0
NOTAS=""
SEM_GATE=""
SEM_ASSINATURA=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context exige o nome de um contexto Docker." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --windows) WINDOWS=1; shift ;;
    --sem-windows) WINDOWS=0; shift ;;
    --publicar) PUBLICAR=1; shift ;;
    --notas)
      [[ $# -ge 2 ]] || { echo "--notas exige um texto." >&2; exit 2; }
      NOTAS="$2"; shift 2 ;;
    --sem-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--sem-gate exige o motivo." >&2; exit 2; }
      SEM_GATE="$2"; shift 2 ;;
    --sem-assinatura) SEM_ASSINATURA=1; shift ;;
    --help|-h) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CONTEXT" ]] || { echo "Falta o contexto Docker do host: --context NOME ou ECLUME_DOCKER_CONTEXT." >&2; exit 2; }
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
# Como no workflow: a variável do ambiente ou a do repositório; sem padrão, o updater apontaria
# para o /downloads de outro servidor.
DOWNLOADS_URL="${ECLUME_DOWNLOADS_URL:-$(gh variable get ECLUME_DOWNLOADS_URL -R "$REPO" 2>/dev/null || true)}"
[[ -n "$DOWNLOADS_URL" ]] || { echo "Falta ECLUME_DOWNLOADS_URL (o /downloads do servidor que publica o desktop)." >&2; exit 2; }

# shellcheck disable=SC2016 # o $HOME é o do host
BASE="$(host 'echo "$HOME"')/eclume-build/release"
SRC="$BASE/src"
DIST="$BASE/dist-$VERSAO"
REGISTRY="$(dirname "$BASE")/cargo-registry"
# As imagens de build levam na tag a versão do Rust de desktop/rust-toolchain.toml.
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml)"
IMG_LINUX="eclume-desktop-build:$RUST"
IMG_WINDOWS="eclume-desktop-build-windows:$RUST"

# Pré-condições do --publicar: o release aponta para um commit que o GitHub tem, feito de uma árvore
# limpa e provado pelo gate (status eclume/gate), e nunca sobrescreve uma tag.
problemas=()
[[ -z "$(git status --porcelain)" ]] || problemas+=("a árvore de trabalho tem mudanças; o release sai do commit $SHA, sem elas")
gate_ok=0
if gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null; then
  gate_ok=1
  gate="$(gh api "repos/$REPO/commits/$SHA/status" | python3 deploy/gate.py decidir)" || gate_ok=0
  [[ "$gate_ok" -eq 1 || -n "$SEM_GATE" ]] \
    || problemas+=("$gate (rode bash deploy/gate.sh ou dispense com --sem-gate \"motivo\")")
else
  problemas+=("o commit $SHA não está no GitHub (faça o push antes)")
fi
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  problemas+=("o release $TAG já existe (suba a versão no tauri.conf.json)")
fi

# Assinatura Authenticode do Windows: a configuração do fornecedor vive só no host.
ASSINATURA_DIR="$SECRETS/assinatura-windows"
ASSINA=0
if [[ "$WINDOWS" -eq 1 ]] && host "test -s '$ASSINATURA_DIR/assinatura.env'"; then
  ASSINA=1
fi
if [[ "$WINDOWS" -eq 0 ]]; then
  estado_assinatura="fora (sem o Windows)"
elif [[ "$ASSINA" -eq 1 ]]; then
  estado_assinatura="configurada ($ASSINATURA_DIR)"
else
  estado_assinatura="ausente: o instalador sai sem assinatura de código"
  [[ "$SEM_ASSINATURA" -eq 1 ]] \
    || problemas+=("instalador Windows sem assinatura (configure $ASSINATURA_DIR no host ou aceite com --sem-assinatura)")
fi

pct="$(host "df --output=pcent / | tail -n 1 | tr -dc 0-9")"

# --- plano ----------------------------------------------------------------------------------------
echo "Versão $VERSAO · tag $TAG · commit $SHA" >&2
echo "Alvos: ${ALVOS[*]} · $([[ "$PUBLICAR" -eq 1 ]] && echo "publica o GitHub Release" || echo "ensaio (não publica)")" >&2
echo "Host: $SSH (contexto $CONTEXT) · código em $SRC · artefatos em $DIST" >&2
echo "Servidor embutido: $SERVER_URL · CA $SERVER_CA" >&2
echo "Código Windows: assinatura Windows $estado_assinatura" >&2
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%)" >&2
for p in "${problemas[@]}"; do echo "  aviso: $p" >&2; done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

if [[ "$PUBLICAR" -eq 1 && "${#problemas[@]}" -gt 0 ]]; then
  echo "Publicação recusada: ${problemas[*]}." >&2; exit 2
fi
if [[ "$PUBLICAR" -eq 1 && "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="release $TAG: ${SEM_GATE:0:120}" --silent \
    || { echo "Não consegui publicar o rastro eclume/gate-dispensa; publicação recusada." >&2; exit 2; }
  echo "Gate dispensado: $SEM_GATE (rastro eclume/gate-dispensa no commit)." >&2
fi
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: acima de ${DISK_LIMIT}%, release recusado." >&2; exit 3; }
host "test -s $SECRETS/tauri-updater.key && test -s $SECRETS/tauri-updater.key.password" || {
  echo "Falta a chave do updater em $SECRETS no host." >&2; exit 2; }

host "mkdir -p '$BASE' '$REGISTRY' && mkdir '$BASE/.trava'" || {
  echo "Outro release está em execução (ou sobrou $BASE/.trava no host)." >&2; exit 3; }
trap 'host "rmdir \"$BASE/.trava\""' EXIT

# --- código: o commit, não a árvore de trabalho ---------------------------------------------------
echo "Enviando o código de $SHA para o host…" >&2
# Sem a conversão de fim de linha da estação (core.autocrlf): o host recebe os bytes do commit.
git -c core.autocrlf=false archive --format=tar "$SHA" | host "rm -rf '$SRC' && mkdir -p '$SRC' && tar -x -C '$SRC'"
host "rm -rf '$DIST' && mkdir -p '$DIST'"

# --- build ----------------------------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain
# Teto de memória dos contêineres de build, ao lado das 2 CPUs: a produção divide o host.
MEMORIA="${ECLUME_BUILD_MEMORY:-6g}"
echo "Imagem $IMG_LINUX…" >&2
docker build -q -t "$IMG_LINUX" -f desktop/build.Dockerfile desktop >/dev/null
if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Imagem $IMG_WINDOWS…" >&2
  docker build -q --build-arg "RUST=$RUST" -t "$IMG_WINDOWS" - < desktop/build-windows.Dockerfile >/dev/null
fi

# A CLI do Tauri sai de desktop/package-lock.json, instalada sem scripts num contêiner sem a chave
# do updater; o build depois só a executa (npx --no-install).
echo "CLI do Tauri (npm ci, sem a chave)…" >&2
docker run --rm --cpus 2 --memory "$MEMORIA" -u 1000:1000 -e HOME=/tmp -v "$SRC:/src" -w /src/desktop "$IMG_LINUX" \
  nice -n 10 npm ci --ignore-scripts --no-audit --no-fund

# $1: imagem · $2: pasta do target/ no host · $3: pasta extra montada em /tmp/.cache (ou vazio)
# $4: "assina" para montar a configuração de assinatura do Windows (ou vazio) · $5: argumentos do
# `tauri build` (alvo, runner) · $6: argumentos do `tauri bundle` (pacotes, alvo).
# Dois tempos: a compilação, onde rodam os scripts de build de terceiros, não vê segredo nenhum; o
# empacotamento recebe a chave do updater (só leitura, vira variável dentro do contêiner) e, no
# Windows assinado, /run/assinatura com o signCommand do Tauri apontando para o assinador.
compilar() {
  local img="$1" target="$2" cache="$3" assina="$4" build_args="$5" bundle_args="$6"
  host "mkdir -p '$target'"
  [[ -z "$cache" ]] || host "mkdir -p '$cache'"
  local comum=(--rm --cpus 2 --memory "$MEMORIA" -u 1000:1000
    -e HOME=/tmp -e CARGO_BUILD_JOBS=2 -e CARGO_TARGET_DIR=/target
    -e ECLUME_SERVER_URL="$SERVER_URL" -e ECLUME_SERVER_CA_SHA256="$SERVER_CA"
    -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=true
    -v "$SRC:/src" -v "$target:/target" -v "$REGISTRY:/opt/cargo/registry"
    ${cache:+-v "$cache:/tmp/.cache"}
    -w /src/desktop/src-tauri)
  # shellcheck disable=SC2086 # os argumentos do tauri vêm separados por espaço
  docker run "${comum[@]}" "$img" \
    nice -n 10 npx --no-install tauri build --ci --no-bundle $build_args
  local assinatura=() config=""
  if [[ "$assina" == assina ]]; then
    assinatura=(-v "$ASSINATURA_DIR:/run/assinatura:ro")
    config='{"bundle":{"windows":{"signCommand":"bash /src/desktop/scripts/assinar-windows.sh %1"}}}'
  fi
  docker run "${comum[@]}" "${assinatura[@]}" \
    -v "$SECRETS/tauri-updater.key:/run/chave/key:ro" \
    -v "$SECRETS/tauri-updater.key.password:/run/chave/senha:ro" \
    -e ECLUME_TAURI_CONFIG="$config" "$img" \
    bash -c 'export TAURI_SIGNING_PRIVATE_KEY="$(cat /run/chave/key)"
             export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat /run/chave/senha)"
             extra=(); [[ -z "$ECLUME_TAURI_CONFIG" ]] || extra=(--config "$ECLUME_TAURI_CONFIG")
             exec nice -n 10 npx --no-install tauri bundle --ci "${extra[@]}" "$@"' tauri $bundle_args
}

echo "Compilando o Linux (AppImage e deb)…" >&2
compilar "$IMG_LINUX" "$BASE/target-linux" "" "" "" "--bundles appimage,deb"
host "cd '$BASE/target-linux/release/bundle' && cp appimage/*_${VERSAO}_*.AppImage* deb/*_${VERSAO}_*.deb* '$DIST/'"

if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Compilando o Windows (NSIS, cruzado)…" >&2
  modo=""
  [[ "$ASSINA" -eq 0 ]] || modo=assina
  compilar "$IMG_WINDOWS" "$BASE/target-windows" "$BASE/xwin-cache" "$modo" \
    "--runner cargo-xwin --target x86_64-pc-windows-msvc" \
    "--target x86_64-pc-windows-msvc --bundles nsis"
  NSIS="$BASE/target-windows/x86_64-pc-windows-msvc/release/bundle/nsis"
  if [[ "$ASSINA" -eq 1 ]]; then
    # Nenhum instalador sai com assinatura quebrada ou sem carimbo: o setup e os executáveis de
    # dentro (extraídos pelo 7z) passam pela conferência, sem segredo nenhum montado.
    echo "Conferindo a assinatura do instalador Windows…" >&2
    docker run --rm -u 1000:1000 -e HOME=/tmp -v "$SRC:/src:ro" -v "$NSIS:/nsis:ro" "$IMG_WINDOWS" \
      bash -c 'set -euo pipefail
               assinar=/src/desktop/scripts/assinar-windows.sh
               setup="$(ls /nsis/*_'"$VERSAO"'_*-setup.exe)"
               bash "$assinar" --verificar "$setup"
               dir="$(mktemp -d)"; 7z x -y -o"$dir" "$setup" >/dev/null
               for nome in eclume-desktop.exe uninstall.exe; do
                 achado="$(find "$dir" -iname "$nome" -print -quit)"
                 [[ -n "$achado" ]] || { echo "$nome não está no instalador" >&2; exit 1; }
                 bash "$assinar" --verificar "$achado"
               done'
  else
    echo "Aviso: instalador Windows sem assinatura de código (sem $ASSINATURA_DIR no host)." >&2
  fi
  host "cp '$NSIS/'*_${VERSAO}_*-setup.exe* '$DIST/'"
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
