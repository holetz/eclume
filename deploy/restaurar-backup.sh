#!/usr/bin/env bash
# Restauração do backup do eclume (backup.sh), rodada NO HOST (<ECLUME_DATA_DIR>/bin/).
#
#   restaurar-backup.sh --teste [<data>]            restaura num banco e num bucket temporários,
#                                                   compara contagens com a produção e apaga tudo
#   restaurar-backup.sh --aplicar <data> --confirmo substitui o banco e o bucket de produção
#
# <data> é a do backup (AAAA-MM-DD); sem ela, o mais recente. --aplicar para server e workers,
# recria o banco eclume a partir do dump, espelha o instantâneo de volta no bucket (sem apagar
# objetos que não estão no backup) e sobe os serviços de novo. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
DEST="$DATA_DIR/backups"
ENV_FILE="$DATA_DIR/secrets/env.prod"

mode="${1:-}"
case "$mode" in
  --teste) stamp="${2:-}" ;;
  --aplicar)
    stamp="${2:?informe a data do backup}"
    [[ "${3:-}" == --confirmo ]] || { echo "--aplicar substitui a produção: repita com --confirmo." >&2; exit 2; }
    ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
[[ -n "$stamp" ]] || stamp="$(find "$DEST/pg" -name 'eclume-20*.dump' -printf '%f\n' | sort | tail -n 1 | sed 's/^eclume-//; s/\.dump$//')"
dump="$DEST/pg/eclume-$stamp.dump"
roles="$DEST/pg/roles-$stamp.sql"
snapshot="$DEST/minio/$stamp"
for f in "$dump" "$roles" "$snapshot"; do [[ -e "$f" ]] || { echo "falta $f" >&2; exit 1; }; done
echo "backup de $stamp"

container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
pg="$(container postgres)"
minio="$(container minio)"
[[ -n "$pg" && -n "$minio" ]] || { echo "postgres ou minio do projeto eclume não está rodando" >&2; exit 1; }
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$ENV_FILE" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$ENV_FILE" | tail -n 1)"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$minio")"
image="$(docker inspect -f '{{.Config.Image}}' "$minio")"
mc() {
  docker run --rm -i --network "$network" --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e "MC_HOST_dst=http://$user:$pass@minio:9000" -v "$snapshot:/snap:ro" --entrypoint mc "$image" "$@"
}
psql_() { docker exec -i "$pg" psql -U eclume -v ON_ERROR_STOP=1 -qAt "$@"; }
# Só tabelas que existem antes e depois da migration 008 (a conta por usuário tirou `organizations`).
count_sql="select string_agg(t || '=' || n, ' ' order by t) from (
  select 'users' t, count(*) n from users union all
  select 'recordings', count(*) from recordings union all
  select 'transcripts', count(*) from transcripts union all
  select 'summaries', count(*) from summaries) c"

# Os papéis (eclume_app, eclume_server) são do cluster, não do banco; num cluster novo eles vêm antes do dump.
# "já existe" é esperado num cluster que já os tem.
docker exec -i "$pg" psql -U eclume -q -d postgres < "$roles" >/dev/null 2>&1 || true

if [[ "$mode" == --teste ]]; then
  db=eclume_restore_teste
  bucket=eclume-restore-teste
  trap 'psql_ -d postgres -c "drop database if exists $db" >/dev/null; mc rb --force "dst/$bucket" >/dev/null 2>&1 || true' EXIT
  psql_ -d postgres -c "drop database if exists $db" -c "create database $db"
  docker exec -i "$pg" pg_restore -U eclume -d "$db" --exit-on-error < "$dump"
  restored="$(psql_ -d "$db" -c "$count_sql")"
  current="$(psql_ -d eclume -c "$count_sql")"
  echo "banco restaurado: $restored"
  echo "banco produção:   $current"
  mc mb --ignore-existing "dst/$bucket" >/dev/null
  mc mirror --quiet /snap "dst/$bucket" >/dev/null
  n_restored="$(mc ls --recursive "dst/$bucket" | wc -l)"
  n_snapshot="$(find "$snapshot" -type f | wc -l)"
  n_current="$(mc ls --recursive dst/eclume | wc -l)"
  echo "bucket restaurado: $n_restored objetos (instantâneo: $n_snapshot; produção: $n_current)"
  [[ "$n_restored" == "$n_snapshot" ]] || { echo "FALHA: o bucket restaurado não bate com o instantâneo" >&2; exit 1; }
  # A produção pode ter crescido depois do backup; contagens iguais só são exigidas do que foi salvo.
  if [[ "$restored" == "$current" && "$n_restored" == "$n_current" ]]; then
    echo "OK: restauração idêntica à produção"
  else
    echo "OK: restauração íntegra (a produção mudou desde o backup)"
  fi
  exit 0
fi

# --aplicar
services=(server worker-cpu worker-gpu)
ids=()
for s in "${services[@]}"; do id="$(container "$s")"; [[ -z "$id" ]] || ids+=("$id"); done
echo "parando ${services[*]}"
[[ "${#ids[@]}" -eq 0 ]] || docker stop "${ids[@]}" >/dev/null
psql_ -d postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'eclume' and pid <> pg_backend_pid()" >/dev/null
psql_ -d postgres -c "drop database eclume" -c "create database eclume"
docker exec -i "$pg" pg_restore -U eclume -d eclume --exit-on-error < "$dump"
echo "banco: $(psql_ -d eclume -c "$count_sql")"
mc mb --ignore-existing dst/eclume >/dev/null
mc mirror --overwrite --quiet /snap dst/eclume >/dev/null
echo "bucket: $(mc ls --recursive dst/eclume | wc -l) objetos"
[[ "${#ids[@]}" -eq 0 ]] || docker start "${ids[@]}" >/dev/null
echo "OK: produção restaurada do backup de $stamp"
