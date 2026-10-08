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
# Variáveis que o trap lê (ou que mudam o caminho) nascem vazias: nada herdado do ambiente é apagado.
work=""
pasta=""
dump=""
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

# Estado real do cluster: nada é apagado sem prova de outra cópia (o `pg_database` é a fonte da verdade).
sql=()
ids_parados=()
# existe <db>: 0 existe, 1 não existe, 2 não foi possível ler (nunca autoriza apagar).
existe() {
  local saida
  saida="$("${sql[@]}" -c "select 1 from pg_database where datname = '$1'" 2>/dev/null)" || return 2
  [[ "$saida" == 1 ]]
}
# apagar_com_garantia <alvo> <garantia...>: só apaga <alvo> se alguma garantia existir no cluster.
apagar_com_garantia() {
  local alvo="$1" g rc
  shift
  for g in "$@"; do
    rc=0
    existe "$g" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      "${sql[@]}" -c "drop database if exists $alvo" >/dev/null 2>&1 && return 0
      echo "ALERTA: não consegui apagar $alvo; ele continua no cluster" >&2
      return 1
    fi
  done
  echo "ALERTA: $alvo mantido: não provei que há outra cópia ($*)" >&2
  return 1
}
# estado_bancos: o que o pg_database tem agora, para a mensagem final.
estado_bancos() {
  local b rc out=()
  for b in eclume eclume_antes eclume_restore_novo; do
    rc=0
    existe "$b" || rc=$?
    case "$rc" in 0) out+=("$b=sim") ;; 1) out+=("$b=não") ;; *) out+=("$b=?") ;; esac
  done
  echo "${out[*]}"
}
# religar: sobe os serviços parados, uma vez só; vale no sucesso e em qualquer falha (trap de EXIT).
religar() {
  [[ "${#ids_parados[@]}" -gt 0 ]] || return 0
  local ids=("${ids_parados[@]}")
  ids_parados=()
  if docker start "${ids[@]}" >/dev/null; then
    echo "serviços religados" >&2
  else
    echo "ALERTA: o docker start falhou; os serviços podem estar parados: ${ids[*]}" >&2
    return 1
  fi
}
limpar() {
  religar || true
  [[ -z "$work" ]] || rm -rf "$work"
}
# interromper <código>: INT/TERM no meio da troca. Mede o pg_database; sem eclume provado, não religa
# (subir os serviços sem banco esconde o problema) e diz o estado e como recuperar.
interromper() {
  local rc=0
  trap '' INT TERM
  if [[ "${#sql[@]}" -gt 0 && "${#ids_parados[@]}" -gt 0 ]]; then
    existe eclume || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      echo "INTERROMPIDO: eclume não está provado no pg_database; estado medido: $(estado_bancos). Os serviços continuam parados (${ids_parados[*]}) e nada foi apagado; recupere à mão com: alter database <eclume_antes ou eclume_restore_novo> rename to eclume, e então docker start ${ids_parados[*]}" >&2
      ids_parados=()
    else
      echo "INTERROMPIDO: eclume existe; estado medido: $(estado_bancos)" >&2
    fi
  fi
  exit "$1"
}
trap limpar EXIT
trap 'interromper 130' INT
trap 'interromper 143' TERM

# trocar_bancos: encerra conexões e troca eclume pelo temporário (eclume_antes guarda o antigo).
trocar_bancos() {
  local rc=0 tmpdb=eclume_restore_novo antes=eclume_antes
  local termina="select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', '$tmpdb') and pid <> pg_backend_pid()"
  existe eclume || rc=$?
  [[ "$rc" -ne 2 ]] || { echo "FALHA: não consegui ler o pg_database" >&2; return 1; }
  if [[ "$rc" -eq 1 ]]; then
    echo "ALERTA: não existe o banco eclume; o restaurado é promovido a eclume e $antes (se existir) só sai depois de provar o eclume" >&2
    "${sql[@]}" -c "$termina" -c "alter database $tmpdb rename to eclume" >/dev/null || return 1
  else
    apagar_com_garantia "$antes" eclume || true
    "${sql[@]}" -c "$termina" -c "alter database eclume rename to $antes" \
      -c "alter database $tmpdb rename to eclume" >/dev/null || return 1
  fi
  existe eclume || { echo "FALHA: depois da troca, eclume não está no pg_database" >&2; return 1; }
  apagar_com_garantia "$antes" eclume || true
}
# desfazer_troca: mede o estado, devolve o banco antigo ao nome se faltar eclume e só então apaga o temporário.
desfazer_troca() {
  local e=0 a=0
  "${sql[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('eclume', 'eclume_antes') and pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  existe eclume || e=$?
  existe eclume_antes || a=$?
  if [[ "$e" -eq 1 && "$a" -eq 0 ]]; then
    "${sql[@]}" -c "alter database eclume_antes rename to eclume" >/dev/null 2>&1 || true
    e=0
    existe eclume || e=$?
  fi
  [[ "$e" -ne 0 ]] || apagar_com_garantia eclume_restore_novo eclume || true
  if [[ "$e" -eq 0 ]]; then
    echo "FALHA: a troca de bancos falhou; estado medido: $(estado_bancos)" >&2
  else
    echo "FALHA: a troca de bancos falhou e NENHUM banco se chama eclume; estado medido: $(estado_bancos). Nada foi apagado; recupere à mão com: alter database <eclume_antes ou eclume_restore_novo> rename to eclume" >&2
  fi
}
# restaurar_validando <dump>: o dump prova restaurar ANTES de qualquer coisa destrutiva.
# 1) pg_restore --list; 2) restaura num banco temporário com os serviços ainda no ar; 3) só então para
# os serviços (ids_parados, que o trap de EXIT religa em qualquer falha), troca os bancos e confere o pg_database.
restaurar_validando() {
  local dump="$1" tmpdb=eclume_restore_novo rc=0
  local ids=() s id services=(server worker worker-gpu)
  sql=(docker exec -i "$pg" psql -U eclume -v ON_ERROR_STOP=1 -qAt -d postgres)
  for s in "${services[@]}"; do id="$(container "$s")"; [[ -z "$id" ]] || ids+=("$id"); done
  if ! docker exec -i "$pg" pg_restore --list < "$dump" >/dev/null; then
    echo "FALHA: o dump $dump não é legível pelo pg_restore; nada foi alterado" >&2
    return 1
  fi
  existe "$tmpdb" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    echo "FALHA: não consegui ler o pg_database; nada foi alterado" >&2
    return 1
  elif [[ "$rc" -eq 0 ]] && ! apagar_com_garantia "$tmpdb" eclume eclume_antes; then
    echo "FALHA: sobrou $tmpdb de uma tentativa anterior e não há outra cópia; nada foi alterado" >&2
    return 1
  fi
  "${sql[@]}" -c "create database $tmpdb" >/dev/null
  if ! docker exec -i "$pg" pg_restore -U eclume -d "$tmpdb" --exit-on-error < "$dump"; then
    "${sql[@]}" -c "drop database if exists $tmpdb" >/dev/null || true
    echo "FALHA: o dump não restaura num banco temporário; produção e serviços intactos" >&2
    return 1
  fi
  echo "dump validado; parando ${services[*]}"
  ids_parados=("${ids[@]}")
  if [[ "${#ids[@]}" -gt 0 ]] && ! docker stop "${ids[@]}" >/dev/null; then
    echo "FALHA: o docker stop falhou; nenhum banco foi trocado" >&2
    apagar_com_garantia "$tmpdb" eclume || true
    return 1
  fi
  if ! trocar_bancos; then
    desfazer_troca
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
  religar
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
mc mirror --overwrite --quiet /snap dst/eclume >/dev/null ||
  { echo "FALHA: o espelhamento do bucket falhou depois da troca; o banco já foi restaurado" >&2; exit 1; }
echo "bucket: $(mc ls --recursive dst/eclume | wc -l) objetos"
religar
echo "OK: produção restaurada do snapshot $snap"
