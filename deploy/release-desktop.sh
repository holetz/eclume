#!/usr/bin/env bash
# Release of the desktop app on the GPU host, without GitHub Actions: compiles on the host daemon
# (Docker context) in a CPU-limited container with no secret mounted; then bundles, signing the
# Windows executables with Authenticode (when the host has the configuration in
# $SECRETS/assinatura-windows/) and the updater packages with the minisign key that exists only on
# the host; checks the Windows installer signature, assembles latest.json, instaladores.json and
# SHA256SUMS and, with --publish, creates the desktop-v<version> GitHub Release through the host's gh.
# Then deploy/publish-desktop.sh takes the release to /downloads.
# Contract: docs/standards/code/desktop-distribuicao.md.
#
# Usage: bash deploy/release-desktop.sh [--plan] [--context NAME] [--no-windows] [--publish]
#                                       [--notes "text"] [--skip-gate "reason"] [--unsigned]
#   --plan        only shows what it would do (read-only).
#   --context     the host's Docker context (or $ECLUME_DOCKER_CONTEXT); required, no default.
#   --no-windows  leaves Windows out (by default the release includes the NSIS installer, built by
#                 cross-compilation; `--windows` is still accepted and changes nothing).
#   --publish     creates the tag and the GitHub Release; without it, it is a dry run and the
#                 artifacts stay on the host.
#   --notes       release notes, which the app shows in the "Updated to X" notice; without it, the
#                 version's section in desktop/CHANGELOG.md (docs/standards/code/versionamento.md).
#   --skip-gate   with --publish, waives only the eclume/gate = success status on the commit and
#                 leaves the eclume/gate-dispensa trail on it with the reason; a dry run needs no gate.
#   --unsigned    accepts publishing the Windows installer without code signing when the host lacks
#                 the configuration; without it, --publish refuses (a dry run only warns).
# Variables: ECLUME_SERVER_URL, ECLUME_SERVER_CA_SHA256 and ECLUME_DOWNLOADS_URL (default: the
# repository variables; without them, it refuses), ECLUME_DISK_LIMIT (90), ECLUME_SSH (when the
# context is not ssh://).
set -euo pipefail
# The `docker run` paths are the host's: Windows Git Bash must not rewrite them.
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
REPO=holetz/eclume
SECRETS=/srv/eclume/secrets
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
PLAN_ONLY=0
WINDOWS=1
PUBLISH=0
NOTES=""
SKIP_GATE=""
UNSIGNED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context needs the name of a Docker context." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --windows) WINDOWS=1; shift ;;
    --no-windows) WINDOWS=0; shift ;;
    --publish) PUBLISH=1; shift ;;
    --notes)
      [[ $# -ge 2 ]] || { echo "--notes needs a text." >&2; exit 2; }
      NOTES="$2"; shift 2 ;;
    --skip-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--skip-gate needs the reason." >&2; exit 2; }
      SKIP_GATE="$2"; shift 2 ;;
    --unsigned) UNSIGNED=1; shift ;;
    --help|-h) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[[ -n "$CONTEXT" ]] || { echo "Missing the host's Docker context: --context NAME or ECLUME_DOCKER_CONTEXT." >&2; exit 2; }
export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "Context $CONTEXT is not ssh:// ($endpoint); set ECLUME_SSH=user@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

# --- what ships -----------------------------------------------------------------------------------
VERSION="$(python3 -c "import json; print(json.load(open('desktop/src-tauri/tauri.conf.json'))['version'])")"
TAG="desktop-v$VERSION"
SHA="$(git rev-parse HEAD)"
[[ -n "$NOTES" ]] || NOTES="$(python3 deploy/version.py notes desktop "$VERSION")" \
  || { echo "Missing the [$VERSION] section in desktop/CHANGELOG.md: write it or pass --notes." >&2; exit 2; }
TARGETS=(linux)
[[ "$WINDOWS" -eq 0 ]] || TARGETS+=(windows)
SERVER_URL="${ECLUME_SERVER_URL:-$(gh variable get ECLUME_SERVER_URL -R "$REPO")}"
SERVER_CA="${ECLUME_SERVER_CA_SHA256:-$(gh variable get ECLUME_SERVER_CA_SHA256 -R "$REPO")}"
# As in the workflow: the environment variable or the repository's; without a default, the updater
# would point at another server's /downloads.
DOWNLOADS_URL="${ECLUME_DOWNLOADS_URL:-$(gh variable get ECLUME_DOWNLOADS_URL -R "$REPO" 2>/dev/null || true)}"
[[ -n "$DOWNLOADS_URL" ]] || { echo "Missing ECLUME_DOWNLOADS_URL (the /downloads of the server that publishes the desktop)." >&2; exit 2; }

# shellcheck disable=SC2016 # $HOME is the host's
BASE="$(host 'echo "$HOME"')/eclume-build/release"
SRC="$BASE/src"
DIST="$BASE/dist-$VERSION"
REGISTRY="$(dirname "$BASE")/cargo-registry"
# The build images carry the Rust version of desktop/rust-toolchain.toml in their tag.
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml)"
IMG_LINUX="eclume-desktop-build:$RUST"
IMG_WINDOWS="eclume-desktop-build-windows:$RUST"

# Preconditions of --publish: the release points at a commit GitHub has, made from a clean tree and
# proved by the gate (status eclume/gate), and never overwrites a tag.
problems=()
[[ -z "$(git status --porcelain)" ]] || problems+=("the working tree has changes; the release ships commit $SHA, without them")
gate_ok=0
if gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null; then
  gate_ok=1
  gate="$(gh api "repos/$REPO/commits/$SHA/status" | python3 deploy/gate.py decide)" || gate_ok=0
  [[ "$gate_ok" -eq 1 || -n "$SKIP_GATE" ]] \
    || problems+=("$gate (run bash deploy/gate.sh or waive with --skip-gate \"reason\")")
else
  problems+=("commit $SHA is not on GitHub (push it first)")
fi
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  problems+=("release $TAG already exists (bump the version in tauri.conf.json)")
fi

# Windows Authenticode signing: the vendor configuration lives only on the host.
SIGNING_DIR="$SECRETS/assinatura-windows"
SIGN=0
if [[ "$WINDOWS" -eq 1 ]] && host "test -s '$SIGNING_DIR/assinatura.env'"; then
  SIGN=1
fi
if [[ "$WINDOWS" -eq 0 ]]; then
  signing_state="out (no Windows)"
elif [[ "$SIGN" -eq 1 ]]; then
  signing_state="configured ($SIGNING_DIR)"
else
  signing_state="missing: the installer ships without code signing"
  [[ "$UNSIGNED" -eq 1 ]] \
    || problems+=("Windows installer without a signature (configure $SIGNING_DIR on the host or accept with --unsigned)")
fi

pct="$(host "df --output=pcent / | tail -n 1 | tr -dc 0-9")"

# --- plan -----------------------------------------------------------------------------------------
echo "Version $VERSION · tag $TAG · commit $SHA" >&2
echo "Targets: ${TARGETS[*]} · $([[ "$PUBLISH" -eq 1 ]] && echo "publishes the GitHub Release" || echo "dry run (publishes nothing)")" >&2
echo "Host: $SSH (context $CONTEXT) · code in $SRC · artifacts in $DIST" >&2
echo "Embedded server: $SERVER_URL · CA $SERVER_CA" >&2
echo "Windows code: Windows signing $signing_state" >&2
echo "Host disk: ${pct}% (limit ${DISK_LIMIT}%)" >&2
for p in "${problems[@]}"; do echo "  warning: $p" >&2; done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

if [[ "$PUBLISH" -eq 1 && "${#problems[@]}" -gt 0 ]]; then
  echo "Publishing refused: ${problems[*]}." >&2; exit 2
fi
if [[ "$PUBLISH" -eq 1 && "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="$(waiver="release $TAG: $SKIP_GATE"; echo "${waiver:0:140}")" --silent \
    || { echo "Could not publish the eclume/gate-dispensa trail; publishing refused." >&2; exit 2; }
  echo "Gate waived: $SKIP_GATE (eclume/gate-dispensa trail on the commit)." >&2
fi
(( pct < DISK_LIMIT )) || { echo "Host disk at ${pct}%: above ${DISK_LIMIT}%, release refused." >&2; exit 3; }
host "test -s $SECRETS/tauri-updater.key && test -s $SECRETS/tauri-updater.key.password" || {
  echo "Missing the updater key in $SECRETS on the host." >&2; exit 2; }

# The lock keeps its `.trava` name: a release from a pre-rename checkout takes the same lock.
host "mkdir -p '$BASE' '$REGISTRY' && mkdir '$BASE/.trava'" || {
  echo "Another release is running (or $BASE/.trava was left on the host)." >&2; exit 3; }
trap 'host "rmdir \"$BASE/.trava\""' EXIT

# --- code: the commit, not the working tree -------------------------------------------------------
echo "Sending the code of $SHA to the host…" >&2
# Without the workstation's line-ending conversion (core.autocrlf): the host gets the commit's bytes.
git -c core.autocrlf=false archive --format=tar "$SHA" | host "rm -rf '$SRC' && mkdir -p '$SRC' && tar -x -C '$SRC'"
host "rm -rf '$DIST' && mkdir -p '$DIST'"
# Only the 3 most recent versions stay in dist-*: the rest is old installers taking disk on the host.
host "cd '$BASE' && ls -dt dist-* 2>/dev/null | tail -n +4 | xargs -r rm -rf"

# --- build ----------------------------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain
# Memory ceiling of the build containers, next to the 2 CPUs: production shares the host.
MEMORY="${ECLUME_BUILD_MEMORY:-6g}"
echo "Image $IMG_LINUX…" >&2
docker build -q -t "$IMG_LINUX" -f desktop/build.Dockerfile desktop >/dev/null
if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Image $IMG_WINDOWS…" >&2
  docker build -q --build-arg "RUST=$RUST" -t "$IMG_WINDOWS" - < desktop/build-windows.Dockerfile >/dev/null
fi

# The Tauri CLI comes from desktop/package-lock.json, installed without scripts in a container
# without the updater key; the build then only runs it (npx --no-install).
echo "Tauri CLI (npm ci, without the key)…" >&2
docker run --rm --cpus 2 --cpu-shares 256 --memory "$MEMORY" -u 1000:1000 -e HOME=/tmp -v "$SRC:/src" -w /src/desktop "$IMG_LINUX" \
  nice -n 10 npm ci --ignore-scripts --no-audit --no-fund

# $1: image · $2: the target/ folder on the host · $3: extra folder mounted at /tmp/.cache (or empty)
# $4: "sign" to mount the Windows signing configuration (or empty) · $5: `tauri build` arguments
# (target, runner) · $6: `tauri bundle` arguments (packages, target).
# Two stages: compilation, where third-party build scripts run, sees no secret at all; bundling
# gets the updater key (read-only, turned into a variable inside the container) and, on signed
# Windows, /run/assinatura with Tauri's signCommand pointing at the signer.
build() {
  local img="$1" target="$2" cache="$3" sign="$4" build_args="$5" bundle_args="$6"
  host "mkdir -p '$target'"
  [[ -z "$cache" ]] || host "mkdir -p '$cache'"
  local common=(--rm --cpus 2 --cpu-shares 256 --memory "$MEMORY" -u 1000:1000
    -e HOME=/tmp -e CARGO_BUILD_JOBS=2 -e CARGO_TARGET_DIR=/target
    -e ECLUME_SERVER_URL="$SERVER_URL" -e ECLUME_SERVER_CA_SHA256="$SERVER_CA"
    -e APPIMAGE_EXTRACT_AND_RUN=1 -e NO_STRIP=true
    -v "$SRC:/src" -v "$target:/target" -v "$REGISTRY:/opt/cargo/registry"
    ${cache:+-v "$cache:/tmp/.cache"}
    -w /src/desktop/src-tauri)
  # shellcheck disable=SC2086 # the tauri arguments come space-separated
  docker run "${common[@]}" "$img" \
    nice -n 10 npx --no-install tauri build --ci --no-bundle $build_args
  local signing=() config=""
  if [[ "$sign" == sign ]]; then
    signing=(-v "$SIGNING_DIR:/run/assinatura:ro")
    config='{"bundle":{"windows":{"signCommand":"bash /src/desktop/scripts/assinar-windows.sh %1"}}}'
  fi
  docker run "${common[@]}" "${signing[@]}" \
    -v "$SECRETS/tauri-updater.key:/run/chave/key:ro" \
    -v "$SECRETS/tauri-updater.key.password:/run/chave/senha:ro" \
    -e ECLUME_TAURI_CONFIG="$config" "$img" \
    bash -c 'export TAURI_SIGNING_PRIVATE_KEY="$(cat /run/chave/key)"
             export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat /run/chave/senha)"
             extra=(); [[ -z "$ECLUME_TAURI_CONFIG" ]] || extra=(--config "$ECLUME_TAURI_CONFIG")
             exec nice -n 10 npx --no-install tauri bundle --ci "${extra[@]}" "$@"' tauri $bundle_args
}

echo "Building Linux (AppImage and deb)…" >&2
build "$IMG_LINUX" "$BASE/target-linux" "" "" "" "--bundles appimage,deb"
host "cd '$BASE/target-linux/release/bundle' && cp appimage/*_${VERSION}_*.AppImage* deb/*_${VERSION}_*.deb* '$DIST/'"

if [[ "$WINDOWS" -eq 1 ]]; then
  echo "Building Windows (NSIS, cross)…" >&2
  mode=""
  [[ "$SIGN" -eq 0 ]] || mode=sign
  build "$IMG_WINDOWS" "$BASE/target-windows" "$BASE/xwin-cache" "$mode" \
    "--runner cargo-xwin --target x86_64-pc-windows-msvc" \
    "--target x86_64-pc-windows-msvc --bundles nsis"
  NSIS="$BASE/target-windows/x86_64-pc-windows-msvc/release/bundle/nsis"
  if [[ "$SIGN" -eq 1 ]]; then
    # No installer ships with a broken signature or without a timestamp: the setup and the
    # executables inside it (extracted by 7z) go through the check, with no secret mounted.
    echo "Checking the Windows installer signature…" >&2
    docker run --rm --cpu-shares 256 -u 1000:1000 -e HOME=/tmp -v "$SRC:/src:ro" -v "$NSIS:/nsis:ro" "$IMG_WINDOWS" \
      bash -c 'set -euo pipefail
               signer=/src/desktop/scripts/assinar-windows.sh
               setup="$(ls /nsis/*_'"$VERSION"'_*-setup.exe)"
               bash "$signer" --verificar "$setup"
               dir="$(mktemp -d)"; 7z x -y -o"$dir" "$setup" >/dev/null
               for name in eclume-desktop.exe uninstall.exe; do
                 found="$(find "$dir" -iname "$name" -print -quit)"
                 [[ -n "$found" ]] || { echo "$name is not in the installer" >&2; exit 1; }
                 bash "$signer" --verificar "$found"
               done'
  else
    echo "Warning: Windows installer without code signing (no $SIGNING_DIR on the host)." >&2
  fi
  host "cp '$NSIS/'*_${VERSION}_*-setup.exe* '$DIST/'"
fi

# --- manifests and publication --------------------------------------------------------------------
host "cd '$DIST' && cp '$SRC/desktop/INSTALACAO.md' . \
  && python3 '$SRC/desktop/scripts/manifestos_release.py' --artefatos . --versao '$VERSION' \
       --base-url '$DOWNLOADS_URL' --notas $(printf '%q' "$NOTES") \
  && sha256sum -c --quiet SHA256SUMS && ls -la"

if [[ "$PUBLISH" -eq 0 ]]; then
  echo "Dry run ready at $SSH:$DIST (nothing published)." >&2
  exit 0
fi
host "cd '$DIST' && gh release create '$TAG' ./* --repo '$REPO' --target '$SHA' \
  --title 'eclume desktop $VERSION' \
  --notes 'Installers of the eclume desktop app $VERSION. Clients download from /downloads/ on the eclume server (deploy/publish-desktop.sh).'"
echo "Published $TAG. To serve it at /downloads:" >&2
echo "  ssh $SSH 'bash -s -- $TAG' < deploy/publish-desktop.sh" >&2
