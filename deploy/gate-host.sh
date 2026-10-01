#!/usr/bin/env bash
# Gate de qualidade do eclume, a parte que roda no host GPU a partir da árvore extraída do
# `git archive` do commit (deploy/gate.sh a envia e chama este script). Roda os sete pilares de
# deploy/pilares.sh, cada um num contêiner da imagem eclume-gate:24.04 (CPU, memória e prioridade
# limitadas, uid 1000, sem socket do Docker nem token do gh), contra os serviços de teste e o mock
# do projeto compose eclume-gate, e publica o resultado no commit como status `eclume/gate`.
# Contrato: docs/standards/code/monorepo.md.
#
# Uso: bash <árvore>/deploy/gate-host.sh --sha <sha> [--pilares a,b]
#   --pilares  roda só esses pilares e não publica status (execução parcial).
# Variáveis: ECLUME_DISK_LIMIT (90), ECLUME_GATE_MEMORY (teto por contêiner),
#            ECLUME_GATE_DIR (~/eclume-gate).
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"

REPO=holetz/eclume
CONTEXTO=eclume/gate
GATE_DIR="${ECLUME_GATE_DIR:-$HOME/eclume-gate}"
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
MEMORIA="${ECLUME_GATE_MEMORY:-6g}"
NDK="${ECLUME_GATE_NDK:-$HOME/android-sdk/ndk/28.2.13676358}"
PROJETO=eclume-gate
IMG=eclume-gate:24.04
SHA=""
PILARES_PEDIDOS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:?--sha exige o commit}"; shift 2 ;;
    --pilares) PILARES_PEDIDOS="${2:?--pilares exige a lista}"; shift 2 ;;
    *) echo "Flag desconhecida: $1" >&2; exit 2 ;;
  esac
done
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "--sha exige o SHA completo do commit." >&2; exit 2; }

mapfile -t TODOS < <(bash deploy/pilares.sh --lista)
if [[ -n "$PILARES_PEDIDOS" ]]; then
  IFS=, read -r -a PILARES <<< "$PILARES_PEDIDOS"
  PUBLICAR=0
else
  PILARES=("${TODOS[@]}")
  PUBLICAR=1
fi

CACHE="$GATE_DIR/cache"
LOG="$GATE_DIR/logs/$SHA.log"
mkdir -p "$CACHE/registry" "$CACHE/home" "$GATE_DIR/logs"

# Uma execução por vez no host; a segunda espera a primeira.
exec 9>"$GATE_DIR/.trava"
echo "Aguardando a trava $GATE_DIR/.trava…" >&2
flock 9

[[ "$PUBLICAR" -eq 0 ]] || exec > >(tee "$LOG") 2>&1
echo "Gate de $SHA · pilares: ${PILARES[*]} · $(date -Is)"

# Publica o status pelo gh do host, tentando até o commit existir no GitHub (o hook de pre-push
# dispara o gate antes de o push terminar). Sem conseguir em 30 minutos, o resultado fica no log.
publicado=0
publicar() {
  local estado="$1" descricao="$2" prazo=$((SECONDS + 1800))
  [[ "$PUBLICAR" -eq 1 ]] || return 0
  until gh api "repos/$REPO/statuses/$SHA" -f state="$estado" -f context="$CONTEXTO" \
      -f description="$descricao" --silent 2>/dev/null; do
    if (( SECONDS >= prazo )); then
      echo "Não consegui publicar $CONTEXTO = $estado em 30 minutos; o resultado fica neste log."
      return 0
    fi
    sleep 15
  done
  echo "Publicado $CONTEXTO = $estado: $descricao"
}

compose() {
  ECLUME_TEST_PG_PORT=55632 ECLUME_TEST_REDIS_PORT=56579 ECLUME_TEST_MINIO_PORT=59200 \
    ECLUME_MOCK_BIND=127.0.0.1 ECLUME_MOCK_PORT=4210 \
    docker compose -p "$PROJETO" -f deploy/docker-compose.test.yml -f deploy/docker-compose.mock.yml "$@"
}

final() {
  local codigo=$?
  if [[ "$PUBLICAR" -eq 1 && "$publicado" -eq 0 ]]; then
    publicar error "o gate não conseguiu provar (saída $codigo) · log $LOG"
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  cd / && rm -rf "$SRC"
}
trap final EXIT

publicar pending "rodando ${#PILARES[@]} pilares · log $LOG"

pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%) · teto de memória por pilar: $MEMORIA"
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: gate recusado."; exit 3; }

# --- imagens: as de base do release, se faltarem, e a do gate (camadas em cache) ------------------
export BUILDKIT_PROGRESS=plain
docker image inspect eclume-desktop-build:24.04 >/dev/null 2>&1 \
  || docker build -q -t eclume-desktop-build:24.04 - < desktop/build.Dockerfile
docker image inspect eclume-desktop-build-windows:24.04 >/dev/null 2>&1 \
  || docker build -q -t eclume-desktop-build-windows:24.04 - < desktop/build-windows.Dockerfile
docker build -q -t "$IMG" - < deploy/gate.Dockerfile

# --- serviços: Postgres, Redis, MinIO e o mock, na rede do projeto --------------------------------
compose up -d --wait

declare -A RESULTADO=()
inicio=$SECONDS
for pilar in "${PILARES[@]}"; do
  echo "=== pilar $pilar · $(date -Is) ==="
  mkdir -p "$CACHE/target-$pilar"
  t0=$SECONDS
  set +e
  docker run --rm --name "$PROJETO-$pilar" --network "${PROJETO}_default" \
    --cpus 2 --memory "$MEMORIA" --memory-swap "$MEMORIA" --shm-size 1g -u 1000:1000 \
    -e HOME=/tmp -e CI=1 -e CARGO_BUILD_JOBS=2 -e CARGO_TARGET_DIR=/target \
    -e npm_config_cache=/tmp/.cache/npm -e UV_PYTHON_INSTALL_DIR=/tmp/.cache/uv-python \
    -e UV_LINK_MODE=copy -e ANDROID_NDK_LATEST_HOME=/opt/ndk \
    -e ECLUME_TEST_DATABASE_URL=postgresql+asyncpg://eclume:eclume@postgres:5432/eclume \
    -e ECLUME_TEST_REDIS_URL=redis://redis:6379 -e ECLUME_TEST_S3_ENDPOINT=http://minio:9000 \
    -e ECLUME_MOCK_URL=http://mock:4010 \
    -v "$SRC:/src" -v "$CACHE/target-$pilar:/target" -v "$CACHE/registry:/opt/cargo/registry" \
    -v "$CACHE/home:/tmp/.cache" -v "$NDK:/opt/ndk:ro" \
    -w /src "$IMG" nice -n 10 bash deploy/pilares.sh "$pilar"
  RESULTADO[$pilar]=$?
  set -e
  echo "=== pilar $pilar: saída ${RESULTADO[$pilar]} em $((SECONDS - t0))s ==="
done

resultados=""
for pilar in "${PILARES[@]}"; do resultados+="$pilar ${RESULTADO[$pilar]}"$'\n'; done
echo "Resultado:"; printf '%s' "$resultados"

if [[ "$PUBLICAR" -eq 0 ]]; then
  publicado=1
  for pilar in "${PILARES[@]}"; do [[ "${RESULTADO[$pilar]}" -eq 0 ]] || exit 1; done
  exit 0
fi
mapfile -t saida < <(printf '%s' "$resultados" | python3 deploy/gate.py descricao --duracao "$((SECONDS - inicio))" --log "$LOG")
publicar "${saida[0]}" "${saida[1]}"
publicado=1
[[ "${saida[0]}" == success ]]
