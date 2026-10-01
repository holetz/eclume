#!/usr/bin/env bash
# A prova do app móvel no emulador headless do host (KVM), contra a produção: sobe o AVD
# eclume-35, instala o APK de depuração x86_64 com as permissões concedidas, roda
# mobile/e2e/prova.mjs (Playwright `_android`) e, no fim, derruba o emulador. A limpeza das
# gravações e do token da prova é do prova.mjs. Contrato: docs/standards/code/mobile-app.md.
#
# Uso, da raiz do repositório no host (depois do build de depuração):
#   source ~/.config/eclume/android-env.sh
#   ECLUME_SMOKE_PASSWORD=... bash mobile/scripts/prova-emulador.sh
#   bash mobile/scripts/prova-emulador.sh --fumaca <apk>
#
# --fumaca: a fumaça do APK de release minificado (x86_64, do deploy/release-movel.sh), sem o
# WebView (o Playwright não abre o de um APK de release): instala, abre a Activity, espera o log do
# núcleo, força o job do SyncWorker e exige o log do sync, sem UnsatisfiedLinkError,
# ClassNotFoundException nem FATAL EXCEPTION no logcat. Exercita o R8 e a ponte JNI pelo caminho
# que não depende do WebView.
#
# O microfone do emulador entrega silêncio (QEMU_AUDIO_DRV=none): a prova confere duração,
# marcadores e o sync, não o conteúdo do áudio.
set -euo pipefail

AVD="${AVD:-eclume-35}"
PACOTE="io.github.holetz.eclume.movel"
URL="${ECLUME_URL:-https://192.168.15.199:8443}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${TMPDIR:-/tmp}/eclume-emulador.log"

fumaca=""
if [[ "${1:-}" == --fumaca ]]; then
  fumaca="${2:?--fumaca exige o APK de release x86_64}"
  apk="$fumaca"
  [[ -f "$apk" ]] || { echo "APK não encontrado: $apk" >&2; exit 1; }
else
  : "${ECLUME_SMOKE_PASSWORD:?informe ECLUME_SMOKE_PASSWORD}"
  apk=$(ls "$RAIZ"/mobile/src-tauri/gen/android/app/build/outputs/apk/*/debug/*.apk | head -n1)
  [[ -f "$apk" ]] || { echo "APK de depuração não encontrado; rode o tauri android build --debug" >&2; exit 1; }
fi

derrubar() {
  adb -s emulator-5554 emu kill >/dev/null 2>&1 || true
  sleep 2
  pkill -f "qemu-system-x86_64.*$AVD" >/dev/null 2>&1 || true
}
trap derrubar EXIT

if adb devices | grep -q '^emulator-5554'; then
  echo "já há um emulador em emulator-5554; derrubando antes" >&2
  derrubar
fi

echo "· subindo o emulador $AVD (log em $LOG)"
QEMU_AUDIO_DRV=none nohup emulator -avd "$AVD" -no-window -gpu swiftshader_indirect -no-snapshot \
  -no-boot-anim -accel on -memory 2048 >"$LOG" 2>&1 &
adb wait-for-device
timeout 300 bash -c 'until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d "\r")" == 1 ]]; do sleep 3; done'
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
echo "· emulador pronto: $(adb shell getprop ro.build.version.release | tr -d '\r') ($(adb shell getprop ro.product.model | tr -d '\r'))"

# Sempre do zero: o AVD guarda os dados do app entre as execuções.
adb uninstall "$PACOTE" >/dev/null 2>&1 || true
adb install -g "$apk" >/dev/null
adb shell pm grant "$PACOTE" android.permission.RECORD_AUDIO
adb shell pm grant "$PACOTE" android.permission.POST_NOTIFICATIONS
echo "· APK instalado: $(basename "$apk")"

# Espera uma linha no logcat por até $2 s.
esperar_log() {
  local padrao="$1" prazo="$2"
  timeout "$prazo" bash -c "until adb logcat -d | grep -q \"$padrao\"; do sleep 2; done"
}

if [[ -n "$fumaca" ]]; then
  adb logcat -c
  adb shell am start -W -n "$PACOTE/.MainActivity" >/dev/null
  esperar_log "dados do app em" 90 || { echo "o núcleo não abriu" >&2; adb logcat -d | tail -n 40 >&2; exit 1; }
  echo "· núcleo aberto pela Activity"
  # Os jobs do WorkManager do app: força cada um, sem esperar as restrições (Wi-Fi não medido).
  mapfile -t jobs < <(adb shell dumpsys jobscheduler | tr -d '\r' \
    | sed -n "s|^ *JOB #u[0-9a-z]*/\([0-9]*\): .*$PACOTE.*SystemJobService.*|\1|p" | sort -u)
  [[ "${#jobs[@]}" -gt 0 ]] || { echo "nenhum job do SyncWorker agendado" >&2; exit 1; }
  for job in "${jobs[@]}"; do adb shell cmd jobscheduler run -f "$PACOTE" "$job" >/dev/null; done
  esperar_log "sync em segundo plano:" 120 || { echo "o SyncWorker não rodou" >&2; adb logcat -d | tail -n 40 >&2; exit 1; }
  echo "· SyncWorker rodou pela ponte JNI: $(adb logcat -d | grep -m1 'sync em segundo plano:' | sed 's/.*sync em/sync em/')"
  if adb logcat -d | grep -E "UnsatisfiedLinkError|ClassNotFoundException|FATAL EXCEPTION" >&2; then
    echo "fumaça reprovada: erro do R8 ou da ponte JNI no logcat" >&2
    exit 1
  fi
  echo "fumaça ok: o APK minificado abre, e a ponte JNI responde"
  exit 0
fi

ca="${TMPDIR:-/tmp}/eclume-root.crt"
curl -fsSk "$URL/downloads/eclume-root.crt" -o "$ca"

cd "$RAIZ/mobile"
# O driver Android do Playwright (um APK de instrumentação), que toca na notificação.
npx playwright install android >/dev/null
ECLUME_URL="$URL" ECLUME_CA="$ca" node e2e/prova.mjs
