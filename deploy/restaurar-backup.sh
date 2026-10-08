#!/usr/bin/env bash
# Restauração do backup do eclume (backup.sh: snapshots restic), rodada NO HOST (<ECLUME_DATA_DIR>/bin/).
#
#   restaurar-backup.sh [--repositorio local|fora] --teste [<snap>]   restaura num banco e num bucket
#                                                   temporários, compara contagens com a produção e apaga tudo
#   restaurar-backup.sh [--repositorio local|fora] --aplicar <snap> --confirmo
#                                                   substitui o banco e o bucket de produção
#   restaurar-backup.sh --banco <dump> --confirmo   substitui só o banco, a partir de um dump
#                                                   pré-deploy (backups/pre-deploy/*.dump)
#   restaurar-backup.sh --host-novo <pasta>         host novo: devolve secrets/ e a PKI do Caddy do
#                                                   repositório fora para <pasta>, antes do primeiro deploy
#
# <snap> é `latest`, o id restic (restic snapshots) ou a data AAAA-MM-DD (o último snapshot do dia);
# sem ela, `latest`. O repositório padrão é o local (backups/restic); `fora` lê o de
# secrets/restic-fora.env, com a mesma senha. --host-novo exige <pasta>/secrets/restic-password e
# <pasta>/secrets/restic-fora.env (tirados do cofre). --aplicar para server e workers, recria o banco
# eclume a partir do dump, espelha o bucket do snapshot de volta (sem apagar objetos que não estão
# no backup) e sobe os serviços de novo. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
DEST="$DATA_DIR/backups"
ENV_FILE="$DATA_DIR/secrets/env.prod"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5}"

repositorio=local
if [[ "${1:-}" == --repositorio ]]; then
  repositorio="${2:-}"
  shift 2 || true
fi
[[ "$repositorio" == local || "$repositorio" == fora ]] || { echo "--repositorio é local ou fora" >&2; exit 2; }
mode="${1:-}"
case "$mode" in
  --teste) snap="${2:-latest}" ;;
  --aplicar)
    snap="${2:?informe o snapshot (latest, id ou data)}"
    [[ "${3:-}" == --confirmo ]] || { echo "--aplicar substitui a produção: repita com --confirmo." >&2; exit 2; }
    ;;
  --banco)
    dump="${2:?informe o dump pré-deploy}"
    [[ "${3:-}" == --confirmo ]] || { echo "--banco substitui o banco de produção: repita com --confirmo." >&2; exit 2; }
    ;;
  --host-novo)
    pasta="$(realpath -m "${2:?informe a pasta do host novo}")"
    repositorio=fora
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
SECRETS="${pasta:-$DATA_DIR}/secrets"

# restic num contêiner como root (a PKI restaurada é dona root até o chown), sem cache.
restic_() {
  local repo=(-e RESTIC_REPOSITORY=/repo -v "$DEST/restic:/repo")
  [[ "$repositorio" == local ]] || repo=(--env-file "$SECRETS/restic-fora.env" "${destino_rclone[@]}")
  docker run --rm "${repo[@]}" -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$SECRETS/restic-password:/run/restic-password:ro" "$@"
}
# resolver <snap>: data AAAA-MM-DD vira o id do último snapshot do dia.
resolver() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "$1"; return; }
  restic_ "$RESTIC_IMAGE" snapshots --host eclume --json --no-cache | python3 -c '
import json, sys
dia = sys.argv[1]
ids = [s["short_id"] for s in sorted(json.load(sys.stdin), key=lambda s: s["time"]) if s["time"].startswith(dia)]
print(ids[-1] if ids else "")' "$1"
}
# extrair <snap> <pasta> <include...>: restaura o snapshot em <pasta>/eclume/ e o entrega ao usuário.
extrair() {
  local snap="$1" out="$2"
  shift 2
  local inc=()
  for i in "$@"; do inc+=(--include "$i"); done
  restic_ -v "$out:/out" --entrypoint sh "$RESTIC_IMAGE" -c \
    'snap="$1"; owner="$2"; shift 2; restic restore "$snap" --host eclume --no-cache --target /out "$@" && chown -R "$owner" /out' \
    sh "$snap" "$(id -u):$(id -g)" "${inc[@]}"
}
[[ -s "$SECRETS/restic-password" || "$mode" == --banco ]] || { echo "falta $SECRETS/restic-password" >&2; exit 1; }
[[ "$repositorio" == local || -s "$SECRETS/restic-fora.env" ]] || { echo "falta $SECRETS/restic-fora.env" >&2; exit 1; }
# Destino rclone (RESTIC_REPOSITORY=rclone:<remoto>:<caminho>, como o OneDrive): a imagem do restic
# não traz o `rclone` que ele chama. O binário estático da imagem fixada entra por um volume, que o
# Docker preenche com o /usr/local/bin dela na primeira montagem; a configuração, de
# secrets/restic-rclone/, entra gravável porque o rclone renova o token OAuth (e a regrava como root).
destino_rclone=()
if [[ "$repositorio" != local ]] && grep -q '^RESTIC_REPOSITORY=rclone:' "$SECRETS/restic-fora.env"; then
  volume="eclume-rclone-$(cut -c1-12 <<< "${RCLONE_IMAGE##*sha256:}")"
  docker run --rm --network none -v "$volume:/usr/local/bin" --entrypoint true "$RCLONE_IMAGE"
  destino_rclone=(-v "$volume:/usr/local/bin:ro" -v "$SECRETS/restic-rclone:/run/rclone" -e RCLONE_CONFIG=/run/rclone/rclone.conf)
fi

# --host-novo: só secrets/ e a PKI, sobre a pasta onde o deploy.sh vai criar o resto.
if [[ "$mode" == --host-novo ]]; then
  install -d -m 700 "$pasta/secrets"
  tmp="$(mktemp -d "$pasta/.host-novo.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  extrair latest "$tmp" /eclume/secrets /eclume/caddy
  [[ -s "$tmp/eclume/secrets/env.prod" ]] || { echo "o snapshot não tem secrets/env.prod" >&2; exit 1; }
  cp -a "$tmp/eclume/secrets/." "$pasta/secrets/"
  if [[ -d "$tmp/eclume/caddy" ]]; then
    mkdir -p "$pasta/caddy"
    cp -a "$tmp/eclume/caddy/." "$pasta/caddy/"
  fi
  echo "OK: secrets/ e a PKI do Caddy restaurados em $pasta; agora o deploy.sh e --aplicar latest --confirmo"
  exit 0
fi

container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# trocar_bancos <psql...>: encerra conexões e troca eclume pelo banco temporário (eclume_antes guarda o antigo).
trocar_bancos() {
  "$@" -c "drop database if exists eclume_antes" \
    -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', 'eclume_restore_novo') and pid <> pg_backend_pid()" \
    -c "alter database eclume rename to eclume_antes" -c "alter database eclume_restore_novo rename to eclume" >/dev/null &&
    { "$@" -c "drop database if exists eclume_antes" >/dev/null || true; }
}
# restaurar_validando <dump> <servicos...>: o dump prova restaurar ANTES de qualquer coisa destrutiva.
# 1) pg_restore --list; 2) restaura num banco temporário com os serviços ainda no ar; 3) só então para
# os serviços (ids_parados, que o chamador sobe), renomeia eclume -> eclume_antes e o temporário ->
# eclume e apaga o antigo. Falha antes da parada: nada muda. Falha depois: o banco antigo volta ao nome e os serviços sobem.
ids_parados=()
restaurar_validando() {
  local dump="$1" tmpdb=eclume_restore_novo antes=eclume_antes
  local ids=() s id services=(server worker worker-gpu)
  local sql=(docker exec -i "$pg" psql -U eclume -v ON_ERROR_STOP=1 -qAt -d postgres)
  for s in "${services[@]}"; do id="$(container "$s")"; [[ -z "$id" ]] || ids+=("$id"); done
  if ! docker exec -i "$pg" pg_restore --list < "$dump" >/dev/null; then
    echo "FALHA: o dump $dump não é legível pelo pg_restore; nada foi alterado" >&2
    return 1
  fi
  "${sql[@]}" -c "drop database if exists $tmpdb" -c "create database $tmpdb" >/dev/null
  if ! docker exec -i "$pg" pg_restore -U eclume -d "$tmpdb" --exit-on-error < "$dump"; then
    "${sql[@]}" -c "drop database if exists $tmpdb" >/dev/null || true
    echo "FALHA: o dump não restaura num banco temporário; produção e serviços intactos" >&2
    return 1
  fi
  echo "dump validado; parando ${services[*]}"
  [[ "${#ids[@]}" -eq 0 ]] || docker stop "${ids[@]}" >/dev/null
  ids_parados=("${ids[@]}")
  if ! trocar_bancos "${sql[@]}"; then
    # Desfaz o que a troca fez: o banco antigo volta ao nome e os serviços sobem.
    "${sql[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', '$antes') and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    if ! "${sql[@]}" -c "select 1 from pg_database where datname = 'eclume'" | grep -q 1; then
      "${sql[@]}" -c "alter database $antes rename to eclume" >/dev/null 2>&1 || true
    fi
    "${sql[@]}" -c "drop database if exists $tmpdb" >/dev/null 2>&1 || true
    [[ "${#ids[@]}" -eq 0 ]] || docker start "${ids[@]}" >/dev/null 2>&1 || true
    echo "FALHA: a troca de bancos falhou; o banco anterior foi devolvido e os serviços subiram" >&2
    return 1
  fi
}

# --banco: só o banco, do dump que o deploy grava antes de aplicar migrations (holetz/eclume#92).
# O bucket não muda: o dump é de minutos antes, e a fila de exclusão e a reconciliação acertam o resto.
if [[ "$mode" == --banco ]]; then
  [[ -s "$dump" ]] || { echo "falta $dump" >&2; exit 1; }
  pg="$(container postgres)"
  [[ -n "$pg" ]] || { echo "o postgres do projeto eclume não está rodando" >&2; exit 1; }
  restaurar_validando "$dump"
  [[ "${#ids_parados[@]}" -eq 0 ]] || docker start "${ids_parados[@]}" >/dev/null
  echo "OK: banco restaurado de $dump; suba as imagens do deploy correspondente (deploy.sh --voltar)"
  exit 0
fi
pg="$(container postgres)"
minio="$(container minio)"
[[ -n "$pg" && -n "$minio" ]] || { echo "postgres ou minio do projeto eclume não está rodando" >&2; exit 1; }
snap="$(resolver "$snap")"
[[ -n "$snap" ]] || { echo "nenhum snapshot nessa data" >&2; exit 1; }
# O snapshot fica em claro numa pasta temporária só durante a restauração.
work="$(mktemp -d "$DEST/.restaurar.XXXXXX")"
limpar() { rm -rf "$work"; }
trap limpar EXIT
echo "restaurando o snapshot $snap do repositório $repositorio"
extrair "$snap" "$work" /eclume/pg /eclume/minio
dump="$work/eclume/pg/eclume.dump"
roles="$work/eclume/pg/roles.sql"
snapshot="$work/eclume/minio"
mkdir -p "$snapshot"
for f in "$dump" "$roles"; do [[ -s "$f" ]] || { echo "falta ${f#"$work"/} no snapshot" >&2; exit 1; }; done
user="$(sed -n 's/^ECLUME_MINIO_USER=//p' "$ENV_FILE" | tail -n 1)"
pass="$(sed -n 's/^ECLUME_MINIO_PASSWORD=//p' "$ENV_FILE" | tail -n 1)"
# A rede interna `dados` do projeto (o MinIO também está na `fila-gpu`).
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$minio" | grep '_dados$')"
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
  trap 'psql_ -d postgres -c "drop database if exists $db" >/dev/null; mc rb --force "dst/$bucket" >/dev/null 2>&1 || true; limpar' EXIT
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
restaurar_validando "$dump"
echo "banco: $(psql_ -d eclume -c "$count_sql")"
mc mb --ignore-existing dst/eclume >/dev/null
mc mirror --overwrite --quiet /snap dst/eclume >/dev/null
echo "bucket: $(mc ls --recursive dst/eclume | wc -l) objetos"
[[ "${#ids_parados[@]}" -eq 0 ]] || docker start "${ids_parados[@]}" >/dev/null
echo "OK: produção restaurada do snapshot $snap"
