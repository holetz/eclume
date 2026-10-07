#!/usr/bin/env bash
# Verificador da produção, rodado NO HOST pelo cron do usuário dono de /srv/eclume a cada 5 min (o
# deploy.sh instala este script em <ECLUME_DATA_DIR>/bin/ e a linha `# eclume-vigia` no crontab).
#
#   <ECLUME_DATA_DIR>/bin/vigia.sh [--simular]
#
# Condições (uma chave cada, estado em <ECLUME_DATA_DIR>/estado/vigia/):
#   disco      uso do disco de ECLUME_DATA_DIR >= VIGIA_DISCO_PCT (85)
#   backup     estado/backup.json sem `ok` há mais de VIGIA_BACKUP_HORAS (26) h (sem o json, a
#   fora      última linha `ok:` do backups/backup.log); fora e ensaio só com estado/fora.json e
#   ensaio     estado/ensaio.json
#   conteiner  contêiner do projeto eclume unhealthy, reiniciando ou parado em duas rodadas seguidas
#   fila       job da GPU `queued` há mais de 2 h (eclume-server saude --json)
#   falhas     3 ou mais falhas em 24 h, ou qualquer `provider_auth`
#   token      token do Claude vencendo em VIGIA_TOKEN_DIAS (30) dias ou menos; validade
#              desconhecida avisa uma vez só
#   gpu        nvidia-smi falhando ou heartbeat do worker GPU ausente em duas rodadas seguidas (o
#              reinício limpo do reciclo ocioso, #149, apaga o heartbeat por alguns segundos)
#   saude      `eclume-server saude --json` sem resposta (server fora)
# Cada alerta sai uma vez, repete a cada VIGIA_REPETIR_HORAS (6) h enquanto durar e manda aviso de
# volta ao normal. --simular imprime o que mandaria, sem mandar nem gravar estado.
# Envio: enquanto o canal não é decidido (secrets/alerta.env), a mensagem vai para
# estado/vigia/alertas.log e para o syslog (`logger -t eclume-vigia`).
set -euo pipefail
DATA_DIR="${ECLUME_DATA_DIR:-/srv/eclume}"
ESTADO="$DATA_DIR/estado"
VIGIA="$ESTADO/vigia"
DISCO_PCT="${VIGIA_DISCO_PCT:-85}"
BACKUP_HORAS="${VIGIA_BACKUP_HORAS:-26}"
TOKEN_DIAS="${VIGIA_TOKEN_DIAS:-30}"
REPETIR_S=$(( ${VIGIA_REPETIR_HORAS:-6} * 3600 ))
# Serviços de uma execução só: saem com 0 e ficam parados de propósito.
UMA_VEZ=" migrate minio-init publish-ca "
SIMULAR=""
[[ "${1:-}" == "--simular" ]] && SIMULAR=1
agora="$(date +%s)"
umask 077
[[ -n "$SIMULAR" ]] || mkdir -p "$VIGIA"

enviar() {
  local msg="eclume ($(hostname)): $1"
  if [[ -n "$SIMULAR" ]]; then
    echo "[simulado] $msg"
    return
  fi
  echo "$(date '+%F %T') $msg" >> "$VIGIA/alertas.log"
  logger -t eclume-vigia -- "$msg" 2>/dev/null || true
}

# condicao <chave> <ativa: 1|0> <mensagem>: alerta na primeira vez, repete a cada REPETIR_S, avisa a volta.
condicao() {
  local chave="$1" ativa="$2" msg="$3" marca="$VIGIA/$1.alerta"
  if [[ "$ativa" == 1 ]]; then
    if [[ -n "$SIMULAR" ]]; then
      enviar "ALERTA $chave: $msg"
    elif [[ ! -f "$marca" ]] || (( agora - $(cat "$marca") >= REPETIR_S )); then
      enviar "ALERTA $chave: $msg"
      echo "$agora" > "$marca"
    fi
  elif [[ -f "$marca" ]]; then
    [[ -n "$SIMULAR" ]] && { enviar "normal $chave"; return; }
    enviar "normal $chave: voltou ao normal"
    rm -f "$marca"
  fi
}

container() {
  docker ps -q --filter label=com.docker.compose.project=eclume \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# --- disco --------------------------------------------------------------------------------------
pct="$(df --output=pcent "$DATA_DIR" | tail -n 1 | tr -dc 0-9)"
condicao disco "$(( pct >= DISCO_PCT ))" "disco de $DATA_DIR em ${pct}% (limite ${DISCO_PCT}%)"

# --- backup, cópia fora do host e ensaio ---------------------------------------------------------
# Idade em horas do último `ok`: o json da etapa (#91) se existir; sem ele, a linha `ok:` do log.
idade_ok() {
  local json="$ESTADO/$1.json"
  if [[ -f "$json" ]]; then
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$json" || { echo falhou; return; }
    echo $(( (agora - $(stat -c %Y "$json")) / 3600 ))
  elif [[ "$1" == backup ]]; then
    local linha
    linha="$(grep ' ok: ' "$DATA_DIR/backups/backup.log" 2>/dev/null | tail -n 1 | cut -c1-19)"
    [[ -n "$linha" ]] || { echo nunca; return; }
    echo $(( (agora - $(date -d "$linha" +%s)) / 3600 ))
  fi
}
for etapa in backup fora ensaio; do
  idade="$(idade_ok "$etapa")"
  [[ -z "$idade" ]] && continue
  case "$idade" in
    falhou) condicao "$etapa" 1 "última rodada de $etapa terminou sem ok" ;;
    nunca) condicao "$etapa" 1 "nenhum $etapa com ok registrado" ;;
    *) condicao "$etapa" "$(( idade > BACKUP_HORAS ))" "último $etapa com ok há ${idade} h" ;;
  esac
done

# --- contêineres: duas rodadas seguidas -----------------------------------------------------------
ruins=""
while read -r servico estado status; do
  [[ -z "$servico" ]] && continue
  if [[ "$estado" == restarting || "$status" == *"(unhealthy)"* ]]; then
    ruins+=" $servico($estado)"
  elif [[ "$estado" == exited || "$estado" == dead ]] && [[ "$UMA_VEZ" != *" $servico "* || "$status" != "Exited (0)"* ]]; then
    ruins+=" $servico($estado)"
  fi
done < <(docker ps -a --filter label=com.docker.compose.project=eclume \
  --format '{{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}')
seguidas=0
if [[ -n "$ruins" ]]; then
  seguidas=$(( $(cat "$VIGIA/conteiner.rodadas" 2>/dev/null || echo 0) + 1 ))
fi
[[ -n "$SIMULAR" ]] || echo "$seguidas" > "$VIGIA/conteiner.rodadas"
[[ -n "$SIMULAR" && -n "$ruins" ]] && seguidas=2
condicao conteiner "$(( seguidas >= 2 ))" "contêineres com problema:${ruins}"

# --- números da aplicação (a mesma Saúde do admin) --------------------------------------------------
server="$(container server)"
saude=""
[[ -n "$server" ]] && saude="$(docker exec "$server" eclume-server saude --json 2>/dev/null || true)"
if [[ -z "$saude" ]]; then
  condicao saude 1 "eclume-server saude --json sem resposta (server fora?)"
  exit 0
fi
condicao saude 0 ""
# Uma linha de campos separados por |: fila, falhas, provider_auth, dias do token, worker GPU.
IFS='|' read -r fila falhas auth dias worker < <(python3 -c '
import json, sys
r = json.load(sys.stdin)
s, tok = r["summary"], r["claude_token"]
dias = "" if tok.get("days_left") is None else tok["days_left"]
print(s["queued_over_2h"], s["failed_last_24h"], s["provider_auth_last_24h"], dias,
      1 if r["health"].get("worker") else 0, sep="|")
' <<< "$saude")
condicao fila "$(( fila > 0 ))" "$fila job(s) da GPU na fila há mais de 2 h"
condicao falhas "$(( falhas >= 3 || auth > 0 ))" "$falhas falha(s) em 24 h, $auth de provider_auth"
if [[ -z "$dias" ]]; then
  # Token só no env: sem data. Avisa uma vez; o provider_auth em 24 h segue como o sinal real.
  if [[ ! -f "$VIGIA/token.desconhecido" ]]; then
    enviar "aviso token: validade do token do Claude desconhecida (cadastre-o no painel para ter a data)"
    [[ -n "$SIMULAR" ]] || touch "$VIGIA/token.desconhecido"
  fi
  condicao token 0 ""
else
  condicao token "$(( dias <= TOKEN_DIAS ))" "token do Claude vence em $dias dia(s)"
fi

# --- GPU ------------------------------------------------------------------------------------------
gpu_ok=1
nvidia-smi > /dev/null 2>&1 || gpu_ok=0
# O worker GPU recicla o processo após a descarga ociosa (#149): o heartbeat some por alguns segundos
# num reinício limpo. Só a ausência em duas rodadas seguidas conta; o nvidia-smi falho alerta já.
sem_hb=0
if [[ "$worker" == 0 ]]; then
  sem_hb=$(( $(cat "$VIGIA/gpu.rodadas" 2>/dev/null || echo 0) + 1 ))
fi
[[ -n "$SIMULAR" ]] || echo "$sem_hb" > "$VIGIA/gpu.rodadas"
[[ -n "$SIMULAR" && "$worker" == 0 ]] && sem_hb=2
condicao gpu "$(( gpu_ok == 0 || sem_hb >= 2 ))" \
  "$([[ $gpu_ok == 0 ]] && echo 'nvidia-smi falhou; ')$([[ $sem_hb -ge 2 ]] && echo 'sem heartbeat do worker GPU')"
