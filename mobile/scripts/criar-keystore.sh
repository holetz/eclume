#!/usr/bin/env bash
# Cria, uma única vez, a keystore de release do app móvel no host: RSA 4096, validade de 30 anos,
# alias `eclume`, em /srv/eclume/secrets/eclume-android.jks, com a senha aleatória em
# /srv/eclume/secrets/android-keystore-password (os dois 0600, no backup do deploy). Perder a
# keystore impede atualizar os apps já instalados: o Android só instala por cima um APK assinado
# pela mesma chave. Contrato: docs/standards/code/mobile-distribuicao.md.
#
# Uso (da máquina de dev): ssh holetz@192.168.15.199 'bash -s' < mobile/scripts/criar-keystore.sh
# Depois, a dona do repositório grava os secrets do GitHub com o que o script imprime.
set -euo pipefail

SEGREDOS="${SEGREDOS:-/srv/eclume/secrets}"
KEYSTORE="$SEGREDOS/eclume-android.jks"
SENHA="$SEGREDOS/android-keystore-password"
ALIAS="${ALIAS:-eclume}"
KEYTOOL="${KEYTOOL:-$(command -v keytool || echo "$HOME/jdk-21/bin/keytool")}"

if [[ -e "$KEYSTORE" ]]; then
  echo "a keystore já existe em $KEYSTORE; não recrio (perder a chave impede atualizar o app)." >&2
  exit 1
fi
[[ -x "$KEYTOOL" ]] || { echo "keytool não encontrado; rode mobile/scripts/android-sdk.sh" >&2; exit 1; }

umask 077
mkdir -p "$SEGREDOS"
senha=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
printf '%s' "$senha" >"$SENHA"
"$KEYTOOL" -genkeypair -v -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass "$senha" -keypass "$senha" \
  -dname "CN=eclume, O=Jane Doe, C=BR" >/dev/null
chmod 600 "$KEYSTORE" "$SENHA"

echo "keystore criada em $KEYSTORE (alias $ALIAS); senha em $SENHA."
"$KEYTOOL" -list -v -keystore "$KEYSTORE" -storepass "$senha" -alias "$ALIAS" | grep -E 'SHA256:' || true
cat <<INSTRUCOES

Grave os secrets do repositório (a dona do repositório confirma), da máquina de dev:
  ssh holetz@192.168.15.199 'base64 -w0 $KEYSTORE' | gh secret set ANDROID_KEYSTORE_B64 -R holetz/eclume
  ssh holetz@192.168.15.199 'cat $SENHA' | gh secret set ANDROID_KEYSTORE_PASSWORD -R holetz/eclume
  gh secret set ANDROID_KEY_ALIAS -R holetz/eclume --body $ALIAS
INSTRUCOES
