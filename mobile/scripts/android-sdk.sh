#!/usr/bin/env bash
# Ambiente Android do app móvel no host, sem sudo e idempotente.
#
# Instala em ~/ as command-line tools (SHA-256 conferido), um JDK 21 portátil (o OpenJDK do host
# só traz o runtime, sem `javac`), os pacotes do SDK e do NDK, os alvos `rustup` Android, o AVD
# `eclume-35` e o `~/.config/eclume/android-env.sh` que os comandos de build carregam. Uma segunda
# execução só confere e imprime "nada a fazer".
#
# Uso: ssh holetz@192.168.15.199 'bash -s' < mobile/scripts/android-sdk.sh
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/android-sdk}"
JDK="$HOME/jdk-21"
ENV_FILE="$HOME/.config/eclume/android-env.sh"
AVD="eclume-35"
# O limite de disco do deploy é 90 %; o SDK não pode levar o disco além de 88 %.
LIMITE_DISCO=88
# Espaço que uma instalação do zero ocupa, em GiB.
TAMANHO_GIB=10

# Command-line tools 22.0: a 23 troca o `sdkmanager` pelo `android sdk` e muda a saída do
# `--list_installed` (`ndk/28…` no lugar de `ndk;28…`); a 22 ainda é o `sdkmanager` de sempre.
CLT_ZIP="commandlinetools-linux-15859902_latest.zip"
CLT_SHA256="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"
CLT_REVISAO="22.0"
JDK_URL="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz"
JDK_SHA256="ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94"

PACOTES=(
  "platform-tools"
  "platforms;android-36"
  "build-tools;36.0.0"
  "ndk;28.2.13676358"
  "emulator"
  "system-images;android-35;google_apis;x86_64"
)
ALVOS=(aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android)

feito=0

baixar_conferido() { # url destino sha256
  curl -fsSL --retry 3 -o "$2" "$1"
  echo "$3  $2" | sha256sum -c --quiet -
}

checar_disco() {
  local total livre usado_pct
  read -r total livre < <(df -B1G --output=size,avail "$HOME" | tail -1)
  usado_pct=$(( (total - livre + TAMANHO_GIB) * 100 / total ))
  if (( usado_pct > LIMITE_DISCO )); then
    echo "recusado: a instalação levaria o disco a ${usado_pct}% (limite ${LIMITE_DISCO}%)." >&2
    echo "libere espaço (docker builder prune -af, ~/build/*/target do eclume) e rode de novo." >&2
    exit 1
  fi
}

if [[ ! -x "$JDK/bin/javac" ]]; then
  checar_disco
  tmp=$(mktemp -d)
  baixar_conferido "$JDK_URL" "$tmp/jdk.tar.gz" "$JDK_SHA256"
  mkdir -p "$JDK"
  tar -xzf "$tmp/jdk.tar.gz" -C "$JDK" --strip-components=1
  rm -rf "$tmp"
  echo "JDK 21 em $JDK"
  feito=1
fi
export JAVA_HOME="$JDK"

if ! grep -qxF "Pkg.Revision=$CLT_REVISAO" "$SDK/cmdline-tools/latest/source.properties" 2>/dev/null; then
  checar_disco
  tmp=$(mktemp -d)
  baixar_conferido "https://dl.google.com/android/repository/$CLT_ZIP" "$tmp/clt.zip" "$CLT_SHA256"
  mkdir -p "$SDK/cmdline-tools"
  unzip -q "$tmp/clt.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
  echo "command-line tools $CLT_REVISAO em $SDK/cmdline-tools/latest"
  feito=1
fi
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

# Um pacote `a;b;c` do SDK vive em `$SDK/a/b/c`: a pasta diz se ele já está instalado.
faltam=()
for pacote in "${PACOTES[@]}"; do
  [[ -d "$SDK/${pacote//;//}" ]] || faltam+=("$pacote")
done
if (( ${#faltam[@]} )); then
  checar_disco
  "$SDKMANAGER" --sdk_root="$SDK" "${faltam[@]}" | grep -v '^\[' || true
  for pacote in "${faltam[@]}"; do
    [[ -d "$SDK/${pacote//;//}" ]] || { echo "falhou a instalação de $pacote" >&2; exit 1; }
  done
  echo "pacotes instalados: ${faltam[*]}"
  feito=1
fi

RUSTUP="$HOME/.cargo/bin/rustup"
alvos_instalados=$("$RUSTUP" target list --installed)
for alvo in "${ALVOS[@]}"; do
  if ! grep -qxF "$alvo" <<<"$alvos_instalados"; then
    "$RUSTUP" target add "$alvo"
    feito=1
  fi
done

conteudo_env=$(cat <<EOF
# Gerado por mobile/scripts/android-sdk.sh — ambiente do build Android do eclume.
export JAVA_HOME="$JDK"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export NDK_HOME="$SDK/ndk/28.2.13676358"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$ANDROID_HOME/build-tools/36.0.0:\$HOME/.cargo/bin:\$PATH"
EOF
)
if [[ ! -f "$ENV_FILE" ]] || [[ "$(cat "$ENV_FILE")" != "$conteudo_env" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  printf '%s\n' "$conteudo_env" >"$ENV_FILE"
  echo "ambiente em $ENV_FILE"
  feito=1
fi

AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
if ! ANDROID_SDK_ROOT="$SDK" "$AVDMANAGER" list avd -c 2>/dev/null | grep -qxF "$AVD"; then
  echo no | ANDROID_SDK_ROOT="$SDK" "$AVDMANAGER" create avd -n "$AVD" \
    -k "system-images;android-35;google_apis;x86_64" -d pixel_6 >/dev/null
  cfg="$HOME/.android/avd/$AVD.avd/config.ini"
  sed -i 's/^hw.ramSize=.*/hw.ramSize=2048/' "$cfg"
  grep -q '^hw.ramSize=' "$cfg" || echo 'hw.ramSize=2048' >>"$cfg"
  echo "AVD $AVD criado"
  feito=1
fi

if [[ ! -w /dev/kvm ]]; then
  echo "aviso: /dev/kvm sem escrita para $(id -un); o emulador fica sem aceleração." >&2
fi

if (( feito == 0 )); then
  echo "nada a fazer: ambiente Android completo em $SDK"
fi
