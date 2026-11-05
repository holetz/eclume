#!/usr/bin/env bash
# Proof commands for each eclume pillar: the single source that CI (.github/workflows/ci.yml) and the
# host gate (deploy/gate-host.sh) call. The caller prepares the environment — actions, apt and
# services in CI; the eclume-gate image and the services of the eclume-gate project on the gate. This
# script starts nothing: the services and the mock arrive through ECLUME_TEST_* and ECLUME_MOCK_URL.
#
# Usage: bash deploy/pillars.sh <pillar>   runs the pillar's commands, stopping at the first failure
#        bash deploy/pillars.sh --list     lists the pillars, one per line
# Pillars: python contracts web web-browser desktop mobile docs windows audit android gpu-e2e (the
# last four only on the gate; gpu-e2e runs only on the host, through deploy/gpu-e2e.sh).
# Contract: docs/standards/code/monorepo.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PILLARS=(python contracts web web-browser desktop mobile docs windows audit android gpu-e2e)

# One foldable group per command in the CI log; on the gate, just a header.
run() {
  echo "::group::$*"
  "$@"
  echo "::endgroup::"
}

# The desktop link blows up (Bus error) with full debuginfo in CI; local dev keeps the full one.
# Cargo runs from inside the workspace folder: that is where rustup reads rust-toolchain.toml.
cargo_env() {
  export CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_PROFILE_TEST_DEBUG=line-tables-only
  cd "$ROOT/$1"
}

# The versioned list of expected skips for this environment: ECLUME_SKIPS (`ci`, `gate`, `gpu-e2e`),
# falling back to the deprecated ECLUME_PULOS, then `ci`.
skips_list() {
  echo "deploy/expected-skips-${ECLUME_SKIPS:-${ECLUME_PULOS:-ci}}.txt"
}

pillar_python() {
  run uv sync --all-packages --locked
  run uv run ruff check .
  run uv run ruff format --check .
  # The server suite fails, instead of skipping, when the services are not up.
  # The junit report feeds the skip check: only the skips on the versioned list pass (deploy/skips.py).
  local junit="${TMPDIR:-/tmp}/eclume-pytest-junit.xml"
  ECLUME_TEST_REQUIRE_SERVICES=1 run uv run pytest --junitxml="$junit"
  run python3 deploy/skips.py "$junit" "$(skips_list)"
}

pillar_contracts() {
  run uv sync --all-packages --locked
  run uv run python contracts/tools/bundle.py --check
  run uv run pytest contracts/tests
  run bash contracts/tests/smoke-mock.sh
}

pillar_web() {
  run npm --prefix web ci
  run npm --prefix web run gen:api -- --check
  run npm --prefix web run lint
  run npm --prefix web test
  run npm --prefix web run build
  # The initial JS fits under the ceiling in web/bundle-budget.json.
  run npm --prefix web run budget
}

# Playwright starts one browser per worker and defaults to half the CPUs it sees; a gate container
# sees every host CPU, so the gate passes the CPUs it reserved and both suites use that as --workers.
E2E_WORKERS=()
if [[ -n "${ECLUME_E2E_WORKERS:-}" ]]; then E2E_WORKERS=(--workers "$ECLUME_E2E_WORKERS"); fi

# Browser: media conversion and long transcription (vitest browser mode) and the E2E against the mock,
# in Google Chrome and, for the smoke and the browser tests, in Playwright's WebKit and Firefox. The
# engines' system dependencies come from the caller (CI setup, gate image).
pillar_web_browser() {
  export E2E_CHANNEL="${E2E_CHANNEL:-chrome}"
  run npm --prefix web ci
  run npm --prefix web exec -- playwright install webkit firefox
  run npm --prefix web run fixtures
  # One engine at a time: Chromium's commit measurement does not share the machine with the others.
  for engine in chromium firefox webkit; do
    run npm --prefix web run test:browser -- --project "$engine"
  done
  run npm --prefix web run test:e2e -- "${E2E_WORKERS[@]}"
}

pillar_desktop() {
  cargo_env desktop
  run cargo fmt --all --check
  run cargo check --workspace --locked
  run cargo clippy --workspace --locked -- -D warnings
  run cargo test --workspace --locked
  cd "$ROOT"
  # The window UI (desktop/ui) in a Chromium, with Tauri mocked. The browser's system dependencies
  # come from the caller (CI setup, gate image).
  run npm --prefix desktop/ui-tests ci
  run npm --prefix desktop/ui-tests exec -- playwright install chromium
  run npm --prefix desktop/ui-tests test -- "${E2E_WORKERS[@]}"
}

pillar_mobile() {
  run npm --prefix mobile ci
  run npm --prefix mobile run lint
  run npm --prefix mobile test
  run npm --prefix mobile run build
  cargo_env mobile
  run cargo fmt --all --check
  run cargo check --workspace --locked
  run cargo clippy --workspace --locked -- -D warnings
  run cargo test --workspace --locked
  # The core compiles for Android without gradle: proves the cross-compilation of libopus (cmake) and
  # SQLite with the caller's pinned NDK (ECLUME_ANDROID_NDK: sdkmanager's in CI, the host's on the gate).
  local ndk="${ECLUME_ANDROID_NDK:?ECLUME_ANDROID_NDK points at the pinned NDK}"
  local bin="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
  export ANDROID_NDK_HOME="$ndk" ANDROID_NDK_ROOT="$ndk"
  export CC_aarch64_linux_android="$bin/aarch64-linux-android26-clang"
  export AR_aarch64_linux_android="$bin/llvm-ar"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$bin/aarch64-linux-android26-clang"
  run cargo check -p eclume-mobile-core --target aarch64-linux-android --locked
}

# The documentation: OKF bundle conformance (`cq`, from holetz/quenching at the ref pinned in
# gate.Dockerfile and ci.yml) and links, anchors, backticked paths and glossary order.
pillar_docs() {
  run cq knowledge validate docs
  run python3 deploy/docs_check.py
  # The .design/build/ projections are versioned and match .design/tokens.json.
  run cq design build --check
}

# The desktop's Windows-only code, by cross-compilation (cargo-xwin). Only on the gate: in CI xwin
# would download the SDK on every run.
pillar_windows() {
  cargo_env desktop
  run cargo xwin clippy --workspace --all-targets --locked \
    --target x86_64-pc-windows-msvc -- -D warnings
}

# Known vulnerabilities in the production dependencies: pip-audit over uv.lock with every extra
# (`gpu` is what the GPU worker image installs: whisperx, torch, transformers), npm audit (high or
# critical) in the projects that ship to users and cargo-deny (advisories) in the Rust workspaces.
# An exception only with a reason and a deadline: deploy/audit-exceptions.txt (Python), `overrides`
# in package.json (npm) and the [advisories] ignore of desktop/deny.toml and mobile/deny.toml (Rust).
# Only on the gate: it needs the network and the eclume-gate image's tools.
pillar_audit() {
  local req ignore=() id deadline
  req="$(mktemp)"
  run uv export --locked --all-packages --all-extras --no-hashes --no-emit-workspace --format requirements-txt -o "$req"
  # Exception line: <id> <deadline YYYY-MM-DD> <reason>; once expired it stops counting and the pillar fails.
  while read -r id deadline _; do
    [[ -z "$id" || "$id" == \#* ]] && continue
    if [[ "$deadline" > "$(date +%F)" ]]; then ignore+=(--ignore-vuln "$id"); fi
  done < deploy/audit-exceptions.txt
  run pip-audit --no-deps --disable-pip -r "$req" "${ignore[@]}"
  rm -f "$req"
  for project in web mobile desktop; do
    run npm --prefix "$project" audit --omit=dev --audit-level=high
  done
  for ws in desktop mobile; do
    (cd "$ROOT/$ws" && run cargo deny --locked check advisories)
  done
}

# The :tauri-android source (tauri-<version>/mobile/android) lives in the cargo registry, shared and
# persistent. Each Android plugin's build.rs copies it file by file; if Gradle writes a build/ there
# mid-copy, the listed file vanishes and the pillar falls over (intermittent failure). The app's
# Gradle writes the :tauri-android build/ outside the registry (mobile/src-tauri/gen/android/build.gradle.kts);
# here the build/ that old runs left behind is deleted and nothing coming back is checked.
tauri_android_builds() {
  local base="${CARGO_HOME:-/opt/cargo}/registry/src"
  [[ -d "$base" ]] || return 0
  find "$base" -mindepth 5 -maxdepth 5 -path '*/tauri-[0-9]*/mobile/android/build' -type d -print0
}

# The paths come out NUL-separated and are read that way: a name with an LF cannot split the path and
# take the rm -rf outside the target. `wait $!` brings back find's status, which process substitution
# loses: without it, an unreadable registry would pass as clean.
tauri_android_clean_builds() {
  local stale
  while IFS= read -r -d '' stale; do rm -rf -- "$stale"; done < <(tauri_android_builds)
  wait $! || return 1
}

# Fails (and names what came back) if any build/ reappeared in the registry.
tauri_android_intruders() {
  local intruder found=()
  while IFS= read -r -d '' intruder; do found+=("$intruder"); done < <(tauri_android_builds)
  wait $! || return 1
  ((${#found[@]} == 0)) || { echo "Gradle wrote into the cargo registry: ${found[*]}" >&2; return 1; }
}

# The phone's release APK, verified: minified (R8) and signed with a throwaway key from this run,
# with the unit tests and lint of the plugin and the app, the JNI bridge symbols in the .so and the
# EclumeCore class in the dex (mobile/scripts/jni_symbols.py). Only on the gate: the SDK, NDK and
# JDK come from the host read-only (ECLUME_ANDROID_SDK, ECLUME_ANDROID_NDK, ECLUME_ANDROID_JDK), and
# the build takes about 15 min.
pillar_android() {
  local sdk="${ECLUME_ANDROID_SDK:?ECLUME_ANDROID_SDK points at the pinned SDK}"
  local ndk="${ECLUME_ANDROID_NDK:?ECLUME_ANDROID_NDK points at the pinned NDK}"
  local jdk="${ECLUME_ANDROID_JDK:?ECLUME_ANDROID_JDK points at the JDK}"
  export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" JAVA_HOME="$jdk"
  export NDK_HOME="$ndk" ANDROID_NDK_HOME="$ndk" ANDROID_NDK_ROOT="$ndk"
  export PATH="$jdk/bin:$PATH" GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
  local gradle="$ROOT/mobile/src-tauri/gen/android"
  run npm --prefix mobile ci
  # One key per run, outside the repository: the release APK comes out signed and minified like the
  # real one, without the host's keystore.
  local keys
  keys="$(mktemp -d)"
  keytool -genkeypair -noprompt -keystore "$keys/gate.jks" -alias gate -keyalg RSA -keysize 2048 \
    -validity 2 -storepass gate-throwaway -keypass gate-throwaway -dname "CN=eclume gate"
  printf 'storeFile=%s\npassword=gate-throwaway\nkeyAlias=gate\n' "$keys/gate.jks" \
    > "$gradle/keystore.properties"
  tauri_android_clean_builds
  run npm --prefix mobile run tauri -- android build --apk --target aarch64 --ci
  # The Gradle that tauri leaves running is a second ~2 GiB JVM next to the --no-daemon below, and the
  # two together blow the container's memory ceiling (holetz/eclume#188).
  (cd "$gradle" && run ./gradlew --stop)
  tauri_android_intruders
  (cd "$gradle" && run ./gradlew --no-daemon :tauri-plugin-eclume-gravador:testDebugUnitTest \
    :tauri-plugin-eclume-gravador:lintRelease :app:lintUniversalRelease)
  local apk
  apk="$(find "$gradle/app/build/outputs/apk" -path '*release*' -name '*.apk' | head -n 1)"
  [[ -n "$apk" ]] || { echo "release APK not found" >&2; return 1; }
  python3 - "$apk" "$keys/lib.so" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as apk, open(sys.argv[2], "wb") as so:
    so.write(apk.read("lib/arm64-v8a/libeclume_mobile_lib.so"))
PY
  "$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm" -D --defined-only "$keys/lib.so" > "$keys/nm.txt"
  "$sdk/cmdline-tools/latest/bin/apkanalyzer" dex packages "$apk" > "$keys/dex.txt"
  run python3 mobile/scripts/jni_symbols.py --nm "$keys/nm.txt" --dex "$keys/dex.txt" \
    --kotlin mobile/plugins/gravador/android/src/main/java/io/github/holetz/eclume/movel/gravador/EclumeCore.kt
  rm -rf "$keys" "$gradle/keystore.properties"
}

# The CUDA proof needs the host's docker and GPU, which the other pillars' container lacks:
# gate-host.sh handles it separately; here it only delegates to the script, and fails clearly off the host.
pillar_gpu_e2e() {
  command -v docker >/dev/null 2>&1 \
    || { echo "gpu-e2e runs only on the GPU host (bash deploy/gate.sh --pillars gpu-e2e)." >&2; return 1; }
  bash deploy/gpu-e2e.sh
}

case "${1:-}" in
  --list) printf '%s\n' "${PILLARS[@]}" ;;
  python|contracts|web|web-browser|desktop|mobile|docs|windows|audit|android|gpu-e2e) "pillar_${1//-/_}" ;;
  *) echo "Usage: bash deploy/pillars.sh <$(IFS='|'; echo "${PILLARS[*]}")> | --list" >&2; exit 2 ;;
esac
