#!/usr/bin/env bash
# Backup diário do eclume, rodado NO HOST pelo cron do usuário dono de /srv/eclume (o deploy.sh
# instala este script em <ECLUME_DATA_DIR>/bin/ e a linha `# eclume-backup` no crontab).
#
#   <ECLUME_DATA_DIR>/bin/backup.sh
#
# Um snapshot restic cifrado (AES-256, senha em secrets/restic-password) no repositório local
# <ECLUME_DATA_DIR>/backups/restic, com os caminhos fixos de /eclume:
#   /eclume/pg/roles.sql, /eclume/pg/eclume.dump   papéis do cluster e pg_dump -Fc do banco
#   /eclume/pre-deploy/                            dumps de antes das migrations (deploy.sh)
#   /eclume/minio/                                 espelho do bucket (backups/minio/.espelho)
#   /eclume/caddy/data/caddy/pki/                  CA interna do Caddy, com root.key
#   /eclume/secrets/                               env.prod, senhas, tokens e chaves (sem restic-*)
# Retenção: MANTER (7) diários, nos dois repositórios: o `forget` roda todo dia e o `prune` (que
# reescreve pacotes e é a parte cara) só aos domingos. Com secrets/restic-fora.env (RESTIC_REPOSITORY
# e a credencial do destino), o mesmo snapshot vai por `restic copy` ao repositório fora do host,
# que usa a mesma senha. Os dumps só existem em claro numa pasta temporária durante a rodada.
#
# Estado (contrato com o vigia.sh): estado/backup.json e estado/fora.json ({"ok", "at", "detalhe"},
# por rename) e estado/secrets.sha256 (sha256sum de secrets/ e da PKI, caminhos relativos ao
# ECLUME_DATA_DIR). Restauração: restaurar-backup.sh (docs/project/deploy-producao.md).
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
MANTER="${MANTER:-7}"
# O host também é CI e staging: todo contêiner do backup leva peso de CPU baixo e o Go do restic e
# do mc, um núcleo. O `prune` é dominical (ECLUME_BACKUP_DIA força o dia, 1-7; 7 = domingo).
CPU_SHARES=256
DIA="${ECLUME_BACKUP_DIA:-$(date +%u)}"
PRUNE=()
[[ "$DIA" -ne 7 ]] || PRUNE=(--prune)
# backup.log e ensaio.log (o cron anexa a eles) passam para <nome>.1 ao chegar neste tamanho.
LOG_MAX_KB="${ECLUME_LOG_MAX_KB:-5120}"
DEST="$DATA_DIR/backups"
SECRETS="$DATA_DIR/secrets"
ESTADO="$DATA_DIR/estado"
REPO="$DEST/restic"
PKI="$DATA_DIR/caddy/data/caddy/pki"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
umask 077

log() { echo "$(date '+%F %T') $*"; }
container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
# estado <etapa> <true|false> <detalhe>: o json da etapa, por rename (o vigia lê o mtime).
estado() {
  local detalhe="${3//\\/\\\\}"
  detalhe="${detalhe//\"/\\\"}"
  printf '{"ok": %s, "at": "%s", "detalhe": "%s"}\n' "$2" "$(date -Iseconds)" "$detalhe" > "$ESTADO/.$1.json.tmp"
  mv -f "$ESTADO/.$1.json.tmp" "$ESTADO/$1.json"
}
# restic como root num contêiner (lê a PKI do Caddy, dona root), com o repositório local em /repo.
restic_() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -e RESTIC_CACHE_DIR=/cache -v "$REPO:/repo" -v "$DEST/.restic-cache:/cache" \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}

etapa=backup
tmp=""
fim() {
  local status=$?
  [[ -z "$tmp" ]] || rm -rf "$tmp"
  if [[ "$status" -ne 0 ]]; then
    log "ERRO na etapa $etapa (saída $status)"
    estado "$etapa" false "${motivo:-falhou com saída $status; veja backups/backup.log}"
  fi
}
trap fim EXIT
mkdir -p "$ESTADO" "$DEST/minio/.espelho" "$DEST/pre-deploy" "$DEST/.restic-cache"
for nome in backup ensaio; do
  if [[ -f "$DEST/$nome.log" && "$(wc -c < "$DEST/$nome.log")" -ge $((LOG_MAX_KB * 1024)) ]]; then
    mv -f "$DEST/$nome.log" "$DEST/$nome.log.1"
  fi
done

motivo="sem $SECRETS/restic-password ou repositório em $REPO (rode o deploy.sh)"
[[ -s "$SECRETS/restic-password" && -f "$REPO/config" ]] || exit 1
pg="$(container postgres)"
minio="$(container minio)"
motivo="postgres ou minio do projeto eclume não está rodando"
[[ -n "$pg" && -n "$minio" ]] || exit 1
unset motivo
tmp="$(mktemp -d "$DEST/.rodada.XXXXXX")"

log "postgres: dump"
docker exec "$pg" pg_dumpall -U eclume --roles-only > "$tmp/roles.sql"
docker exec "$pg" pg_dump -U eclume -Fc eclume > "$tmp/eclume.dump"

log "minio: espelho do bucket"
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$SECRETS/env.prod" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$SECRETS/env.prod" | tail -n 1)"
# A rede interna `dados` do projeto (o MinIO também está na `fila-gpu`).
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$minio" | grep '_dados$')"
image="$(docker inspect -f '{{.Config.Image}}' "$minio")"
docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e "MC_HOST_src=http://$user:$pass@minio:9000" -v "$DEST/minio:/b" --entrypoint mc "$image" \
  mirror --overwrite --remove --quiet src/eclume /b/.espelho >/dev/null

log "restic: snapshot local"
fontes=(-v "$tmp:/eclume/pg:ro" -v "$DEST/pre-deploy:/eclume/pre-deploy:ro"
  -v "$DEST/minio/.espelho:/eclume/minio:ro" -v "$SECRETS:/eclume/secrets:ro")
[[ ! -d "$PKI" ]] || fontes+=(-v "$PKI:/eclume/caddy/data/caddy/pki:ro")
# --host fixo: o hostname do contêiner muda a cada rodada, e o forget agrupa por host e caminhos.
restic_ "${fontes[@]}" "$RESTIC_IMAGE" backup --host eclume --tag eclume --quiet --read-concurrency 1 \
  --exclude '/eclume/secrets/restic-*' /eclume
restic_ "$RESTIC_IMAGE" forget --host eclume --keep-daily "$MANTER" "${PRUNE[@]}" --quiet
# A conferência do ensaio e da prova de host novo: sha256 do que o snapshot levou de secrets/ e da PKI.
restic_ "${fontes[@]}" --entrypoint sh "$RESTIC_IMAGE" -c \
  'cd /eclume && find secrets $(test -d caddy && echo caddy) -type f ! -name "restic-*" -exec sha256sum {} + | sort -k 2' \
  > "$ESTADO/.secrets.sha256.tmp"
mv -f "$ESTADO/.secrets.sha256.tmp" "$ESTADO/secrets.sha256"
# O snapshot substitui o que o backup antigo deixava em claro.
rm -rf "$DEST/pg" "$DEST/caddy"
find "$DEST/minio" -mindepth 1 -maxdepth 1 -name '20*' -exec rm -rf {} +
resumo="$(du -sh "$tmp/eclume.dump" | cut -f1) de banco, $(find "$DEST/minio/.espelho" -type f | wc -l) arquivos no bucket"
estado backup true "$resumo"
log "ok: $resumo"

etapa=fora
if [[ ! -s "$SECRETS/restic-fora.env" ]]; then
  log "fora: sem $SECRETS/restic-fora.env; cópia fora do host não configurada"
  estado fora false "sem secrets/restic-fora.env: cópia fora do host não configurada"
  exit 0
fi
log "restic: cópia para o repositório fora do host"
fora_() {
  docker run --rm --cpu-shares "$CPU_SHARES" -e GOMAXPROCS=1 --env-file "$SECRETS/restic-fora.env" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -e RESTIC_CACHE_DIR=/cache -v "$DEST/.restic-cache:/cache" \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
fora_ -v "$REPO:/repo" "$RESTIC_IMAGE" copy --from-repo /repo \
  --from-password-file /run/restic-password --host eclume --quiet
fora_ "$RESTIC_IMAGE" forget --host eclume --keep-daily "$MANTER" "${PRUNE[@]}" --quiet
estado fora true "snapshot copiado; $MANTER diários retidos"
log "ok: cópia fora do host"
