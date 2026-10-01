#!/usr/bin/env bash
# Deploy de produção do eclume no host GPU, pelo contexto Docker (build no daemon do host, sem
# registry) e por SSH para o que é do host (pastas, disco, cópia do env, scripts de backup e cron).
#
# Uso: bash deploy/deploy.sh [--plan] [--context NOME] [--services "server web worker-gpu"]
#                            [--sem-build] [--gerar-env] [--sem-gate "motivo"]
#                            [--fora-do-main "motivo"] [--voltar SHA] [--substituir-env]
#                            [--espera-gpu MINUTOS] [--interromper-gpu]
#   --plan            só mostra o que faria (somente leitura): SHA em produção e alvo, commits entre
#                     eles, migrations pendentes, env × host, GPU ocupada e o estado do gate.
#   --context         contexto Docker do host (padrão: $ECLUME_DOCKER_CONTEXT ou gpu-host).
#   --services        imagens a construir (padrão: server web worker-gpu). O up sobe sempre o stack todo.
#   --sem-build       não constrói nada; sobe as imagens que já estão no host.
#   --gerar-env       cria deploy/.env.prod com segredos aleatórios e sai (recusa se o host já tem um).
#   --sem-gate        dispensa só o status eclume/gate = success no HEAD (árvore limpa e commit no GitHub
#                     continuam exigidos) e deixa no commit o rastro eclume/gate-dispensa com o motivo.
#   --fora-do-main    aceita um HEAD fora de origin/main ou que não descende do SHA em produção; o
#                     motivo vai para o deploys.log.
#   --voltar SHA      sobe o trio de imagens retido daquele deploy, sem build e sem migrate.
#   --substituir-env  aceita um deploy/.env.prod que perde ou muda chave da cópia do host (que fica
#                     guardada em secrets/env.prod.<data>).
#   --espera-gpu      minutos de espera pela GPU ocupada antes de recusar (padrão 30).
#   --interromper-gpu com a GPU ainda ocupada ao fim da espera, para o worker-gpu mesmo assim.
# O build sai do `git archive` do SHA, nunca da árvore de trabalho. Runbook: docs/project/deploy-producao.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
ENV_FILE=deploy/.env.prod
BUILD=(server web worker-gpu)
IMAGES=(server web worker-gpu)
PLAN_ONLY=0
NO_BUILD=0
GEN_ENV=0
SEM_GATE=""
FORA_DO_MAIN=""
VOLTAR=""
SUBSTITUIR_ENV=0
ESPERA_GPU=30
INTERROMPER_GPU=0
REPO=holetz/eclume
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
RETIDOS="${ECLUME_DEPLOYS_RETIDOS:-3}"
PYTHON="$(command -v python3 || command -v python)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--dry-run) PLAN_ONLY=1; shift ;;
    --context)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--context exige o nome de um contexto Docker." >&2; exit 2; }
      CONTEXT="$2"; shift 2 ;;
    --services)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--services exige uma lista." >&2; exit 2; }
      read -r -a BUILD <<< "$2"; shift 2 ;;
    --sem-build) NO_BUILD=1; shift ;;
    --gerar-env) GEN_ENV=1; shift ;;
    --sem-gate)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--sem-gate exige o motivo." >&2; exit 2; }
      SEM_GATE="$2"; shift 2 ;;
    --fora-do-main)
      [[ $# -ge 2 && -n "${2// /}" ]] || { echo "--fora-do-main exige o motivo." >&2; exit 2; }
      FORA_DO_MAIN="$2"; shift 2 ;;
    --voltar)
      [[ $# -ge 2 && "$2" =~ ^[0-9a-f]{7,40}$ ]] || { echo "--voltar exige o SHA de um deploy retido." >&2; exit 2; }
      VOLTAR="$2"; shift 2 ;;
    --substituir-env) SUBSTITUIR_ENV=1; shift ;;
    --espera-gpu)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "--espera-gpu exige os minutos." >&2; exit 2; }
      ESPERA_GPU="$2"; shift 2 ;;
    --interromper-gpu) INTERROMPER_GPU=1; shift ;;
    --help|-h) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
for service in "${BUILD[@]}"; do
  case "$service" in server|web|worker-gpu) ;; *) echo "Imagem inválida: $service" >&2; exit 2 ;; esac
done
[[ "$NO_BUILD" -eq 0 && -z "$VOLTAR" ]] || BUILD=()

# Contexto remoto: DOCKER_CONTEXT vale para todo docker/compose abaixo; DOCKER_HOST o venceria.
export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "O contexto $CONTEXT não é ssh:// ($endpoint); defina ECLUME_SSH=usuario@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

# --- deploy/.env.prod ---------------------------------------------------------------------------
if [[ "$GEN_ENV" -eq 1 ]]; then
  [[ ! -e "$ENV_FILE" ]] || { echo "$ENV_FILE já existe; não sobrescrevo segredos." >&2; exit 2; }
  # Os segredos de produção já existem no host: gerar outros desligaria o banco e o bucket deles.
  if host 'test -s /srv/eclume/secrets/env.prod'; then
    echo "O host já tem /srv/eclume/secrets/env.prod: o deploy o restaura neste checkout; não gero outro." >&2
    exit 2
  fi
  umask 077
  sed -e "s|^ECLUME_PG_PASSWORD=.*|ECLUME_PG_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_RUNTIME_PG_PASSWORD=.*|ECLUME_RUNTIME_PG_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_MINIO_PASSWORD=.*|ECLUME_MINIO_PASSWORD=$(openssl rand -hex 24)|" \
      -e "s|^ECLUME_SECRET_KEY=.*|ECLUME_SECRET_KEY=$(openssl rand -hex 32)|" \
      -e "s|^ECLUME_ENCRYPTION_KEY=.*|ECLUME_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
      deploy/.env.prod.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Gerado $ENV_FILE (600). O deploy guarda a cópia em <ECLUME_DATA_DIR>/secrets/env.prod." >&2
  exit 0
fi

# --- gate: o que vai à produção é um commit publicado, limpo e provado ---------------------------
SHA="$(git rev-parse HEAD)"
problemas=()
if [[ -n "$VOLTAR" ]]; then
  # O retorno sobe imagens de um deploy anterior, que já passou pelo gate; o HEAD não importa.
  SHA="$(git rev-parse --verify --quiet "$VOLTAR^{commit}" || echo "$VOLTAR")"
  gate_ok=1
  gate="não se aplica (--voltar $SHA)"
else
  [[ -z "$(git status --porcelain)" ]] || problemas+=("a árvore de trabalho tem mudanças; o deploy sai do commit $SHA limpo")
  if gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null; then
    gate_ok=1
    gate="$(gh api "repos/$REPO/commits/$SHA/status" | python3 deploy/gate.py decidir)" || gate_ok=0
  else
    problemas+=("o commit $SHA não está no GitHub (faça o push antes)")
    gate_ok=0
    gate="eclume/gate sem leitura (commit fora do GitHub)"
  fi
  if [[ "$gate_ok" -eq 0 && -n "$SEM_GATE" ]]; then
    gate="$gate · dispensado: $SEM_GATE"
  elif [[ "$gate_ok" -eq 0 ]]; then
    problemas+=("$gate (rode bash deploy/gate.sh ou dispense com --sem-gate \"motivo\")")
  fi
fi

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  # A cópia de segurança do host vira a fonte quando o checkout não tem o env (outra máquina,
  # outra worktree).
  if host 'test -s /srv/eclume/secrets/env.prod'; then
    if [[ "$PLAN_ONLY" -eq 1 ]]; then
      echo "Aviso: falta $ENV_FILE; o deploy restauraria a cópia de /srv/eclume/secrets/env.prod." >&2
    else
      (umask 077; host 'cat /srv/eclume/secrets/env.prod' > "$ENV_FILE")
      echo "Restaurado $ENV_FILE da cópia do host." >&2
    fi
  elif [[ "$PLAN_ONLY" -eq 0 ]]; then
    echo "Falta $ENV_FILE: rode bash deploy/deploy.sh --gerar-env." >&2
    exit 2
  else
    echo "Aviso: falta $ENV_FILE (o deploy real recusa sem ele; --gerar-env)." >&2
  fi
fi
if [[ -f "$ENV_FILE" ]]; then
  DATA_DIR="$(env_value ECLUME_DATA_DIR)"
  PUBLIC_URL="$(env_value ECLUME_PUBLIC_URL)"
  COMPOSE_ENV="$ROOT/$ENV_FILE"
else
  DATA_DIR=/srv/eclume
  PUBLIC_URL="?"
  COMPOSE_ENV="$ROOT/deploy/.env.prod.example"
fi
DATA_DIR="${DATA_DIR:-/srv/eclume}"
LOG="$DATA_DIR/deploys.log"

work="$(mktemp -d)"
lock_dir="" ca=""
trap '[[ -z "$lock_dir" ]] || rmdir "$lock_dir"; rm -f "$ca"; rm -rf "$work"' EXIT

# --- o SHA: no origin/main e à frente do que está em produção -------------------------------------
host "cat '$LOG' 2>/dev/null || true" > "$work/deploys.log"
PROD_SHA="$(awk -F'\t' 'NF >= 6 { sha = $2 } END { print sha }' "$work/deploys.log")"
git fetch -q origin main 2>/dev/null || problemas+=("não consegui atualizar origin/main")
if [[ -z "$VOLTAR" ]]; then
  if ! git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
    [[ -n "$FORA_DO_MAIN" ]] || problemas+=("o commit $SHA não está em origin/main (ramo: --fora-do-main \"motivo\")")
  fi
  if [[ -n "$PROD_SHA" ]] && ! git merge-base --is-ancestor "$PROD_SHA" "$SHA" 2>/dev/null; then
    [[ -n "$FORA_DO_MAIN" ]] || problemas+=("o commit $SHA não descende do que está em produção ($PROD_SHA): retorno é --voltar, ramo é --fora-do-main")
  fi
fi

# --- env local × cópia do host, por chave (o valor do host nunca sai dele) -------------------------
env_diverge=""
if [[ -f "$ENV_FILE" ]] && host "test -s '$DATA_DIR/secrets/env.prod'"; then
  host "grep -E '^[A-Za-z_][A-Za-z0-9_]*=' '$DATA_DIR/secrets/env.prod' | while IFS= read -r line; do
      printf '%s\t%s\n' \"\${line%%=*}\" \"\$(printf '%s' \"\${line#*=}\" | sha256sum | cut -d' ' -f1)\"
    done" > "$work/env.host"
  env_diverge="$("$PYTHON" deploy/deploy_lib.py env-diverge "$work/env.host" "$ENV_FILE" | tr '\n' ' ' || true)"
  if [[ -n "$env_diverge" && "$SUBSTITUIR_ENV" -eq 0 ]]; then
    problemas+=("$ENV_FILE perde ou muda chave da cópia do host: ${env_diverge% } (confira; substituir é --substituir-env)")
  fi
fi

# Env anterior ao papel eclume_server (holetz/eclume#26): gera a senha dele, sem tocar no resto.
if [[ -f "$ENV_FILE" ]] && ! grep -q '^ECLUME_RUNTIME_PG_PASSWORD=' "$ENV_FILE"; then
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    echo "Aviso: $ENV_FILE sem ECLUME_RUNTIME_PG_PASSWORD; o deploy geraria uma." >&2
  elif [[ "${#problemas[@]}" -eq 0 ]]; then
    printf '\n# Papel eclume_server (conexão da aplicação), gerado pelo deploy.\nECLUME_RUNTIME_PG_PASSWORD=%s\n' \
      "$(openssl rand -hex 24)" >> "$ENV_FILE"
    echo "Gerada ECLUME_RUNTIME_PG_PASSWORD em $ENV_FILE." >&2
  fi
fi
if [[ -f "$ENV_FILE" ]] && grep -q '=troque-' "$ENV_FILE" && [[ "$PLAN_ONLY" -eq 0 ]]; then
  problemas+=("$ENV_FILE ainda tem valores 'troque-': gere segredos reais (--gerar-env)")
fi

# --- a árvore do SHA, num diretório temporário: compose, Dockerfiles e scripts são os dele ---------
if git cat-file -e "$SHA^{commit}" 2>/dev/null; then
  git archive "$SHA" | tar -x -C "$work" -f -
  TREE="$work"
  known_migrations="$(git ls-tree --name-only "$SHA" server/src/eclume_server/db/migrations/ \
    | sed -n 's|.*/\([0-9][0-9][0-9]_.*\)\.sql$|\1|p')"
else
  problemas+=("o commit $SHA não existe neste checkout (git fetch)")
  TREE="$ROOT"
  known_migrations=""
fi
export ECLUME_COMMIT="$SHA"
COMPOSE=(docker compose -p eclume -f "$TREE/deploy/docker-compose.prod.yml" --env-file "$COMPOSE_ENV")
service_id() { docker ps -q --filter label=com.docker.compose.project=eclume --filter "label=com.docker.compose.service=$1" | head -n 1; }

pg="$(service_id postgres)"
applied=""
[[ -z "$pg" ]] || applied="$(docker exec "$pg" psql -U eclume -d eclume -Atc 'select version from schema_migrations' 2>/dev/null || true)"
printf '%s\n' "$applied" | sed '/^$/d' | sort > "$work/banco"
printf '%s\n' "$known_migrations" | sed '/^$/d' | sort > "$work/alvo"
pending="$(comm -13 "$work/banco" "$work/alvo" | paste -sd, -)"
[[ -n "$pg" ]] || pending="(banco fora do ar: o migrate aplica o que faltar)"

gpu_busy() {
  local redis_id
  redis_id="$(service_id redis)"
  [[ -n "$redis_id" ]] || { echo 0; return; }
  docker exec "$redis_id" redis-cli --raw hget eclume:gpu:health busy 2>/dev/null | tr -dc 0-9 || echo 0
}
busy="$(gpu_busy)"

voltar_decisao=""
if [[ -n "$VOLTAR" ]]; then
  if voltar_decisao="$("$PYTHON" deploy/deploy_lib.py voltar "$work/deploys.log" "$SHA" "$work/banco" "$work/alvo" --retidos "$RETIDOS")"; then
    :
  else
    problemas+=("--voltar recusado: $voltar_decisao")
  fi
  for image in "${IMAGES[@]}"; do
    docker image inspect "eclume-$image:$SHA" >/dev/null 2>&1 || problemas+=("falta a imagem retida eclume-$image:$SHA")
  done
fi

disk_pct() { host "df --output=pcent / | tail -n 1 | tr -dc 0-9"; }

# --- plano ---------------------------------------------------------------------------------------
pct="$(disk_pct)"
echo "Alvo $SHA · gate: $gate" >&2
if [[ -n "$PROD_SHA" ]]; then
  if [[ -z "$VOLTAR" ]] && git cat-file -e "$PROD_SHA^{commit}" 2>/dev/null; then
    between="$(git rev-list --count "$PROD_SHA..$SHA" 2>/dev/null || echo '?')"
  else
    between="?"
  fi
  echo "Em produção: $PROD_SHA · commits até o alvo: $between" >&2
else
  echo "Em produção: sem registro em $LOG" >&2
fi
[[ -z "$FORA_DO_MAIN" ]] || echo "Fora do main: $FORA_DO_MAIN" >&2
[[ -z "$VOLTAR" ]] || echo "Voltar: $voltar_decisao" >&2
echo "Migrations pendentes: ${pending:-nenhuma}" >&2
if [[ -n "$env_diverge" ]]; then echo "Env × host: diverge em ${env_diverge% }" >&2; else echo "Env × host: igual por chave" >&2; fi
echo "GPU: $([[ "$busy" == 1 ]] && echo "ocupada (o deploy espera até ${ESPERA_GPU} min)" || echo livre)" >&2
for p in "${problemas[@]}"; do echo "  aviso: $p" >&2; done
echo "Daemon: contexto $CONTEXT · SSH: $SSH · dados: $DATA_DIR · URL: $PUBLIC_URL" >&2
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%)" >&2
echo "Construir: ${BUILD[*]:-nada}" >&2
echo "Subir: postgres redis minio → minio-init, migrate → server worker-cpu worker-agents worker-gpu web caddy → publish-ca → mdns" >&2
for image in "${IMAGES[@]}"; do
  if docker image inspect "eclume-$image:prod" >/dev/null 2>&1; then echo "  imagem eclume-$image:prod: presente" >&2
  else echo "  imagem eclume-$image:prod: ausente" >&2; fi
done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

# Recusa antes de escrever no host.
if [[ "${#problemas[@]}" -gt 0 ]]; then
  printf 'Deploy recusado:\n' >&2; printf '  - %s\n' "${problemas[@]}" >&2; exit 2
fi
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: acima de ${DISK_LIMIT}%, deploy recusado." >&2; exit 3; }
if [[ "$gate_ok" -eq 0 ]]; then
  gh api "repos/$REPO/statuses/$SHA" -f state=failure -f context=eclume/gate-dispensa \
    -f description="deploy: ${SEM_GATE:0:130}" --silent \
    || { echo "Não consegui publicar o rastro eclume/gate-dispensa; deploy recusado." >&2; exit 2; }
  echo "Gate dispensado: $SEM_GATE (rastro eclume/gate-dispensa no commit)." >&2
fi

# O Git Bash da estação Windows não tem flock: lá a trava é um diretório (mkdir é atômico).
if command -v flock >/dev/null; then
  exec 9>deploy/.deploy.lock
  flock -n 9 || { echo "Outro deploy está em execução." >&2; exit 3; }
else
  mkdir deploy/.deploy.lock.d 2>/dev/null || { echo "Outro deploy está em execução (ou sobrou deploy/.deploy.lock.d)." >&2; exit 3; }
  lock_dir=deploy/.deploy.lock.d
fi

# --- host: pastas, segredos, scripts de backup ----------------------------------------------------
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
echo "Preparando $DATA_DIR no host…" >&2
host "set -e
  mkdir -p '$DATA_DIR'/{pg,redis,minio,caddy/data,caddy/config,models,downloads,backups/pre-deploy,bin}
  install -d -m 700 '$DATA_DIR/secrets'
  if [ ! -e '$DATA_DIR/secrets/hf_token' ]; then
    install -m 600 /dev/null '$DATA_DIR/secrets/hf_token'
    echo 'Aviso: sem token do Hugging Face ($DATA_DIR/secrets/hf_token vazio): transcrição sem diarização.' >&2
  fi"
if [[ -n "$env_diverge" ]]; then
  host "cp -p '$DATA_DIR/secrets/env.prod' '$DATA_DIR/secrets/env.prod.$stamp'"
  echo "Env do host guardado em $DATA_DIR/secrets/env.prod.$stamp (--substituir-env)." >&2
fi
host "umask 077; cat > '$DATA_DIR/secrets/env.prod'" < "$ENV_FILE"
host "cat > '$DATA_DIR/bin/backup.sh' && chmod 755 '$DATA_DIR/bin/backup.sh'" < "$TREE/deploy/backup.sh"
host "cat > '$DATA_DIR/bin/restaurar-backup.sh' && chmod 755 '$DATA_DIR/bin/restaurar-backup.sh'" < "$TREE/deploy/restaurar-backup.sh"
# Cron do usuário (sem linger, um timer systemd de usuário não rodaria fora de sessão).
host "(crontab -l 2>/dev/null | grep -v '# eclume-backup$' || true
  echo '30 3 * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/backup.sh >> $DATA_DIR/backups/backup.log 2>&1 # eclume-backup'
) | crontab -"
# Verificador da produção (alertas) a cada 5 min; estado por condição em estado/vigia/.
host "install -d -m 700 '$DATA_DIR/estado' '$DATA_DIR/estado/vigia'
  cat > '$DATA_DIR/bin/vigia.sh' && chmod 755 '$DATA_DIR/bin/vigia.sh'" < "$TREE/deploy/vigia.sh"
host "(crontab -l 2>/dev/null | grep -v '# eclume-vigia$' || true
  echo '*/5 * * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/vigia.sh >> $DATA_DIR/estado/vigia/vigia.log 2>&1 # eclume-vigia'
) | crontab -"

# --- build no daemon do host, a partir da árvore do SHA --------------------------------------------
export BUILDKIT_PROGRESS=plain COMPOSE_PROGRESS=plain
if [[ "${#BUILD[@]}" -gt 0 ]]; then
  echo "Construindo ${BUILD[*]} de $SHA no host…" >&2
  "${COMPOSE[@]}" build "${BUILD[@]}"
  pct="$(disk_pct)"
  (( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}% depois do build: acima de ${DISK_LIMIT}%, parei antes do up." >&2; exit 3; }
fi
if [[ -n "$VOLTAR" ]]; then
  for image in "${IMAGES[@]}"; do docker tag "eclume-$image:$SHA" "eclume-$image:prod"; done
else
  # Cada deploy deixa um trio completo com a tag do SHA, construído ou não.
  for image in "${IMAGES[@]}"; do
    docker image inspect "eclume-$image:$SHA" >/dev/null 2>&1 || docker tag "eclume-$image:prod" "eclume-$image:$SHA"
  done
fi

# --- GPU: não mata transcrição em curso ------------------------------------------------------------
deadline=$(( $(date +%s) + ESPERA_GPU * 60 ))
while [[ "$(gpu_busy)" == 1 && "$(date +%s)" -lt "$deadline" ]]; do
  echo "GPU ocupada com uma transcrição; esperando (até ${ESPERA_GPU} min)…" >&2
  sleep 30
done
interrompeu=0
if [[ "$(gpu_busy)" == 1 ]]; then
  [[ "$INTERROMPER_GPU" -eq 1 ]] || {
    echo "A GPU seguiu ocupada por ${ESPERA_GPU} min: deploy recusado (--interromper-gpu para parar mesmo assim)." >&2; exit 3; }
  echo "Interrompendo o worker-gpu ocupado (--interromper-gpu)…" >&2
  "${COMPOSE[@]}" stop -t 10 worker-gpu
  interrompeu=1
fi

# --- subida ----------------------------------------------------------------------------------------
# One-shots fora do `--wait`: ele trata como falha a saída 0 de um serviço que nenhum outro espera.
echo "Subindo a infraestrutura…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 120 postgres redis minio
dump="-"
applied_now="-"
if [[ -z "$VOLTAR" ]]; then
  "${COMPOSE[@]}" run --rm minio-init
  pg="$(service_id postgres)"
  applied="$(docker exec "$pg" psql -U eclume -d eclume -Atc 'select version from schema_migrations' 2>/dev/null || true)"
  printf '%s\n' "$applied" | sed '/^$/d' | sort > "$work/banco"
  pending="$(comm -13 "$work/banco" "$work/alvo" | paste -sd, -)"
  if [[ -n "$pending" ]]; then
    # Antes de migration pendente, um dump do banco: o caminho de volta além de um passo.
    dump="$DATA_DIR/backups/pre-deploy/eclume-$stamp-${SHA:0:12}.dump"
    echo "Migrations pendentes ($pending): dump pré-deploy em $dump…" >&2
    host "set -e; umask 077; docker exec '$pg' pg_dump -U eclume -Fc eclume > '$dump.tmp' && mv '$dump.tmp' '$dump'"
    applied_now="$pending"
  fi
  "${COMPOSE[@]}" run --rm migrate
fi
echo "Subindo os serviços…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 180 server worker-cpu worker-agents worker-gpu web
# O compose não recria um container quando só o `configs.content` muda: o Caddy é sempre recriado,
# para o Caddyfile do SHA valer. A CA está no volume e sobrevive.
"${COMPOSE[@]}" up -d --no-build --force-recreate --wait --wait-timeout 60 caddy

# A CA nasce na primeira subida do Caddy; espera o arquivo e publica em /downloads/.
for _ in $(seq 1 15); do
  if "${COMPOSE[@]}" run --rm --no-deps publish-ca 2>/dev/null; then published=1; break; fi
  sleep 2
done
[[ "${published:-0}" -eq 1 ]] || echo "Aviso: a CA do Caddy não foi publicada em $DATA_DIR/downloads." >&2
# O anúncio mDNS (rede do host) nasce com a CA já publicada no TXT; recriado para valer o código novo.
"${COMPOSE[@]}" up -d --no-build --force-recreate --wait --wait-timeout 60 mdns

# --- histórico e retenção --------------------------------------------------------------------------
flags=()
[[ -z "$FORA_DO_MAIN" ]] || flags+=(--fora-do-main)
[[ -z "$VOLTAR" ]] || flags+=(--voltar)
[[ "$interrompeu" -eq 0 ]] || flags+=(--interromper-gpu)
[[ "$gate_ok" -eq 1 ]] || flags+=(--sem-gate)
[[ -z "$env_diverge" ]] || flags+=(--substituir-env)
motivo="${FORA_DO_MAIN:-${SEM_GATE:--}}"
entry="$(printf '%s\t%s\t%s\t%s\t%s\t%s' "$stamp" "$SHA" "$(IFS=,; echo "${flags[*]:--}")" "${motivo//$'\t'/ }" "$applied_now" "$dump")"
printf '%s\n' "$entry" | host "cat >> '$LOG'"
printf '%s\n' "$entry" >> "$work/deploys.log"
"$PYTHON" deploy/deploy_lib.py retidos "$work/deploys.log" "$RETIDOS" > "$work/retidos"
keep="$(sed -n 's/^manter\t//p' "$work/retidos")"
for image in "${IMAGES[@]}"; do
  for tag in $(docker image ls "eclume-$image" --format '{{.Tag}}' | grep -E '^[0-9a-f]{40}$' || true); do
    grep -qx "$tag" <<< "$keep" || docker image rm "eclume-$image:$tag" >/dev/null 2>&1 || true
  done
done
sed -n 's/^remover-dump\t//p' "$work/retidos" | while read -r old_dump; do host "rm -f '$old_dump'"; done
# Imagens do eclume que ficaram sem tag (as fora da janela). Nada de outros projetos.
docker image prune -f --filter label=org.eclume.image >/dev/null

# --- conferência ----------------------------------------------------------------------------------
ca="$(mktemp)"
host "cat '$DATA_DIR/downloads/eclume-root.crt'" > "$ca"
# O curl do Git Bash (Schannel) exige checar revogação, e a CA interna do Caddy não publica CRL.
revoke=(); curl -V | grep -q Schannel && revoke=(--ssl-no-revoke)
health="$(curl -fsS "${revoke[@]}" --cacert "$ca" "$PUBLIC_URL/api/v1/health" || true)"
if [[ -z "$health" ]]; then
  echo "Deploy subiu, mas $PUBLIC_URL/api/v1/health falhou pela CA publicada." >&2
  exit 1
fi
# Com o server construído agora (ou retido, no --voltar), o /health diz este SHA.
if [[ -n "$VOLTAR" || " ${BUILD[*]} " == *" server "* ]] && [[ "$health" != *"\"commit\":\"$SHA\""* ]]; then
  echo "Deploy subiu, mas $PUBLIC_URL/api/v1/health não diz o commit $SHA ($health)." >&2
  exit 1
fi
# O descritor tem de trazer a impressão digital da CA publicada (a que o mDNS e o QR anunciam).
fingerprint="$(openssl x509 -in "$ca" -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
descriptor="$(curl -fsS "${revoke[@]}" --cacert "$ca" "$PUBLIC_URL/api/v1/server" || true)"
if [[ "$descriptor" != *"\"ca_sha256\":\"$fingerprint\""* ]]; then
  echo "Deploy subiu, mas $PUBLIC_URL/api/v1/server não traz a impressão digital $fingerprint." >&2
  exit 1
fi
echo "Deploy concluído: $SHA em $PUBLIC_URL (health e descritor ok, CA $fingerprint, disco $(disk_pct)%)." >&2
