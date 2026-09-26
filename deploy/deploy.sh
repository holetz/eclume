#!/usr/bin/env bash
# Deploy de produção do eclume no host GPU, pelo contexto Docker (build no daemon do host, sem
# registry) e por SSH para o que é do host (pastas, disco, cópia do env, scripts de backup e cron).
#
# Uso: bash deploy/deploy.sh [--plan] [--context NOME] [--services "server web worker-gpu"]
#                            [--sem-build] [--gerar-env]
#   --plan        só mostra o que faria (somente leitura).
#   --context     contexto Docker do host (padrão: $ECLUME_DOCKER_CONTEXT ou gpu-host).
#   --services    imagens a construir (padrão: server web worker-gpu). O up sobe sempre o stack todo.
#   --sem-build   não constrói nada; sobe as imagens que já estão no host.
#   --gerar-env   cria deploy/.env.prod com segredos aleatórios e sai.
# Runbook: docs/project/deploy-producao.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTEXT="${ECLUME_DOCKER_CONTEXT:-gpu-host}"
ENV_FILE=deploy/.env.prod
BUILD=(server web worker-gpu)
PLAN_ONLY=0
NO_BUILD=0
GEN_ENV=0
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"

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
    --help|-h) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
for service in "${BUILD[@]}"; do
  case "$service" in server|web|worker-gpu) ;; *) echo "Imagem inválida: $service" >&2; exit 2 ;; esac
done
[[ "$NO_BUILD" -eq 0 ]] || BUILD=()

# --- deploy/.env.prod ---------------------------------------------------------------------------
if [[ "$GEN_ENV" -eq 1 ]]; then
  [[ ! -e "$ENV_FILE" ]] || { echo "$ENV_FILE já existe; não sobrescrevo segredos." >&2; exit 2; }
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

# Contexto remoto: DOCKER_CONTEXT vale para todo docker/compose abaixo; DOCKER_HOST o venceria.
export DOCKER_CONTEXT="$CONTEXT"
unset DOCKER_HOST
endpoint="$(docker context inspect "$CONTEXT" --format '{{.Endpoints.docker.Host}}')"
SSH="${ECLUME_SSH:-${endpoint#ssh://}}"
[[ "$endpoint" == ssh://* || -n "${ECLUME_SSH:-}" ]] || {
  echo "O contexto $CONTEXT não é ssh:// ($endpoint); defina ECLUME_SSH=usuario@host." >&2; exit 2; }
host() { ssh -o BatchMode=yes "$SSH" "$@"; }

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
# Env anterior ao papel eclume_server (holetz/eclume#26): gera a senha dele, sem tocar no resto.
if [[ -f "$ENV_FILE" ]] && ! grep -q '^ECLUME_RUNTIME_PG_PASSWORD=' "$ENV_FILE"; then
  if [[ "$PLAN_ONLY" -eq 1 ]]; then
    echo "Aviso: $ENV_FILE sem ECLUME_RUNTIME_PG_PASSWORD; o deploy geraria uma." >&2
  else
    printf '\n# Papel eclume_server (conexão da aplicação), gerado pelo deploy.\nECLUME_RUNTIME_PG_PASSWORD=%s\n' \
      "$(openssl rand -hex 24)" >> "$ENV_FILE"
    echo "Gerada ECLUME_RUNTIME_PG_PASSWORD em $ENV_FILE." >&2
  fi
fi
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '=troque-' "$ENV_FILE" && [[ "$PLAN_ONLY" -eq 0 ]]; then
    echo "$ENV_FILE ainda tem valores 'troque-': gere segredos reais (--gerar-env)." >&2
    exit 2
  fi
  DATA_DIR="$(env_value ECLUME_DATA_DIR)"
  PUBLIC_URL="$(env_value ECLUME_PUBLIC_URL)"
  COMPOSE_ENV="$ENV_FILE"
else
  DATA_DIR=/srv/eclume
  PUBLIC_URL="?"
  COMPOSE_ENV=deploy/.env.prod.example
fi
DATA_DIR="${DATA_DIR:-/srv/eclume}"
COMPOSE=(docker compose -p eclume -f deploy/docker-compose.prod.yml --env-file "$COMPOSE_ENV")

disk_pct() { host "df --output=pcent / | tail -n 1 | tr -dc 0-9"; }

# --- plano ---------------------------------------------------------------------------------------
pct="$(disk_pct)"
echo "Daemon: contexto $CONTEXT · SSH: $SSH · dados: $DATA_DIR · URL: $PUBLIC_URL" >&2
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%)" >&2
echo "Construir: ${BUILD[*]:-nada (--sem-build)}" >&2
echo "Subir: postgres redis minio → minio-init, migrate → server worker-cpu worker-gpu web caddy → publish-ca" >&2
for image in eclume-server:prod eclume-web:prod eclume-worker-gpu:prod; do
  if docker image inspect "$image" >/dev/null 2>&1; then echo "  imagem $image: presente" >&2
  else echo "  imagem $image: ausente" >&2; fi
done
[[ "$PLAN_ONLY" -eq 0 ]] || exit 0

(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: acima de ${DISK_LIMIT}%, deploy recusado." >&2; exit 3; }

exec 9>deploy/.deploy.lock
flock -n 9 || { echo "Outro deploy está em execução." >&2; exit 3; }

# --- host: pastas, segredos, scripts de backup ----------------------------------------------------
echo "Preparando $DATA_DIR no host…" >&2
host "set -e
  mkdir -p '$DATA_DIR'/{pg,redis,minio,caddy/data,caddy/config,models,downloads,backups,bin}
  install -d -m 700 '$DATA_DIR/secrets'
  if [ ! -e '$DATA_DIR/secrets/hf_token' ]; then
    install -m 600 /dev/null '$DATA_DIR/secrets/hf_token'
    echo 'Aviso: sem token do Hugging Face ($DATA_DIR/secrets/hf_token vazio): transcrição sem diarização.' >&2
  fi"
if [[ -z "$(env_value ECLUME_CLAUDE_OAUTH_TOKEN)" ]]; then
  echo "Aviso: ECLUME_CLAUDE_OAUTH_TOKEN vazio em $ENV_FILE; o provider claude-cli vai falhar até o token (claude setup-token no host)." >&2
fi
host "umask 077; cat > '$DATA_DIR/secrets/env.prod'" < "$ENV_FILE"
host "cat > '$DATA_DIR/bin/backup.sh' && chmod 755 '$DATA_DIR/bin/backup.sh'" < deploy/backup.sh
host "cat > '$DATA_DIR/bin/restaurar-backup.sh' && chmod 755 '$DATA_DIR/bin/restaurar-backup.sh'" < deploy/restaurar-backup.sh
# Cron do usuário (sem linger, um timer systemd de usuário não rodaria fora de sessão).
host "(crontab -l 2>/dev/null | grep -v '# eclume-backup$' || true
  echo '30 3 * * * ECLUME_DATA_DIR=$DATA_DIR $DATA_DIR/bin/backup.sh >> $DATA_DIR/backups/backup.log 2>&1 # eclume-backup'
) | crontab -"

# --- build no daemon do host --------------------------------------------------------------------
export BUILDKIT_PROGRESS=plain COMPOSE_PROGRESS=plain
if [[ "${#BUILD[@]}" -gt 0 ]]; then
  echo "Construindo ${BUILD[*]} no host…" >&2
  "${COMPOSE[@]}" build "${BUILD[@]}"
  pct="$(disk_pct)"
  (( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}% depois do build: acima de ${DISK_LIMIT}%, parei antes do up." >&2; exit 3; }
fi

# --- subida ----------------------------------------------------------------------------------------
# One-shots fora do `--wait`: ele trata como falha a saída 0 de um serviço que nenhum outro espera.
echo "Subindo a infraestrutura…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 120 postgres redis minio
"${COMPOSE[@]}" run --rm minio-init
"${COMPOSE[@]}" run --rm migrate
echo "Subindo os serviços…" >&2
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 180 server worker-cpu worker-gpu web
# O compose não recria um container quando só o `configs.content` muda: o Caddy é sempre recriado,
# para o Caddyfile do checkout valer. A CA está no volume e sobrevive.
"${COMPOSE[@]}" up -d --no-build --force-recreate --wait --wait-timeout 60 caddy

# A CA nasce na primeira subida do Caddy; espera o arquivo e publica em /downloads/.
for _ in $(seq 1 15); do
  if "${COMPOSE[@]}" run --rm --no-deps publish-ca 2>/dev/null; then published=1; break; fi
  sleep 2
done
[[ "${published:-0}" -eq 1 ]] || echo "Aviso: a CA do Caddy não foi publicada em $DATA_DIR/downloads." >&2

# Imagens do eclume que o build deixou sem tag (as versões anteriores). Nada de outros projetos.
docker image prune -f --filter label=org.eclume.image >/dev/null

# --- conferência ----------------------------------------------------------------------------------
ca="$(mktemp)"
trap 'rm -f "$ca"' EXIT
host "cat '$DATA_DIR/downloads/eclume-root.crt'" > "$ca"
if curl -fsS --cacert "$ca" "$PUBLIC_URL/api/v1/health" >/dev/null; then
  echo "Deploy concluído: $PUBLIC_URL (health ok, disco $(disk_pct)%)." >&2
else
  echo "Deploy subiu, mas $PUBLIC_URL/api/v1/health falhou pela CA publicada." >&2
  exit 1
fi
