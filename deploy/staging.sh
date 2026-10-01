#!/usr/bin/env bash
# Staging efêmero do eclume (projeto `eclume-staging`, deploy/docker-compose.staging.yml), rodado NO
# HOST (<ECLUME_DATA_DIR>/bin/, instalado pelo deploy.sh; o cron `# eclume-ensaio` roda o ensaio):
#
#   staging.sh ensaio     restaura o backup do repositório FORA do host no staging, aplica o migrate
#                         do `main`, roda o smoke_prod.py e as conferências, grava estado/ensaio.json
#                         e sai sempre com `down -v`
#   staging.sh subir      o mesmo stack restaurado, de pé em https://127.0.0.1:18444 para as provas
#                         (conta descartável em ~/eclume-staging/conta, CA em ~/eclume-staging/ca/ca.crt)
#   staging.sh derrubar   `down -v` do stack e das imagens :staging
#
# O código é o tarball do `main` (gh api, o `gh` autenticado dos releases); ECLUME_STAGING_SRC
# aponta outra árvore. Conferências do ensaio: sha256 de secrets/ e da PKI contra
# estado/secrets.sha256, impressão digital da raiz restaurada contra downloads/eclume-root.crt,
# content_hash de um lote de áudios restaurados e `restic check --read-data-subset` de 1/7 rotativo
# do repositório fora. Recusa com o disco em 90% ou mais. Nada toca o projeto `eclume`.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
SECRETS="$DATA_DIR/secrets"
ESTADO="$DATA_DIR/estado"
STAGING_DIR="${STAGING_DIR:-$HOME/eclume-staging}"
REST="$STAGING_DIR/restaurado"
# A CA do Caddy do staging, também montada no server (o /api/v1/server dá a impressão digital ao app).
CA="$STAGING_DIR/ca/ca.crt"
URL=https://127.0.0.1:18444
EMAIL=staging@eclume.invalid
LOTE="${ECLUME_STAGING_LOTE:-20}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"

case "${1:-}" in
  ensaio|subir|derrubar) acao="$1" ;;
  --help|-h) sed -n '2,17p' "$0"; exit 0 ;;
  *) sed -n '2,17p' "$0" >&2; exit 2 ;;
esac

log() { echo "$(date '+%F %T') $*"; }
estado() {
  local detalhe="${3//\\/\\\\}"
  detalhe="${detalhe//\"/\\\"}"
  mkdir -p "$ESTADO"
  printf '{"ok": %s, "at": "%s", "detalhe": "%s"}\n' "$2" "$(date -Iseconds)" "$detalhe" > "$ESTADO/.$1.json.tmp"
  mv -f "$ESTADO/.$1.json.tmp" "$ESTADO/$1.json"
}
compose() { docker compose -p eclume-staging -f "$SRC/deploy/docker-compose.staging.yml" "$@"; }
fora() {
  docker run --rm --env-file "$SECRETS/restic-fora.env" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
derrubar() {
  [[ ! -f "$SRC/deploy/docker-compose.staging.yml" ]] || compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm eclume-server:staging eclume-web:staging >/dev/null 2>&1 || true
  rm -rf "$REST"
}

SRC="${ECLUME_STAGING_SRC:-$STAGING_DIR/main}"
if [[ "$acao" == derrubar ]]; then
  derrubar
  rm -rf "$STAGING_DIR"
  log "eclume-staging derrubado"
  exit 0
fi

passo="início"
fim() {
  local status=$?
  rm -rf "$REST"
  if [[ "$acao" == ensaio || "$status" -ne 0 ]]; then derrubar; fi
  if [[ "$acao" == ensaio ]]; then
    if [[ "$status" -eq 0 ]]; then
      estado ensaio true "$resumo"
    else
      log "ERRO no ensaio: $passo (saída $status)"
      estado ensaio false "falhou em: $passo"
    fi
  fi
}
trap fim EXIT
install -d -m 700 "$STAGING_DIR"

passo="disco"
pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
(( pct < 90 )) || { passo="disco em ${pct}%: acima de 90%, staging recusado"; exit 3; }
passo="sem $SECRETS/restic-fora.env: o ensaio lê o repositório fora do host"
[[ -s "$SECRETS/restic-fora.env" && -s "$SECRETS/restic-password" ]] || exit 1

passo="código do main"
if [[ -z "${ECLUME_STAGING_SRC:-}" ]]; then
  log "código: tarball do main"
  rm -rf "$SRC" && mkdir -p "$SRC"
  gh api repos/holetz/eclume/tarball/main | tar -xz --strip-components=1 -C "$SRC"
fi

passo="restauração do repositório fora"
log "restic: snapshot mais recente do repositório fora"
rm -rf "$REST" && install -d -m 700 "$REST"
fora -v "$REST:/out" --entrypoint sh "$RESTIC_IMAGE" -c \
  'restic restore latest --host eclume --no-cache --target /out && chown -R "$1" /out' sh "$(id -u):$(id -g)"
R="$REST/eclume"
passo="env.prod restaurado sem ECLUME_ENCRYPTION_KEY"
ECLUME_ENCRYPTION_KEY="$(sed -n 's/^ECLUME_ENCRYPTION_KEY=//p' "$R/secrets/env.prod" | tail -n 1)"
[[ -n "$ECLUME_ENCRYPTION_KEY" ]] || exit 1
ECLUME_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ECLUME_CLAUDE_OAUTH_TOKEN=//p' "$R/secrets/env.prod" | tail -n 1)"
install -d -m 755 "$STAGING_DIR/ca"
export ECLUME_ENCRYPTION_KEY ECLUME_CLAUDE_OAUTH_TOKEN ECLUME_DATA_DIR="$DATA_DIR" ECLUME_STAGING_CA_DIR="$STAGING_DIR/ca"

passo="build das imagens :staging"
log "build: server e web (:staging)"
BUILDKIT_PROGRESS=plain compose build server web
passo="banco e bucket restaurados"
compose up -d --wait --wait-timeout 120 postgres redis minio
# Os papéis vêm antes do dump; "já existe" (o superusuário eclume) é esperado.
compose exec -T postgres psql -U eclume -q -d postgres < "$R/pg/roles.sql" >/dev/null 2>&1 || true
compose exec -T postgres pg_restore -U eclume -d eclume --exit-on-error < "$R/pg/eclume.dump"
mkdir -p "$R/minio"
compose run --rm -v "$R/minio:/espelho:ro" --entrypoint sh minio-init -c \
  'mc alias set local http://minio:9000 eclume eclume-staging-secret >/dev/null && mc mb --ignore-existing local/eclume >/dev/null && mc mirror --quiet /espelho local/eclume >/dev/null'
passo="migrate do main sobre o banco restaurado"
compose run --rm migrate
passo="subida do stack"
compose up -d --wait --wait-timeout 300 server worker-cpu worker-agents worker web caddy

passo="contas descartáveis"
compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$CA"
chmod 644 "$CA"
senha="$(openssl rand -hex 16)"
printf '%s\n' "$senha" | compose run --rm -T migrate \
  eclume-server admin create --email "$EMAIL" --name "Admin staging" --password-stdin >/dev/null
aviso="$(curl -sf --cacert "$CA" "$URL/api/v1/auth/signup" | python3 -c 'import json, sys; print(json.load(sys.stdin)["notice"]["version"])')"
curl -sf --cacert "$CA" -H 'Content-Type: application/json' -o /dev/null \
  -d "{\"name\": \"Staging\", \"email\": \"$EMAIL\", \"password\": \"$senha\", \"notice_version\": \"$aviso\"}" \
  "$URL/api/v1/auth/signup"
(umask 077; printf 'ECLUME_URL=%s\nECLUME_CA=%s\nECLUME_EMAIL=%s\nECLUME_PASSWORD=%s\n' "$URL" "$CA" "$EMAIL" "$senha" > "$STAGING_DIR/conta")

if [[ "$acao" == subir ]]; then
  log "eclume-staging de pé em $URL (conta em $STAGING_DIR/conta, CA em $CA); derrube com: staging.sh derrubar"
  exit 0
fi

passo="sha256 de secrets/ e da PKI restaurados"
log "conferências"
[[ -s "$ESTADO/secrets.sha256" ]] || exit 1
(cd "$R" && sha256sum --quiet -c "$ESTADO/secrets.sha256")
passo="impressão digital da raiz do Caddy restaurada"
digital() { openssl x509 -noout -fingerprint -sha256 -in "$1"; }
[[ "$(digital "$R/caddy/data/caddy/pki/authorities/local/root.crt")" == "$(digital "$DATA_DIR/downloads/eclume-root.crt")" ]]
passo="content_hash dos áudios restaurados"
lote="$(compose exec -T postgres psql -U eclume -d eclume -qAt -c \
  "select audio_key, content_hash from recordings where audio_key is not null and content_hash like 'sha256:%' order by random() limit $LOTE")"
n=0
while IFS='|' read -r chave hash; do
  [[ -n "$chave" ]] || continue
  [[ -f "$R/minio/$chave" ]] || { passo="áudio ausente no backup: $chave"; exit 1; }
  [[ "sha256:$(sha256sum "$R/minio/$chave" | cut -d' ' -f1)" == "$hash" ]] || { passo="content_hash diverge: $chave"; exit 1; }
  n=$((n + 1))
done <<< "$lote"
fatia="$((10#$(date +%j) % 7 + 1))/7"
passo="restic check --read-data-subset $fatia do repositório fora"
fora "$RESTIC_IMAGE" check --no-cache --read-data-subset "$fatia" >/dev/null

passo="smoke_prod.py no staging"
log "smoke no staging"
ECLUME_SMOKE_PASSWORD="$senha" python3 "$SRC/deploy/smoke_prod.py" --url "$URL" --ca "$CA" \
  --email "$EMAIL" --admin-email "$EMAIL"
resumo="snapshot do repositório fora restaurado; migrate e smoke ok; $n áudios e a fatia $fatia conferidos"
log "ok: $resumo"
