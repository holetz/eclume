#!/usr/bin/env bash
# The mobile app's proof on the host's headless emulator (KVM), against staging (`staging.sh up`,
# holetz/eclume#91; the proof writes and refuses the production URL): starts the AVD eclume-35,
# installs the x86_64 debug APK with the permissions granted, runs mobile/e2e/prove.mjs
# (Playwright `_android`) and, at the end, tears the emulator down. Cleaning up the proof's
# recordings and token is prove.mjs's job. Contract: docs/standards/code/mobile-app.md.
#
# Usage, from the repository root on the host (after the debug build):
#   source ~/.config/eclume/android-env.sh
#   staging.sh up               # account and CA in ~/eclume-staging/conta
#   bash mobile/scripts/prove-emulator.sh
#   bash mobile/scripts/prove-emulator.sh --smoke <apk>
#
# --smoke: the smoke test of the minified release APK (x86_64, from deploy/release-mobile.sh),
# without the WebView (Playwright does not open a release APK's): installs, opens the Activity,
# waits for the core's log, forces the SyncWorker job and requires the sync log, with no
# UnsatisfiedLinkError, ClassNotFoundException nor FATAL EXCEPTION in the logcat. Exercises R8 and
# the JNI bridge through the path that does not depend on the WebView.
#
# The emulator's microphone delivers silence (QEMU_AUDIO_DRV=none): the proof checks the duration,
# the markers and the sync, not the audio content.
set -euo pipefail

AVD="${AVD:-eclume-35}"
PACKAGE="io.github.holetz.eclume.movel"
ACCOUNT="${STAGING_DIR:-$HOME/eclume-staging}/conta"
if [[ -z "${ECLUME_SMOKE_PASSWORD:-}" && -r "$ACCOUNT" ]]; then
  ECLUME_SMOKE_PASSWORD="$(sed -n 's/^ECLUME_PASSWORD=//p' "$ACCOUNT")"
  ECLUME_SMOKE_EMAIL="${ECLUME_SMOKE_EMAIL:-$(sed -n 's/^ECLUME_EMAIL=//p' "$ACCOUNT")}"
  ECLUME_CA="${ECLUME_CA:-$(sed -n 's/^ECLUME_CA=//p' "$ACCOUNT")}"
  export ECLUME_SMOKE_PASSWORD ECLUME_SMOKE_EMAIL
fi
URL="${ECLUME_URL:-https://127.0.0.1:18444}"
for production in https://192.168.15.199:8443 "${ECLUME_PUBLIC_URL:-}"; do
  [[ -n "$production" && "${URL%/}" == "${production%/}" ]] || continue
  echo "$URL is production: the proof writes; use staging (staging.sh up)" >&2
  exit 2
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${TMPDIR:-/tmp}/eclume-emulador.log"

smoke=""
if [[ "${1:-}" == --smoke ]]; then
  smoke="${2:?--smoke requires the x86_64 release APK}"
  apk="$smoke"
  [[ -f "$apk" ]] || { echo "APK not found: $apk" >&2; exit 1; }
else
  : "${ECLUME_SMOKE_PASSWORD:?set ECLUME_SMOKE_PASSWORD (or run staging.sh up)}"
  apk=$(ls "$ROOT"/mobile/src-tauri/gen/android/app/build/outputs/apk/*/debug/*.apk | head -n1)
  [[ -f "$apk" ]] || { echo "debug APK not found; run tauri android build --debug" >&2; exit 1; }
fi

teardown() {
  adb -s emulator-5554 emu kill >/dev/null 2>&1 || true
  sleep 2
  pkill -f "qemu-system-x86_64.*$AVD" >/dev/null 2>&1 || true
}
trap teardown EXIT

if adb devices | grep -q '^emulator-5554'; then
  echo "an emulator is already on emulator-5554; tearing it down first" >&2
  teardown
fi

echo "· starting the emulator $AVD (log in $LOG)"
QEMU_AUDIO_DRV=none nohup emulator -avd "$AVD" -no-window -gpu swiftshader_indirect -no-snapshot \
  -no-boot-anim -accel on -memory 2048 >"$LOG" 2>&1 &
adb wait-for-device
timeout 300 bash -c 'until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d "\r")" == 1 ]]; do sleep 3; done'
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
echo "· emulator ready: $(adb shell getprop ro.build.version.release | tr -d '\r') ($(adb shell getprop ro.product.model | tr -d '\r'))"

# Always from scratch: the AVD keeps the app's data between runs.
adb uninstall "$PACKAGE" >/dev/null 2>&1 || true
adb install -g "$apk" >/dev/null
adb shell pm grant "$PACKAGE" android.permission.RECORD_AUDIO
adb shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS
echo "· APK installed: $(basename "$apk")"

# Waits up to $2 s for a line in the logcat.
wait_for_log() {
  local pattern="$1" deadline="$2"
  timeout "$deadline" bash -c "until adb logcat -d | grep -q \"$pattern\"; do sleep 2; done"
}

if [[ -n "$smoke" ]]; then
  adb logcat -c
  adb shell am start -W -n "$PACKAGE/.MainActivity" >/dev/null
  wait_for_log "app data in" 90 || { echo "the core did not open" >&2; adb logcat -d | tail -n 40 >&2; exit 1; }
  echo "· core opened by the Activity"
  # The app's WorkManager jobs: forces each one, without waiting for the constraints (unmetered Wi-Fi).
  mapfile -t jobs < <(adb shell dumpsys jobscheduler | tr -d '\r' \
    | sed -n "s|^ *JOB #u[0-9a-z]*/\([0-9]*\): .*$PACKAGE.*SystemJobService.*|\1|p" | sort -u)
  [[ "${#jobs[@]}" -gt 0 ]] || { echo "no SyncWorker job scheduled" >&2; exit 1; }
  for job in "${jobs[@]}"; do adb shell cmd jobscheduler run -f "$PACKAGE" "$job" >/dev/null; done
  wait_for_log "background sync:" 120 || { echo "the SyncWorker did not run" >&2; adb logcat -d | tail -n 40 >&2; exit 1; }
  echo "· SyncWorker ran through the JNI bridge: $(adb logcat -d | grep -m1 'background sync:' | sed 's/.*background sync/background sync/')"
  if adb logcat -d | grep -E "UnsatisfiedLinkError|ClassNotFoundException|FATAL EXCEPTION" >&2; then
    echo "smoke failed: an R8 or JNI bridge error in the logcat" >&2
    exit 1
  fi
  echo "smoke ok: the minified APK opens, and the JNI bridge answers"
  exit 0
fi

# The device's 127.0.0.1 is the host's: the app and the proof reach staging's Caddy.
port="${URL##*:}"
port="${port%%/*}"
adb reverse "tcp:$port" "tcp:$port" >/dev/null
ca="${ECLUME_CA:?set ECLUME_CA (the staging CA, in ~/eclume-staging/ca/ca.crt)}"

cd "$ROOT/mobile"
# Playwright's Android driver (an instrumentation APK), which taps the notification.
npx playwright install android >/dev/null
ECLUME_URL="$URL" ECLUME_CA="$ca" node e2e/prove.mjs
