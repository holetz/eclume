#!/usr/bin/env bash
# Production checker, run ON THE HOST by the cron of the user owning /srv/eclume every 5 min
# (deploy.sh installs this script in <ECLUME_DATA_DIR>/bin/ and the `# eclume-watchdog` line in the crontab).
#
#   <ECLUME_DATA_DIR>/bin/watchdog.sh [--simulate]
#
# Conditions (one key each, state in <ECLUME_DATA_DIR>/estado/vigia/):
#   disco      disk use of ECLUME_DATA_DIR >= WATCHDOG_DISK_PCT (85)
#   backup     estado/backup.json without `ok` for more than WATCHDOG_BACKUP_HOURS (26) h (without
#   fora       the json, the last `ok:` line of backups/backup.log); fora and ensaio only with
#   ensaio     estado/fora.json and estado/ensaio.json
#   conteiner  container of the eclume project unhealthy, restarting or stopped in two runs in a row
#   fila       GPU job `queued` for more than 2 h (eclume-server saude --json)
#   falhas     3 or more failures in 24 h, or any `provider_auth`
#   token      Claude token expiring in WATCHDOG_TOKEN_DAYS (30) days or less; an unknown expiry
#              warns only once
#   gpu        nvidia-smi failing or the GPU worker heartbeat missing in two runs in a row (the
#              clean restart of the idle recycle, #149, deletes the heartbeat for a few seconds)
#   saude      `eclume-server saude --json` without an answer (server down)
# The keys, the state folder (estado/vigia/) and its files keep their pt-BR names: they are host
# data, and an active alert's marker must survive the English rename.
# Each alert goes out once, repeats every WATCHDOG_REPEAT_HOURS (6) h while it lasts and sends a
# back-to-normal notice. --simulate prints what it would send, without sending or writing state.
# Delivery: while the channel is not decided (secrets/alerta.env), the message goes to
# estado/vigia/alertas.log and to syslog (`logger -t eclume-watchdog`).
# Deprecated pt-BR names, still read as a fallback: VIGIA_DISCO_PCT, VIGIA_BACKUP_HORAS,
# VIGIA_TOKEN_DIAS, VIGIA_REPETIR_HORAS.
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
STATE="$DATA_DIR/estado"
WATCH="$STATE/vigia"
DISK_PCT="${WATCHDOG_DISK_PCT:-${VIGIA_DISCO_PCT:-85}}"
BACKUP_HOURS="${WATCHDOG_BACKUP_HOURS:-${VIGIA_BACKUP_HORAS:-26}}"
TOKEN_DAYS="${WATCHDOG_TOKEN_DAYS:-${VIGIA_TOKEN_DIAS:-30}}"
REPEAT_S=$(( ${WATCHDOG_REPEAT_HOURS:-${VIGIA_REPETIR_HORAS:-6}} * 3600 ))
# One-shot services: they exit with 0 and stay stopped on purpose.
ONE_SHOT=" migrate minio-init publish-ca "
SIMULATE=""
[[ "${1:-}" == "--simulate" ]] && SIMULATE=1
now="$(date +%s)"
umask 077
[[ -n "$SIMULATE" ]] || mkdir -p "$WATCH"

send() {
  local msg="eclume ($(hostname)): $1"
  if [[ -n "$SIMULATE" ]]; then
    echo "[simulated] $msg"
    return
  fi
  echo "$(date '+%F %T') $msg" >> "$WATCH/alertas.log"
  logger -t eclume-watchdog -- "$msg" 2>/dev/null || true
}

# condition <key> <active: 1|0> <message>: alerts the first time, repeats every REPEAT_S, notices the return.
condition() {
  local key="$1" active="$2" msg="$3" marker="$WATCH/$1.alerta"
  if [[ "$active" == 1 ]]; then
    if [[ -n "$SIMULATE" ]]; then
      send "ALERT $key: $msg"
    elif [[ ! -f "$marker" ]] || (( now - $(cat "$marker") >= REPEAT_S )); then
      send "ALERT $key: $msg"
      echo "$now" > "$marker"
    fi
  elif [[ -f "$marker" ]]; then
    [[ -n "$SIMULATE" ]] && { send "normal $key"; return; }
    send "normal $key: back to normal"
    rm -f "$marker"
  fi
}

container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# --- disk -----------------------------------------------------------------------------------------
pct="$(df --output=pcent "$DATA_DIR" | tail -n 1 | tr -dc 0-9)"
condition disco "$(( pct >= DISK_PCT ))" "disk of $DATA_DIR at ${pct}% (limit ${DISK_PCT}%)"

# --- backup, off-host copy and rehearsal ----------------------------------------------------------
# Age in hours of the last `ok`: the stage's json (#91) if it exists; without it, the log's `ok:` line.
ok_age() {
  local json="$STATE/$1.json"
  if [[ -f "$json" ]]; then
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$json" || { echo failed; return; }
    echo $(( (now - $(stat -c %Y "$json")) / 3600 ))
  elif [[ "$1" == backup ]]; then
    local line
    line="$(grep ' ok: ' "$DATA_DIR/backups/backup.log" 2>/dev/null | tail -n 1 | cut -c1-19)"
    [[ -n "$line" ]] || { echo never; return; }
    echo $(( (now - $(date -d "$line" +%s)) / 3600 ))
  fi
}
for stage in backup fora ensaio; do
  age="$(ok_age "$stage")"
  [[ -z "$age" ]] && continue
  case "$age" in
    failed) condition "$stage" 1 "the last $stage run finished without ok" ;;
    never) condition "$stage" 1 "no $stage with ok recorded" ;;
    *) condition "$stage" "$(( age > BACKUP_HOURS ))" "last $stage with ok ${age} h ago" ;;
  esac
done

# --- containers: two runs in a row ----------------------------------------------------------------
bad=""
while read -r service cstate status; do
  [[ -z "$service" ]] && continue
  if [[ "$cstate" == restarting || "$status" == *"(unhealthy)"* ]]; then
    bad+=" $service($cstate)"
  elif [[ "$cstate" == exited || "$cstate" == dead ]] && [[ "$ONE_SHOT" != *" $service "* || "$status" != "Exited (0)"* ]]; then
    bad+=" $service($cstate)"
  fi
done < <(docker ps -a --filter label=com.docker.compose.project=eclume \
  --format '{{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}')
in_a_row=0
if [[ -n "$bad" ]]; then
  in_a_row=$(( $(cat "$WATCH/conteiner.rodadas" 2>/dev/null || echo 0) + 1 ))
fi
[[ -n "$SIMULATE" ]] || echo "$in_a_row" > "$WATCH/conteiner.rodadas"
[[ -n "$SIMULATE" && -n "$bad" ]] && in_a_row=2
condition conteiner "$(( in_a_row >= 2 ))" "containers with a problem:${bad}"

# --- application numbers (the same Health as the admin) ---------------------------------------------
server="$(container server)"
health=""
[[ -n "$server" ]] && health="$(docker exec "$server" eclume-server saude --json 2>/dev/null || true)"
if [[ -z "$health" ]]; then
  condition saude 1 "eclume-server saude --json without an answer (server down?)"
  exit 0
fi
condition saude 0 ""
# One line of |-separated fields: queue, failures, provider_auth, token days, GPU worker.
IFS='|' read -r queued failures auth days worker < <(python3 -c '
import json, sys
r = json.load(sys.stdin)
s, tok = r["summary"], r["claude_token"]
days = "" if tok.get("days_left") is None else tok["days_left"]
print(s["queued_over_2h"], s["failed_last_24h"], s["provider_auth_last_24h"], days,
      1 if r["health"].get("worker") else 0, sep="|")
' <<< "$health")
condition fila "$(( queued > 0 ))" "$queued GPU job(s) queued for more than 2 h"
condition falhas "$(( failures >= 3 || auth > 0 ))" "$failures failure(s) in 24 h, $auth of provider_auth"
if [[ -z "$days" ]]; then
  # Token only in the env: no date. Warns once; provider_auth in 24 h stays the real signal.
  if [[ ! -f "$WATCH/token.desconhecido" ]]; then
    send "token notice: the Claude token's expiry is unknown (register it in the panel to have the date)"
    [[ -n "$SIMULATE" ]] || touch "$WATCH/token.desconhecido"
  fi
  condition token 0 ""
else
  condition token "$(( days <= TOKEN_DAYS ))" "the Claude token expires in $days day(s)"
fi

# --- GPU ------------------------------------------------------------------------------------------
gpu_ok=1
nvidia-smi > /dev/null 2>&1 || gpu_ok=0
# The GPU worker recycles the process after the idle unload (#149): the heartbeat vanishes for a few
# seconds in a clean restart. Only its absence in two runs in a row counts; a failed nvidia-smi alerts at once.
no_hb=0
if [[ "$worker" == 0 ]]; then
  no_hb=$(( $(cat "$WATCH/gpu.rodadas" 2>/dev/null || echo 0) + 1 ))
fi
[[ -n "$SIMULATE" ]] || echo "$no_hb" > "$WATCH/gpu.rodadas"
[[ -n "$SIMULATE" && "$worker" == 0 ]] && no_hb=2
condition gpu "$(( gpu_ok == 0 || no_hb >= 2 ))" \
  "$([[ $gpu_ok == 0 ]] && echo 'nvidia-smi failed; ')$([[ $no_hb -ge 2 ]] && echo 'no GPU worker heartbeat')"
