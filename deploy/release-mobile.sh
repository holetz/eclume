#!/usr/bin/env bash
# Release of the mobile app on the GPU host, without GitHub Actions (mirror of deploy/release-desktop.sh):
# compiles the release APK on the host daemon (Docker context) in a CPU-limited container, signs it
# with the keystore that exists only on the host (mounted read-only in the container), checks the
# certificate against mobile/certificado-release.sha256, assembles movel.json and SHA256SUMS, runs the
# smoke test of the minified APK on the host emulator and, with --publish, creates the
# mobile-v<version> GitHub Release through the host's gh. Then deploy/publish-mobile.sh takes the
# release to /downloads/movel.
# Contract: docs/standards/code/mobile-distribuicao.md.
#
# Usage: bash deploy/release-mobile.sh [--plan] [--context NAME] [--publish] [--notes "text"]
#                                      [--skip-gate "reason"] [--no-smoke]
#   --plan       only shows what it would do (read-only).
#   --context    the host's Docker context (or $ECLUME_DOCKER_CONTEXT); required, no default.
#   --publish    creates the tag and the GitHub Release; without it, it is a dry run and the
#                artifacts stay on the host.
#   --notes      release notes, which the app and /app-movel show; without it, the version's section
#                in mobile/CHANGELOG.md (docs/standards/code/versionamento.md).
#   --skip-gate  with --publish, waives only the eclume/gate = success status on the commit and
#                leaves the eclume/gate-dispensa trail on it with the reason; a dry run needs no gate.
#   --no-smoke   skips the emulator smoke test (dry run only; --publish always runs it).
# Variables: ECLUME_DISK_LIMIT (90), ECLUME_SSH (when the context is not ssh://).
set -euo pipefail
# The `docker run` paths are the host's: Windows Git Bash must not rewrite them.
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-}"
REPO=holetz/eclume
SECRETS=/srv/eclume/secrets
KEYSTORE="$SECRETS/eclume-android.jks"
PASSWORD="$SECRETS/android-keystore-password"
ALIAS=eclume
EXPECTED_CERT=mobile/certificado-release.sha256
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
PLAN_ONLY=0
PUBLISH=0
NOTES=""
SKIP_GATE=""
SMOKE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context needs the name of a Docker context." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --publish) PUBLISH=1; shift ;;
    --notes)
      [[ $# -ge 2 ]] || { echo "--notes needs a text." >&2; exit 2; }
      NOTES="$2"; shift 2 ;;
    --skip-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--skip-gate needs the reason." >&2; exit 2; }
      SKIP_GATE="$2"; shift 2 ;;
    --no-smoke) SMOKE=0; shift ;;
    --help|-h) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$PUBLISH" -eq 0 || "$SMOKE" -eq 1 ]] || { echo "--publish always runs the smoke test." >&2; exit 2; }
[[ -n "$CONTEXT" ]] || { echo "Missing the host's Docker context: --context NAME or ECLUME_DOCKER_CONTEXT." >&2; exit 2; }

export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "Context $CONTEXT is not ssh:// ($endpoint); set ECLUME_SSH=user@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

# --- what ships -----------------------------------------------------------------------------------
VERSION="$(python3 -c "import json; print(json.load(open('mobile/src-tauri/tauri.conf.json'))['version'])")"
TAG="mobile-v$VERSION"
SHA="$(git rev-parse HEAD)"
[[ -n "$NOTES" ]] || NOTES="$(python3 deploy/version.py notes mobile "$VERSION")" \
  || { echo "Missing the [$VERSION] section in mobile/CHANGELOG.md: write it or pass --notes." >&2; exit 2; }

# shellcheck disable=SC2016 # $HOME is the host's
HOST_HOME="$(host 'echo "$HOME"')"
# The host build folder keeps its `movel` name (host data, unchanged by the rename).
BASE="$HOST_HOME/eclume-build/movel"
SRC="$BASE/src"
DIST="$BASE/dist-$VERSION"
SMOKE_APK="$BASE/fumaca-$VERSION.apk"
REGISTRY="$HOST_HOME/eclume-build/cargo-registry"
GRADLE="$BASE/gradle"
# The SDK, NDK and JDK of mobile/scripts/android-sdk.sh, read-only in the container.
SDK="$HOST_HOME/android-sdk"
NDK="$SDK/ndk/28.2.13676358"
JDK="$HOST_HOME/jdk-21"
# The images carry the Rust version of mobile/rust-toolchain.toml in their tag (the same as desktop's).
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' mobile/rust-toolchain.toml)"
IMG_BASE="eclume-desktop-build:$RUST"
IMG="eclume-mobile-build:$RUST"

# Preconditions of --publish: the release points at a commit GitHub has, made from a clean tree and
# proved by the gate (status eclume/gate), never overwrites a tag, and the keystore certificate is
# the versioned one.
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
expected=""
if [[ -s "$EXPECTED_CERT" ]]; then
  expected="$(tr -d ' :\n' < "$EXPECTED_CERT" | tr 'A-F' 'a-f')"
else
  problems+=("missing $EXPECTED_CERT (the SHA-256 of the keystore certificate, printed by mobile/scripts/create-keystore.sh)")
fi
host "test -s '$KEYSTORE' && test -s '$PASSWORD'" || problems+=("missing the release keystore in $SECRETS on the host")

pct="$(host "df --output=pcent / | tail -n 1 | tr -dc 0-9")"

# --- plan -----------------------------------------------------------------------------------------
echo "Version $VERSION · tag $TAG · commit $SHA" >&2
echo "Ships: universal APK (aarch64, armv7) and an x86_64 one only for the smoke test · $([[ "$PUBLISH" -eq 1 ]] && echo "publishes the GitHub Release" || echo "dry run (publishes nothing)")" >&2
echo "Host: $SSH (context $CONTEXT) · code in $SRC · artifacts in $DIST" >&2
echo "Expected certificate: ${expected:-missing} · smoke test: $([[ "$SMOKE" -eq 1 ]] && echo yes || echo no)" >&2
echo "Host disk: ${pct}% (limit ${DISK_LIMIT}%)" >&2
for p in "${problems[@]}"; do echo "  warning: $p" >&2; done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

if [[ "$PUBLISH" -eq 1 && "${#problems[@]}" -gt 0 ]]; then
  echo "Publishing refused: ${problems[*]}." >&2; exit 2
fi
[[ -n "$expected" ]] || { echo "Without $EXPECTED_CERT, not even the dry run checks the signature." >&2; exit 2; }
(( pct < DISK_LIMIT )) || { echo "Host disk at ${pct}%: above ${DISK_LIMIT}%, release refused." >&2; exit 3; }
host "test -s '$KEYSTORE' && test -s '$PASSWORD'" || { echo "Missing the release keystore in $SECRETS on the host." >&2; exit 2; }
if [[ "$PUBLISH" -eq 1 && "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="$(waiver="release $TAG: $SKIP_GATE"; echo "${waiver:0:140}")" --silent \
    || { echo "Could not publish the eclume/gate-dispensa trail; publishing refused." >&2; exit 2; }
  echo "Gate waived: $SKIP_GATE (eclume/gate-dispensa trail on the commit)." >&2
fi

# The lock keeps its `.trava` name: a release from a pre-rename checkout takes the same lock.
host "mkdir -p '$BASE' '$REGISTRY' '$GRADLE' && mkdir '$BASE/.trava'" || {
  echo "Another phone release is running (or $BASE/.trava was left on the host)." >&2; exit 3; }
trap 'host "rmdir \"$BASE/.trava\""' EXIT

# --- code: the commit, not the working tree -------------------------------------------------------
echo "Sending the code of $SHA to the host…" >&2
git -c core.autocrlf=false archive --format=tar "$SHA" | host "rm -rf '$SRC' && mkdir -p '$SRC' && tar -x -C '$SRC'"
host "rm -rf '$DIST' && mkdir -p '$DIST'"
# Only the 3 most recent versions stay in dist-*: the rest is old installers taking disk on the host.
host "cd '$BASE' && ls -dt dist-* 2>/dev/null | tail -n +4 | xargs -r rm -rf"

# --- build ----------------------------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain
echo "Images $IMG_BASE and $IMG…" >&2
docker build -q -t "$IMG_BASE" -f desktop/build.Dockerfile desktop >/dev/null
docker build -q --build-arg "RUST=$RUST" -t "$IMG" - < mobile/build.Dockerfile >/dev/null

# Common container: limited CPU, uid 1000, the SDK, NDK and JDK read-only, caches on the host.
common=(--rm --cpus 2 --cpu-shares 256 -u 1000:1000 -e HOME=/tmp -e CARGO_BUILD_JOBS=2
  -e ANDROID_HOME=/opt/android-sdk -e ANDROID_SDK_ROOT=/opt/android-sdk -e JAVA_HOME=/opt/jdk
  -e NDK_HOME=/opt/ndk -e ANDROID_NDK_HOME=/opt/ndk -e ANDROID_NDK_ROOT=/opt/ndk
  -e GRADLE_USER_HOME=/opt/gradle
  -v "$SRC:/src" -v "$REGISTRY:/opt/cargo/registry" -v "$GRADLE:/opt/gradle"
  -v "$SDK:/opt/android-sdk:ro" -v "$NDK:/opt/ndk:ro" -v "$JDK:/opt/jdk:ro")

echo "Tauri CLI (npm ci, without the keystore)…" >&2
docker run "${common[@]}" -w /src/mobile "$IMG" nice -n 10 npm ci --ignore-scripts --no-audit --no-fund

# The keystore and password come in read-only and become keystore.properties inside the container
# (outside git, deleted at the end). $1…: the `tauri android build` targets.
build() {
  docker run "${common[@]}" \
    -v "$KEYSTORE:/run/chave/keystore.jks:ro" -v "$PASSWORD:/run/chave/senha:ro" \
    -w /src/mobile "$IMG" \
    bash -c 'props=src-tauri/gen/android/keystore.properties
             trap "rm -f $props" EXIT
             printf "storeFile=/run/chave/keystore.jks\npassword=%s\nkeyAlias='"$ALIAS"'\n" "$(cat /run/chave/senha)" > "$props"
             targets=(); for a in "$@"; do targets+=(--target "$a"); done
             nice -n 10 npx --no-install tauri android build --apk "${targets[@]}" --ci' tauri "$@"
}

APKS="$SRC/mobile/src-tauri/gen/android/app/build/outputs/apk"
echo "Building the universal APK (aarch64, armv7)…" >&2
build aarch64 armv7
host "cp '$APKS/universal/release/app-universal-release.apk' '$DIST/eclume-$VERSION.apk'"
echo "Building the x86_64 smoke-test APK (same key)…" >&2
build x86_64
host "cp \"\$(find '$APKS' -path '*release*' -name '*.apk' -newer '$DIST/eclume-$VERSION.apk' | head -n 1)\" '$SMOKE_APK'"

# --- signature and manifests ----------------------------------------------------------------------
certificate="$(docker run "${common[@]}" -v "$DIST:/dist:ro" "$IMG" \
  bash -c 'apksigner=$(ls /opt/android-sdk/build-tools/*/apksigner | sort -V | tail -n1)
           "$apksigner" verify --print-certs /dist/eclume-'"$VERSION"'.apk' \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d ' :' | tr 'A-F' 'a-f')"
if [[ "$certificate" != "$expected" ]]; then
  echo "The APK came out with certificate ${certificate:-missing}, not the versioned one ($expected): release refused." >&2
  exit 2
fi
echo "Signature checked: certificate $certificate." >&2
host "cd '$DIST' && cp '$SRC/mobile/INSTALACAO.md' . \
  && python3 '$SRC/mobile/scripts/mobile_manifest.py' --dir . --version '$VERSION' \
       --certificate '$certificate' --notes $(printf '%q' "$NOTES") \
  && sha256sum -c --quiet SHA256SUMS && ls -la"

# --- smoke test of the minified APK on the emulator ------------------------------------------------
if [[ "$SMOKE" -eq 1 ]]; then
  echo "Smoke test of the release APK on the emulator…" >&2
  host "source ~/.config/eclume/android-env.sh && bash '$SRC/mobile/scripts/prove-emulator.sh' --smoke '$SMOKE_APK'"
fi

if [[ "$PUBLISH" -eq 0 ]]; then
  echo "Dry run ready at $SSH:$DIST (nothing published)." >&2
  exit 0
fi
host "cd '$DIST' && gh release create '$TAG' ./* --repo '$REPO' --target '$SHA' \
  --title 'eclume for Android $VERSION' \
  --notes 'APK of the eclume mobile app $VERSION. Phones download from /downloads/movel/ on the eclume server (deploy/publish-mobile.sh).'"
echo "Published $TAG. To serve it at /downloads/movel:" >&2
echo "  ssh $SSH 'bash -s -- $TAG' < deploy/publish-mobile.sh" >&2
