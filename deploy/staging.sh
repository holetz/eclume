#!/usr/bin/env bash
# Staging efêmero do eclume (projeto `eclume-staging`, deploy/docker-compose.staging.yml), rodado NO
# HOST (<ECLUME_DATA_DIR>/bin/, instalado pelo deploy.sh; o cron `# eclume-ensaio` roda o ensaio):
#
#   staging.sh ensaio     restaura o backup do repositório FORA do host no staging, aplica o migrate
#                         do `main`, roda o smoke_prod.py e as conferências, grava estado/ensaio.json
#                         e sai sempre com `down -v`; completo aos domingos, parcial nos outros dias
#   staging.sh subir      o mesmo stack (sempre a restauração completa), de pé em https://127.0.0.1:18444 para as provas
#                         (conta descartável em ~/eclume-staging/conta, CA em ~/eclume-staging/ca/ca.crt)
#   staging.sh derrubar   `down -v` do stack e das imagens :staging
#
# O código é o tarball do `main` (gh api, o `gh` autenticado dos releases); ECLUME_STAGING_SRC
# aponta outra árvore. Conferências do ensaio: sha256 de secrets/ e da PKI contra
# estado/secrets.sha256, impressão digital da raiz restaurada contra downloads/eclume-root.crt,
# content_hash de um lote de áudios restaurados e `restic check --read-data-subset` de 1/7 rotativo
# do repositório fora. Recusa com o disco em 90% ou mais. Nada toca o projeto `eclume`.
#
# Peso: as imagens `eclume-server:<sha>` e `eclume-web:<sha>` (ou `eclume-edge:<sha>`) que o deploy
# reteve para o SHA do `main` são reaproveitadas, sem build; só o que falta é construído. O ensaio
# COMPLETO (domingo, ou ECLUME_ENSAIO_DIA=7) restaura o snapshot inteiro, confere o lote de áudios
# e roda o smoke de resumo e chat; o PARCIAL (os outros dias) restaura só banco, secrets e Caddy
# mais os áudios do lote, e roda o smoke somente de leitura. Todo contêiner leva `--cpu-shares 256`
# (a produção divide o host com o staging) e o restic e o mc, `GOMAXPROCS=1`.
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
CPU_SHARES=256
# O ensaio é completo aos domingos (date +%u = 7); ECLUME_ENSAIO_DIA força o dia. `subir` é sempre completo.
DIA="${ECLUME_ENSAIO_DIA:-$(date +%u)}"
SHA="${ECLUME_STAGING_SHA:-}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"

case "${1:-}" in
  ensaio|subir|derrubar) acao="$1" ;;
  --help|-h) sed -n '2,23p' "$0"; exit 0 ;;
  *) sed -n '2,23p' "$0" >&2; exit 2 ;;
esac

completo=1
[[ "${1:-}" != ensaio || "$DIA" -eq 7 ]] || completo=0

log() { echo "$(date '+%F %T') $*"; }
estado() {
  local detalhe="${3//\\/\\\\}"
  detalhe="${detalhe//\"/\\\"}"
  mkdir -p "$ESTADO"
  printf '{"ok": %s, "at": "%s", "detalhe": "%s"}\n' "$2" "$(date -Iseconds)" "$detalhe" > "$ESTADO/.$1.json.tmp"
  mv -f "$ESTADO/.$1.json.tmp" "$ESTADO/$1.json"
}
# O peso de CPU de todos os serviços entra por um arquivo extra, sem mexer no compose do `main`.
CPU_YML="$STAGING_DIR/cpu-shares.yml"
compose() {
  docker compose -p eclume-staging -f "$SRC/deploy/docker-compose.staging.yml" -f "$CPU_YML" "$@"
}
fora() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --env-file "$SECRETS/restic-fora.env" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
derrubar() {
  [[ ! -f "$SRC/deploy/docker-compose.staging.yml" ]] || compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm eclume-server:staging eclume-web:staging eclume-edge:staging >/dev/null 2>&1 || true
  rm -rf "$REST"
}

SRC="${ECLUME_STAGING_SRC:-$STAGING_DIR/main}"
install -d -m 700 "$STAGING_DIR"
# Só os serviços que o compose do `main` declara (o `web` virou `edge` em outra spec).
gerar_cpu_yml() {
  printf 'services: {}\n' > "$CPU_YML"
  if [[ -f "$SRC/deploy/docker-compose.staging.yml" ]]; then
    servicos="$(awk '/^services:/ {d=1; next} /^[^ #]/ {d=0} d && /^  [a-z][a-z0-9-]*:/ {sub(":", "", $1); print $1}' \
      "$SRC/deploy/docker-compose.staging.yml")"
    if [[ -n "$servicos" ]]; then
      printf 'services:\n' > "$CPU_YML"
      while read -r servico; do
        printf '  %s:\n    cpu_shares: %s\n' "$servico" "$CPU_SHARES" >> "$CPU_YML"
      done <<< "$servicos"
    fi
  fi
}
gerar_cpu_yml
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
  SHA="$(gh api repos/holetz/eclume/commits/main --jq .sha)"
  rm -rf "$SRC" && mkdir -p "$SRC"
  gh api "repos/holetz/eclume/tarball/$SHA" | tar -xz --strip-components=1 -C "$SRC"
fi

gerar_cpu_yml

# restaurar [--include <caminho do snapshot>…]: o snapshot mais recente do repositório fora em $REST.
restaurar() {
  fora -v "$REST:/out" --entrypoint sh "$RESTIC_IMAGE" -c \
    'dono="$1"; shift; restic restore latest --host eclume --no-cache --target /out "$@" && chown -R "$dono" /out' \
    sh "$(id -u):$(id -g)" "$@"
}
passo="restauração do repositório fora"
rm -rf "$REST" && install -d -m 700 "$REST"
if [[ "$completo" -eq 1 ]]; then
  log "restic: snapshot mais recente do repositório fora, inteiro"
  restaurar
else
  log "restic: snapshot mais recente do repositório fora, só banco, secrets e Caddy"
  restaurar --include /eclume/pg --include /eclume/secrets --include /eclume/caddy
fi
R="$REST/eclume"
passo="env.prod restaurado sem ECLUME_ENCRYPTION_KEY"
ECLUME_ENCRYPTION_KEY="$(sed -n 's/^ECLUME_ENCRYPTION_KEY=//p' "$R/secrets/env.prod" | tail -n 1)"
[[ -n "$ECLUME_ENCRYPTION_KEY" ]] || exit 1
ECLUME_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ECLUME_CLAUDE_OAUTH_TOKEN=//p' "$R/secrets/env.prod" | tail -n 1)"
install -d -m 755 "$STAGING_DIR/ca"
export ECLUME_ENCRYPTION_KEY ECLUME_CLAUDE_OAUTH_TOKEN ECLUME_DATA_DIR="$DATA_DIR" ECLUME_STAGING_CA_DIR="$STAGING_DIR/ca"

# As imagens `:staging` vêm das retidas do SHA quando existem (o deploy deixa `eclume-server:<sha>` e
# `eclume-web:<sha>`, ou `eclume-edge:<sha>`); só o que falta é construído. No ensaio completo a
# retida do server precisa do `claude` (o smoke de resumo roda pelo `claude -p`).
passo="imagens :staging"
web_imagem="$(grep -oE 'eclume-(web|edge):staging' "$SRC/deploy/docker-compose.staging.yml" | head -n 1 || true)"
web_imagem="${web_imagem:-eclume-web:staging}"
web_servico="$(awk '/^  [a-z-]+:$/ {s=$1} /image: eclume-(web|edge):staging/ {sub(":", "", s); print s; exit}' \
  "$SRC/deploy/docker-compose.staging.yml")"
web_servico="${web_servico:-web}"
construir=(server "$web_servico")
if [[ -n "$SHA" ]]; then
  construir=()
  if docker image inspect "eclume-server:$SHA" >/dev/null 2>&1 \
      && { [[ "$completo" -eq 0 ]] || docker run --rm --entrypoint claude "eclume-server:$SHA" --version >/dev/null 2>&1; }; then
    docker tag "eclume-server:$SHA" eclume-server:staging
    log "imagem retida eclume-server:$SHA reaproveitada"
  else
    construir+=(server)
  fi
  reaproveitada=0
  for nome in eclume-web eclume-edge; do
    if docker image inspect "$nome:$SHA" >/dev/null 2>&1; then
      docker tag "$nome:$SHA" "$web_imagem"
      log "imagem retida $nome:$SHA reaproveitada"
      reaproveitada=1
      break
    fi
  done
  [[ "$reaproveitada" -eq 1 ]] || construir+=("$web_servico")
fi
if (( ${#construir[@]} > 0 )); then
  log "build (:staging): ${construir[*]}"
  BUILDKIT_PROGRESS=plain compose build "${construir[@]}"
fi
passo="banco e bucket restaurados"
compose up -d --wait --wait-timeout 120 postgres redis minio
# Os papéis vêm antes do dump; "já existe" (o superusuário eclume) é esperado.
compose exec -T postgres psql -U eclume -q -d postgres < "$R/pg/roles.sql" >/dev/null 2>&1 || true
compose exec -T postgres pg_restore -U eclume -d eclume --exit-on-error < "$R/pg/eclume.dump"
# O lote de áudios conferidos: sorteado no banco restaurado. No ensaio parcial só eles voltam do snapshot.
passo="lote de áudios do banco restaurado"
lote="$(compose exec -T postgres psql -U eclume -d eclume -qAt -c \
  "select audio_key, content_hash from recordings where audio_key is not null and content_hash like 'sha256:%' order by random() limit $LOTE")"
if [[ "$completo" -eq 0 ]]; then
  passo="restauração dos áudios do lote"
  incluir=()
  while IFS='|' read -r chave _; do
    [[ -z "$chave" ]] || incluir+=(--include "/eclume/minio/$chave")
  done <<< "$lote"
  (( ${#incluir[@]} == 0 )) || restaurar "${incluir[@]}"
fi
passo="banco e bucket restaurados"
mkdir -p "$R/minio"
compose run --rm -e GOMAXPROCS=1 -v "$R/minio:/espelho:ro" --entrypoint sh minio-init -c \
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
smoke=(--url "$URL" --ca "$CA" --email "$EMAIL" --admin-email "$EMAIL")
[[ "$completo" -eq 1 ]] || smoke+=(--somente-leitura)
ECLUME_SMOKE_PASSWORD="$senha" python3 "$SRC/deploy/smoke_prod.py" "${smoke[@]}"
if [[ "$completo" -eq 1 ]]; then
  resumo="snapshot do repositório fora restaurado; migrate e smoke ok; $n áudios e a fatia $fatia conferidos"
else
  resumo="ensaio parcial (banco, secrets, Caddy e amostra de áudios); migrate e smoke de leitura ok; $n áudios e a fatia $fatia conferidos"
fi
log "ok: $resumo"
