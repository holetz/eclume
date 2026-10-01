#!/usr/bin/env bash
# Cria, uma única vez, a keystore de release do app móvel no host: RSA 4096, validade de 30 anos,
# alias `eclume`, em /srv/eclume/secrets/eclume-android.jks, com a senha aleatória em
# /srv/eclume/secrets/android-keystore-password (os dois 0600; o backup.sh os leva no snapshot restic
# cifrado de secrets/, local e fora do host, e um secret do GitHub não é cópia recuperável). Perder a
# keystore impede atualizar os apps já instalados: o Android só instala por cima um APK assinado
# pela mesma chave. Contrato: docs/standards/code/mobile-distribuicao.md.
#
# A keystore nunca sai do host: deploy/release-movel.sh a monta só leitura no contêiner do build.
# O `-dname` (o titular, decidido com a identidade do app na holetz/eclume#17) é obrigatório.
#
# Uso (da máquina de dev):
#   ssh holetz@192.168.15.199 'bash -s -- --dname "CN=eclume, O=<titular>, C=BR"' < mobile/scripts/criar-keystore.sh
# Depois: versionar o SHA-256 impresso em mobile/certificado-release.sha256 e confirmar a cópia
# cifrada da keystore e da senha fora do host (holetz/eclume#91).
set -euo pipefail

DNAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dname)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--dname exige o titular (CN=…, O=…, C=…)." >&2; exit 2; }
      DNAME="$2"; shift 2 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DNAME" ]] || { echo "Informe o titular: --dname \"CN=eclume, O=<titular>, C=BR\" (holetz/eclume#17)." >&2; exit 2; }

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
  -dname "$DNAME" >/dev/null
chmod 600 "$KEYSTORE" "$SENHA"

echo "keystore criada em $KEYSTORE (alias $ALIAS, titular $DNAME); senha em $SENHA."
sha=$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -storepass "$senha" -alias "$ALIAS" \
  | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | tr -d ':' | tr 'A-F' 'a-f')
cat <<INSTRUCOES

SHA-256 do certificado (público: sai no movel.json):
  $sha

1. Versione-o, da máquina de dev:  echo $sha > mobile/certificado-release.sha256
2. Confirme a cópia cifrada da keystore e da senha fora do host (holetz/eclume#91): perder a chave
   impede atualizar os apps instalados.
INSTRUCOES
