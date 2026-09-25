#!/usr/bin/env bash
# Backup diário do eclume, rodado NO HOST pelo cron do usuário dono de /srv/eclume (o deploy.sh
# instala este script em <ECLUME_DATA_DIR>/bin/ e a linha `# eclume-backup` no crontab).
#
#   <ECLUME_DATA_DIR>/bin/backup.sh
#
# Grava em <ECLUME_DATA_DIR>/backups/:
#   pg/roles-<data>.sql        papéis do cluster (eclume_app, eclume_server), pré-requisito da restauração
#   pg/eclume-<data>.dump      pg_dump -Fc do banco eclume
#   caddy/caddy-pki-<data>.tgz CA interna do Caddy (perdê-la troca a CA de todos os clientes)
#   minio/.espelho/            espelho do bucket (mc mirror --remove)
#   minio/<data>/              instantâneo do espelho; arquivos iguais ao do dia anterior são hardlinks
# Mantém os MANTER (7) mais recentes de cada. Rodar duas vezes no mesmo dia substitui o do dia.
# Restauração: restaurar-backup.sh (docs/project/deploy-producao.md).
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
MANTER="${MANTER:-7}"
DEST="$DATA_DIR/backups"
ENV_FILE="$DATA_DIR/secrets/env.prod"
stamp="$(date +%F)"
umask 077

log() { echo "$(date '+%F %T') $*"; }
container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
# Apaga tudo além dos $MANTER mais recentes que casam com o glob (nomes com data ISO ordenam).
retain() {
  local dir="$1" pattern="$2"
  mapfile -t old < <(find "$dir" -mindepth 1 -maxdepth 1 -name "$pattern" -printf '%f\n' | sort -r | tail -n +"$((MANTER + 1))")
  for f in "${old[@]}"; do rm -rf "${dir:?}/$f"; done
}

pg="$(container postgres)"
minio="$(container minio)"
caddy="$(container caddy)"
[[ -n "$pg" && -n "$minio" ]] || { log "ERRO: postgres ou minio do projeto eclume não está rodando"; exit 1; }
mkdir -p "$DEST/pg" "$DEST/minio" "$DEST/caddy"

log "postgres: dump"
docker exec "$pg" pg_dumpall -U eclume --roles-only > "$DEST/pg/.roles.tmp"
mv -f "$DEST/pg/.roles.tmp" "$DEST/pg/roles-$stamp.sql"
docker exec "$pg" pg_dump -U eclume -Fc eclume > "$DEST/pg/.dump.tmp"
mv -f "$DEST/pg/.dump.tmp" "$DEST/pg/eclume-$stamp.dump"

if [[ -n "$caddy" ]]; then
  log "caddy: CA interna"
  docker exec "$caddy" tar -C /data -czf - caddy/pki > "$DEST/caddy/.pki.tmp"
  mv -f "$DEST/caddy/.pki.tmp" "$DEST/caddy/caddy-pki-$stamp.tgz"
fi

log "minio: espelho do bucket"
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$ENV_FILE" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$ENV_FILE" | tail -n 1)"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$minio")"
image="$(docker inspect -f '{{.Config.Image}}' "$minio")"
mkdir -p "$DEST/minio/.espelho"
docker run --rm --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e "MC_HOST_src=http://$user:$pass@minio:9000" -v "$DEST/minio:/b" --entrypoint mc "$image" \
  mirror --overwrite --remove --quiet src/eclume /b/.espelho >/dev/null
# O rsync grava cada arquivo novo por rename, então um hardlink de instantâneo anterior nunca é
# alterado no lugar.
prev="$(find "$DEST/minio" -mindepth 1 -maxdepth 1 -name '20*' ! -name "$stamp" -printf '%f\n' | sort | tail -n 1)"
rsync -a --delete ${prev:+--link-dest="$DEST/minio/$prev"} "$DEST/minio/.espelho/" "$DEST/minio/$stamp/"

retain "$DEST/pg" 'eclume-20*.dump'
retain "$DEST/pg" 'roles-20*.sql'
retain "$DEST/caddy" 'caddy-pki-20*.tgz'
retain "$DEST/minio" '20*'
log "ok: $(du -sh "$DEST/pg/eclume-$stamp.dump" | cut -f1) de banco, $(find "$DEST/minio/$stamp" -type f | wc -l) arquivos no bucket"
