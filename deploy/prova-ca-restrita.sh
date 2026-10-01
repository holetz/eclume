#!/usr/bin/env bash
# Prova da restrição de nome da raiz do eclume nos clientes da estação (holetz/eclume#101, 1.2).
# Gera uma raiz descartável de 127.0.0.1 (`eclume-server ca gerar --prova`), sobe dois
# `openssl s_server`: 127.0.0.1:18445 com um folha dentro da restrição e 127.0.0.2:18446 com um folha
# fora dela, e confere o `curl`. Com os servidores no ar, instale a raiz descartável no repositório do
# usuário e abra os dois endereços no Chrome, no Edge e no Firefox: o primeiro abre, o segundo é
# recusado. Enter derruba os servidores; depois remova a raiz descartável (comando impresso no fim).
# Anote o resultado em `## Discoveries` da spec. Runbook: docs/project/deploy-producao.md, "CA raiz".
set -euo pipefail
cd "$(dirname "$0")/.."

PASTA="${ECLUME_PROVA_CA:-$(mktemp -d)}"
DENTRO=127.0.0.1:18445
FORA=127.0.0.2:18446

uv run eclume-server ca gerar --prova "$PASTA"

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT
for par in "dentro $DENTRO" "fora $FORA"; do
  read -r nome endereco <<< "$par"
  openssl s_server -quiet -www -accept "$endereco" -cert "$PASTA/$nome.crt" -key "$PASTA/$nome.key" &
  pids+=("$!")
done
sleep 2

# `--ssl-no-revoke`: o curl do Windows (Schannel) tenta a revogação, que a raiz descartável não publica.
revogacao=()
curl --help all 2>/dev/null | grep -q -- --ssl-no-revoke && revogacao=(--ssl-no-revoke)
falhou=0
if curl -fsS -o /dev/null "${revogacao[@]}" --cacert "$PASTA/raiz.crt" "https://$DENTRO/"; then
  echo "curl: $DENTRO aceito (esperado)"
else
  echo "curl: $DENTRO RECUSADO — a raiz deveria valer dentro da restrição" >&2
  falhou=1
fi
if curl -fsS -o /dev/null "${revogacao[@]}" --cacert "$PASTA/raiz.crt" "https://$FORA/" 2>/dev/null; then
  echo "curl: $FORA ACEITO — a restrição de nome não foi aplicada" >&2
  falhou=1
else
  echo "curl: $FORA recusado (esperado)"
fi

cat <<EOF

Raiz descartável: $PASTA/raiz.crt
  Windows (Chrome, Edge): certutil -user -addstore Root "$(cygpath -w "$PASTA/raiz.crt" 2>/dev/null || echo "$PASTA/raiz.crt")"
  Firefox: Configurações > Privacidade > Certificados > Autoridades > Importar (confiar para sites).
Abra https://$DENTRO/ (deve abrir) e https://$FORA/ (deve ser recusado) em cada navegador.
Depois: certutil -user -delstore Root "eclume CA raiz" e remova a raiz do Firefox.
EOF
read -r -p "Enter derruba os servidores. " _
exit "$falhou"
