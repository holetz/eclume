#!/usr/bin/env bash
# Assinatura Authenticode dos executáveis Windows do eclume, no Linux, pelo `jsign` da imagem
# eclume-desktop-build-windows. O Tauri chama este script por `bundle.windows.signCommand` para
# cada executável do instalador (antes da assinatura minisign do updater), e o release o usa para
# conferir o instalador pronto. Contrato: docs/standards/code/desktop-distribuicao.md
# §Assinatura de código do Windows.
#
# Uso: assinar-windows.sh <arquivo>             assina (SHA-256, com carimbo RFC 3161) e confere
#      assinar-windows.sh --verificar <arquivo>  confere assinatura e carimbo
#      assinar-windows.sh --autoteste            assina e confere um stub do NSIS com um PKCS#12
#                                                autoassinado de teste
# Configuração: $ECLUME_ASSINATURA_DIR (padrão /run/assinatura, a pasta do host
# /srv/eclume/secrets/assinatura-windows/ montada só leitura) com `assinatura.env`:
#   JSIGN_STORETYPE   TRUSTEDSIGNING, AZUREKEYVAULT, GOOGLECLOUD, DIGICERTONE, PKCS11, PKCS12…
#   JSIGN_KEYSTORE    o keystore do tipo (arquivo relativo à pasta, endpoint ou configuração)
#   JSIGN_ALIAS       a chave ou o certificado no keystore (quando o tipo pede)
#   JSIGN_CERTFILE    a cadeia de certificados, quando o keystore não a traz (opcional)
#   JSIGN_TSAURL      a autoridade de carimbo de tempo (obrigatória)
# e a senha ou o token: o arquivo `storepass` da pasta, ou JSIGN_STOREPASS_CMD, um comando que
# imprime um token de curta duração. ECLUME_ASSINATURA_CAFILE troca o arquivo de ACs da conferência.
set -euo pipefail

CONF_DIR="${ECLUME_ASSINATURA_DIR:-/run/assinatura}"
SYSTEM_CAS=/etc/ssl/certs/ca-certificates.crt

falha() { echo "assinar-windows: $*" >&2; exit 1; }

# Um caminho relativo da configuração é relativo à pasta dela.
na_pasta() {
  local valor="$1"
  if [[ -n "$valor" && "$valor" != /* && -e "$CONF_DIR/$valor" ]]; then
    echo "$CONF_DIR/$valor"
  else
    echo "$valor"
  fi
}

verificar() {
  local arquivo="$1" cas="${ECLUME_ASSINATURA_CAFILE:-$SYSTEM_CAS}" saida
  [[ -f "$arquivo" ]] || falha "arquivo não encontrado: $arquivo"
  saida="$(osslsigncode verify -in "$arquivo" -CAfile "$cas" -TSA-CAfile "$SYSTEM_CAS" 2>&1)" \
    || { echo "$saida" >&2; falha "assinatura inválida ou ausente em $arquivo"; }
  grep -q "Timestamp Server Signature verification: ok" <<<"$saida" \
    || { echo "$saida" >&2; falha "assinatura sem carimbo de tempo em $arquivo"; }
  echo "assinatura ok: $(basename "$arquivo")" >&2
}

assinar() {
  local arquivo="$1" senha=""
  [[ -f "$arquivo" ]] || falha "arquivo não encontrado: $arquivo"
  [[ -f "$CONF_DIR/assinatura.env" ]] || falha "sem configuração em $CONF_DIR/assinatura.env"
  # shellcheck disable=SC1091 # a configuração é do host
  source "$CONF_DIR/assinatura.env"
  [[ -n "${JSIGN_STORETYPE:-}" ]] || falha "JSIGN_STORETYPE ausente"
  [[ -n "${JSIGN_TSAURL:-}" ]] || falha "JSIGN_TSAURL ausente: o carimbo de tempo é obrigatório"
  if [[ -n "${JSIGN_STOREPASS_CMD:-}" ]]; then
    senha="$(bash -c "$JSIGN_STOREPASS_CMD")" || falha "JSIGN_STOREPASS_CMD falhou"
  elif [[ -s "$CONF_DIR/storepass" ]]; then
    senha="$(<"$CONF_DIR/storepass")"
  fi
  local args=(--storetype "$JSIGN_STORETYPE" --alg SHA-256 --tsmode RFC3161
              --tsaurl "$JSIGN_TSAURL" --tsretries 3 --tsretrywait 5 --replace)
  [[ -z "${JSIGN_KEYSTORE:-}" ]] || args+=(--keystore "$(na_pasta "$JSIGN_KEYSTORE")")
  [[ -z "${JSIGN_ALIAS:-}" ]] || args+=(--alias "$JSIGN_ALIAS")
  [[ -z "${JSIGN_CERTFILE:-}" ]] || args+=(--certfile "$(na_pasta "$JSIGN_CERTFILE")")
  # A senha vai por arquivo temporário, fora da linha de comando (visível no `ps`).
  local arquivo_senha="" status=0
  if [[ -n "$senha" ]]; then
    arquivo_senha="$(mktemp)"
    printf '%s' "$senha" >"$arquivo_senha"
    args+=(--storepass "file:$arquivo_senha")
  fi
  jsign "${args[@]}" "$arquivo" >&2 || status=$?
  [[ -z "$arquivo_senha" ]] || rm -f "$arquivo_senha"
  [[ "$status" -eq 0 ]] || falha "o jsign não assinou $arquivo"
  verificar "$arquivo"
}

autoteste() {
  local dir stub
  dir="$(mktemp -d)"
  # shellcheck disable=SC2064 # a pasta é fixada agora
  trap "rm -rf '$dir'" EXIT
  stub="$(find /usr/share/nsis/Stubs -maxdepth 1 -type f -name 'zlib-x86-unicode' | head -n 1)"
  [[ -n "$stub" ]] || falha "stub do NSIS não encontrado"
  cp "$stub" "$dir/teste.exe"
  cp "$stub" "$dir/sem-assinatura.exe"
  openssl req -x509 -newkey rsa:3072 -nodes -days 2 -subj "/CN=eclume autoteste" \
    -addext "extendedKeyUsage=codeSigning" -keyout "$dir/chave.pem" -out "$dir/cert.pem" 2>/dev/null
  openssl pkcs12 -export -inkey "$dir/chave.pem" -in "$dir/cert.pem" -name eclume \
    -passout pass:autoteste -out "$dir/teste.p12"
  printf 'autoteste' >"$dir/storepass"
  cat >"$dir/assinatura.env" <<'ENV'
JSIGN_STORETYPE=PKCS12
JSIGN_KEYSTORE=teste.p12
JSIGN_ALIAS=eclume
JSIGN_TSAURL=http://timestamp.digicert.com
ENV
  CONF_DIR="$dir"
  export ECLUME_ASSINATURA_CAFILE="$dir/cert.pem"
  assinar "$dir/teste.exe"
  if (verificar "$dir/sem-assinatura.exe") 2>/dev/null; then
    falha "a conferência aceitou um executável sem assinatura"
  fi
  echo "autoteste ok: assina com carimbo, confere e recusa o que não tem assinatura" >&2
}

case "${1:-}" in
  --verificar) [[ $# -eq 2 ]] || falha "uso: --verificar <arquivo>"; verificar "$2" ;;
  --autoteste) autoteste ;;
  --help|-h|"") sed -n '2,23p' "$0" 2>/dev/null || true; [[ -n "${1:-}" ]] ;;
  -*) falha "opção desconhecida: $1" ;;
  *) assinar "$1" ;;
esac
