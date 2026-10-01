#!/usr/bin/env bash
# Release do app móvel no host GPU, sem GitHub Actions (espelho do deploy/release-desktop.sh):
# compila o APK de release no daemon do host (contexto Docker) em contêiner com CPU limitada, assina
# com a keystore que só existe no host (montada só leitura no contêiner), confere o certificado
# contra mobile/certificado-release.sha256, monta movel.json e SHA256SUMS, roda a fumaça do APK
# minificado no emulador do host e, com --publicar, cria o GitHub Release mobile-v<versão> pelo gh do
# host. Depois, deploy/publicar-movel.sh leva o release para /downloads/movel.
# Contrato: docs/standards/code/mobile-distribuicao.md.
#
# Uso: bash deploy/release-movel.sh [--plan] [--context NOME] [--publicar] [--notas "texto"]
#                                   [--sem-gate "motivo"] [--sem-fumaca]
#   --plan      só mostra o que faria (somente leitura).
#   --context   contexto Docker do host (padrão: $ECLUME_DOCKER_CONTEXT ou gpu-host).
#   --publicar  cria a tag e o GitHub Release; sem ele é ensaio e os artefatos ficam no host.
#   --notas     notas do release, que o app e a /app-movel mostram; sem ele, a seção da versão no
#               mobile/CHANGELOG.md (docs/standards/code/versionamento.md).
#   --sem-gate  com --publicar, dispensa só o status eclume/gate = success no commit e deixa nele o
#               rastro eclume/gate-dispensa com o motivo; o ensaio não exige gate.
#   --sem-fumaca  pula a fumaça no emulador (só no ensaio; --publicar sempre a roda).
# Variáveis: ECLUME_DISK_LIMIT (90), ECLUME_SSH (quando o contexto não é ssh://).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
REPO=holetz/eclume
SECRETS=/srv/eclume/secrets
KEYSTORE="$SECRETS/eclume-android.jks"
SENHA="$SECRETS/android-keystore-password"
ALIAS=eclume
CERTIFICADO_ESPERADO=mobile/certificado-release.sha256
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
PLAN_ONLY=0
PUBLICAR=0
NOTAS=""
SEM_GATE=""
FUMACA=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context exige o nome de um contexto Docker." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --publicar) PUBLICAR=1; shift ;;
    --notas)
      [[ $# -ge 2 ]] || { echo "--notas exige um texto." >&2; exit 2; }
      NOTAS="$2"; shift 2 ;;
    --sem-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--sem-gate exige o motivo." >&2; exit 2; }
      SEM_GATE="$2"; shift 2 ;;
    --sem-fumaca) FUMACA=0; shift ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ "$PUBLICAR" -eq 0 || "$FUMACA" -eq 1 ]] || { echo "--publicar sempre roda a fumaça." >&2; exit 2; }

export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "O contexto $CONTEXT não é ssh:// ($endpoint); defina ECLUME_SSH=usuario@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

# --- o que sai ------------------------------------------------------------------------------------
VERSAO="$(python3 -c "import json; print(json.load(open('mobile/src-tauri/tauri.conf.json'))['version'])")"
TAG="mobile-v$VERSAO"
SHA="$(git rev-parse HEAD)"
[[ -n "$NOTAS" ]] || NOTAS="$(python3 deploy/versao.py notas movel "$VERSAO")" \
  || { echo "Falta a seção [$VERSAO] no mobile/CHANGELOG.md: escreva-a ou passe --notas." >&2; exit 2; }

# shellcheck disable=SC2016 # o $HOME é o do host
HOME_HOST="$(host 'echo "$HOME"')"
BASE="$HOME_HOST/eclume-build/movel"
SRC="$BASE/src"
DIST="$BASE/dist-$VERSAO"
FUMACA_APK="$BASE/fumaca-$VERSAO.apk"
REGISTRY="$HOME_HOST/eclume-build/cargo-registry"
GRADLE="$BASE/gradle"
# O SDK, o NDK e o JDK de mobile/scripts/android-sdk.sh, só leitura no contêiner.
SDK="$HOME_HOST/android-sdk"
NDK="$SDK/ndk/28.2.13676358"
JDK="$HOME_HOST/jdk-21"
# As imagens levam na tag a versão do Rust de mobile/rust-toolchain.toml (a mesma do desktop).
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' mobile/rust-toolchain.toml)"
IMG_BASE="eclume-desktop-build:$RUST"
IMG="eclume-mobile-build:$RUST"

# Pré-condições do --publicar: o release aponta para um commit que o GitHub tem, feito de uma árvore
# limpa e provado pelo gate (status eclume/gate), nunca sobrescreve uma tag, e o certificado da
# keystore é o versionado.
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
esperado=""
if [[ -s "$CERTIFICADO_ESPERADO" ]]; then
  esperado="$(tr -d ' :\n' < "$CERTIFICADO_ESPERADO" | tr 'A-F' 'a-f')"
else
  problemas+=("falta $CERTIFICADO_ESPERADO (o SHA-256 do certificado da keystore, impresso por mobile/scripts/criar-keystore.sh)")
fi
host "test -s '$KEYSTORE' && test -s '$SENHA'" || problemas+=("falta a keystore de release em $SECRETS no host")

pct="$(host "df --output=pcent / | tail -n 1 | tr -dc 0-9")"

# --- plano ----------------------------------------------------------------------------------------
echo "Versão $VERSAO · tag $TAG · commit $SHA" >&2
echo "Sai: APK universal (aarch64, armv7) e um x86_64 só para a fumaça · $([[ "$PUBLICAR" -eq 1 ]] && echo "publica o GitHub Release" || echo "ensaio (não publica)")" >&2
echo "Host: $SSH (contexto $CONTEXT) · código em $SRC · artefatos em $DIST" >&2
echo "Certificado esperado: ${esperado:-ausente} · fumaça: $([[ "$FUMACA" -eq 1 ]] && echo sim || echo não)" >&2
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%)" >&2
for p in "${problemas[@]}"; do echo "  aviso: $p" >&2; done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

if [[ "$PUBLICAR" -eq 1 && "${#problemas[@]}" -gt 0 ]]; then
  echo "Publicação recusada: ${problemas[*]}." >&2; exit 2
fi
[[ -n "$esperado" ]] || { echo "Sem $CERTIFICADO_ESPERADO, nem o ensaio confere a assinatura." >&2; exit 2; }
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: acima de ${DISK_LIMIT}%, release recusado." >&2; exit 3; }
host "test -s '$KEYSTORE' && test -s '$SENHA'" || { echo "Falta a keystore de release em $SECRETS no host." >&2; exit 2; }
if [[ "$PUBLICAR" -eq 1 && "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="release $TAG: ${SEM_GATE:0:120}" --silent \
    || { echo "Não consegui publicar o rastro eclume/gate-dispensa; publicação recusada." >&2; exit 2; }
  echo "Gate dispensado: $SEM_GATE (rastro eclume/gate-dispensa no commit)." >&2
fi

host "mkdir -p '$BASE' '$REGISTRY' '$GRADLE' && mkdir '$BASE/.trava'" || {
  echo "Outro release do celular está em execução (ou sobrou $BASE/.trava no host)." >&2; exit 3; }
trap 'host "rmdir \"$BASE/.trava\""' EXIT

# --- código: o commit, não a árvore de trabalho ---------------------------------------------------
echo "Enviando o código de $SHA para o host…" >&2
git -c core.autocrlf=false archive --format=tar "$SHA" | host "rm -rf '$SRC' && mkdir -p '$SRC' && tar -x -C '$SRC'"
host "rm -rf '$DIST' && mkdir -p '$DIST'"

# --- build ----------------------------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain
echo "Imagens $IMG_BASE e $IMG…" >&2
docker build -q -t "$IMG_BASE" -f desktop/build.Dockerfile desktop >/dev/null
docker build -q --build-arg "RUST=$RUST" -t "$IMG" - < mobile/build.Dockerfile >/dev/null

# Contêiner comum: CPU limitada, uid 1000, o SDK, o NDK e o JDK só leitura, caches no host.
comum=(--rm --cpus 2 -u 1000:1000 -e HOME=/tmp -e CARGO_BUILD_JOBS=2
  -e ANDROID_HOME=/opt/android-sdk -e ANDROID_SDK_ROOT=/opt/android-sdk -e JAVA_HOME=/opt/jdk
  -e NDK_HOME=/opt/ndk -e ANDROID_NDK_HOME=/opt/ndk -e ANDROID_NDK_ROOT=/opt/ndk
  -e GRADLE_USER_HOME=/opt/gradle
  -v "$SRC:/src" -v "$REGISTRY:/opt/cargo/registry" -v "$GRADLE:/opt/gradle"
  -v "$SDK:/opt/android-sdk:ro" -v "$NDK:/opt/ndk:ro" -v "$JDK:/opt/jdk:ro")

echo "CLI do Tauri (npm ci, sem a keystore)…" >&2
docker run "${comum[@]}" -w /src/mobile "$IMG" nice -n 10 npm ci --ignore-scripts --no-audit --no-fund

# A keystore e a senha entram só leitura e viram o keystore.properties dentro do contêiner (fora
# do git, apagado no fim). $1…: os alvos do `tauri android build`.
compilar() {
  docker run "${comum[@]}" \
    -v "$KEYSTORE:/run/chave/keystore.jks:ro" -v "$SENHA:/run/chave/senha:ro" \
    -w /src/mobile "$IMG" \
    bash -c 'props=src-tauri/gen/android/keystore.properties
             trap "rm -f $props" EXIT
             printf "storeFile=/run/chave/keystore.jks\npassword=%s\nkeyAlias='"$ALIAS"'\n" "$(cat /run/chave/senha)" > "$props"
             alvos=(); for a in "$@"; do alvos+=(--target "$a"); done
             nice -n 10 npx --no-install tauri android build --apk "${alvos[@]}" --ci' tauri "$@"
}

APKS="$SRC/mobile/src-tauri/gen/android/app/build/outputs/apk"
echo "Compilando o APK universal (aarch64, armv7)…" >&2
compilar aarch64 armv7
host "cp '$APKS/universal/release/app-universal-release.apk' '$DIST/eclume-$VERSAO.apk'"
echo "Compilando o APK x86_64 da fumaça (mesma chave)…" >&2
compilar x86_64
host "cp \"\$(find '$APKS' -path '*release*' -name '*.apk' -newer '$DIST/eclume-$VERSAO.apk' | head -n 1)\" '$FUMACA_APK'"

# --- assinatura e manifestos ----------------------------------------------------------------------
certificado="$(docker run "${comum[@]}" -v "$DIST:/dist:ro" "$IMG" \
  bash -c 'apksigner=$(ls /opt/android-sdk/build-tools/*/apksigner | sort -V | tail -n1)
           "$apksigner" verify --print-certs /dist/eclume-'"$VERSAO"'.apk' \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d ' :' | tr 'A-F' 'a-f')"
if [[ "$certificado" != "$esperado" ]]; then
  echo "O APK saiu com o certificado ${certificado:-ausente}, não o versionado ($esperado): release recusado." >&2
  exit 2
fi
echo "Assinatura conferida: certificado $certificado." >&2
host "cd '$DIST' && cp '$SRC/mobile/INSTALACAO.md' . \
  && python3 '$SRC/mobile/scripts/manifesto_movel.py' --pasta . --versao '$VERSAO' \
       --certificado '$certificado' --notas $(printf '%q' "$NOTAS") \
  && sha256sum -c --quiet SHA256SUMS && ls -la"

# --- fumaça do APK minificado no emulador ----------------------------------------------------------
if [[ "$FUMACA" -eq 1 ]]; then
  echo "Fumaça do APK de release no emulador…" >&2
  host "source ~/.config/eclume/android-env.sh && bash '$SRC/mobile/scripts/prova-emulador.sh' --fumaca '$FUMACA_APK'"
fi

if [[ "$PUBLICAR" -eq 0 ]]; then
  echo "Ensaio pronto em $SSH:$DIST (nada publicado)." >&2
  exit 0
fi
host "cd '$DIST' && gh release create '$TAG' ./* --repo '$REPO' --target '$SHA' \
  --title 'eclume para Android $VERSAO' \
  --notes 'APK do app móvel do eclume $VERSAO. Os celulares baixam de /downloads/movel/ no servidor eclume (deploy/publicar-movel.sh).'"
echo "Publicado $TAG. Para servir em /downloads/movel:" >&2
echo "  ssh $SSH 'bash -s -- $TAG' < deploy/publicar-movel.sh" >&2
