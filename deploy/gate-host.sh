#!/usr/bin/env bash
# Gate de qualidade do eclume, a parte que roda no host GPU a partir da árvore extraída do
# `git archive` do commit (deploy/gate.sh a envia e chama este script). Roda os pilares de
# deploy/pilares.sh, cada um num contêiner da imagem eclume-gate:<Rust> (CPU, memória e prioridade
# limitadas, uid 1000, sem socket do Docker nem token do gh), contra os serviços de teste e o mock
# do projeto compose eclume-gate, e publica o resultado no commit como status `eclume/gate`.
# Contrato: docs/standards/code/monorepo.md.
#
# Os pilares são os que o diff desde o último SHA verde do histórico exige (mapa de caminhos em
# deploy/gate.py, o mesmo dos filtros da CI); os outros ficam dispensados e o status diz quais. Sem
# SHA verde encontrável (primeira execução, histórico reescrito), roda todos.
#
# Um gate que o hook de pre-push dispara (`--superavel`) sai sem rodar quando o `main` já avançou
# além do SHA (publica `eclume/gate` = error "superado por <sha>"; o deploy usa a ponta); um gate
# pedido à mão para um SHA nunca é abandonado.
# Todo contêiner do gate leva `--cpu-shares 256`: a produção divide o host com o gate e vence a CPU.
# A cada execução, poda logs com mais de 30 dias, imagens de build de versões antigas do Rust e
# árvores `src-*` abandonadas.
#
# Uso: bash <árvore>/deploy/gate-host.sh --sha <sha> [--pilares a,b] [--todos] [--superavel]
#   --pilares  roda só esses pilares e não publica status (execução parcial).
#   --superavel  abandona o SHA se o `main` já passou dele (o pre-push usa; o pedido à mão não).
#   --todos    publica o status rodando todos os pilares, sem olhar o diff.
# Variáveis: ECLUME_DISK_LIMIT (90), ECLUME_GATE_MEMORY (teto por contêiner, 4g),
#            ECLUME_GATE_CACHE_GB (orçamento dos caches, 25), ECLUME_GATE_DIR (~/eclume-gate).
# Medido em 2026-10-01 (holetz/eclume#89), com a produção de pé: 16 a 21 minutos; pico de memória
# de ~2,6 GiB (windows e desktop, no link), ~1,7 GiB no web-browser e < 1 GiB nos outros; ~15 GB de
# caches depois de duas execuções.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"

REPO=holetz/eclume
CONTEXTO=eclume/gate
GATE_DIR="${ECLUME_GATE_DIR:-$HOME/eclume-gate}"
DISK_LIMIT="${ECLUME_DISK_LIMIT:-90}"
MEMORIA="${ECLUME_GATE_MEMORY:-4g}"
CACHE_GB="${ECLUME_GATE_CACHE_GB:-25}"
NDK="${ECLUME_GATE_NDK:-$HOME/android-sdk/ndk/28.2.13676358}"
# O SDK e o JDK do mobile/scripts/android-sdk.sh, só leitura, para o pilar android.
ANDROID_SDK="${ECLUME_GATE_ANDROID_SDK:-$HOME/android-sdk}"
JDK="${ECLUME_GATE_JDK:-$HOME/jdk-21}"
PROJETO=eclume-gate
# As imagens levam na tag a versão do Rust de desktop/rust-toolchain.toml.
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml)"
IMG="eclume-gate:$RUST"
SHA=""
PILARES_PEDIDOS=""
FORCAR_TODOS=0
SUPERAVEL=0
CPU_SHARES=256

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="${2:?--sha exige o commit}"; shift 2 ;;
    --pilares) PILARES_PEDIDOS="${2:?--pilares exige a lista}"; shift 2 ;;
    --todos) FORCAR_TODOS=1; shift ;;
    --superavel) SUPERAVEL=1; shift ;;
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
DISPENSADOS=()
DESDE=""

CACHE="$GATE_DIR/cache"
LOG="$GATE_DIR/logs/$SHA.log"
mkdir -p "$CACHE/registry" "$CACHE/home" "$CACHE/gradle" "$GATE_DIR/logs"

# Uma execução por vez no host; a segunda espera a primeira.
exec 9>"$GATE_DIR/.trava"
echo "Aguardando a trava $GATE_DIR/.trava…" >&2
flock 9

[[ "$PUBLICAR" -eq 0 ]] || exec > >(tee "$LOG") 2>&1
echo "Gate de $SHA · $(date -Is)"

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

# O peso de CPU dos serviços de teste e do mock entra por um arquivo extra, sem mexer nos compose
# que a CI também usa.
CPU_YML="$GATE_DIR/cpu-shares.yml"
printf 'services:\n' > "$CPU_YML"
for servico in postgres redis minio mock; do
  printf '  %s:\n    cpu_shares: %s\n' "$servico" "$CPU_SHARES" >> "$CPU_YML"
done
compose() {
  ECLUME_TEST_PG_PORT=55632 ECLUME_TEST_REDIS_PORT=56579 ECLUME_TEST_MINIO_PORT=59200 \
    ECLUME_MOCK_BIND=127.0.0.1 ECLUME_MOCK_PORT=4210 \
    docker compose -p "$PROJETO" -f deploy/docker-compose.test.yml -f deploy/docker-compose.mock.yml \
    -f "$CPU_YML" "$@"
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

# Um gate disparado pelo pre-push que o `main` já ultrapassou não roda: o tip tem o seu próprio gate
# (e o diff dele desde o último verde cobre este SHA). Tip igual, atrás, divergente ou ilegível (o
# push ainda em curso) não abandona nada.
if [[ "$SUPERAVEL" -eq 1 && "$PUBLICAR" -eq 1 ]]; then
  ponta="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha 2>/dev/null || true)"
  if [[ -n "$ponta" && "$ponta" != "$SHA" ]] \
      && [[ "$(gh api "repos/$REPO/compare/$SHA...$ponta" --jq .status 2>/dev/null || true)" == ahead ]]; then
    publicar error "superado por ${ponta:0:7}"
    publicado=1
    exit 0
  fi
fi

# O SHA verde mais próximo no histórico de $1 (o status `eclume/gate` em success); vazio se não achar.
ultimo_verde() {
  local c
  while read -r c; do
    [[ "$c" != "$1" ]] || continue
    if gh api "repos/$REPO/commits/$c/status" 2>/dev/null | python3 deploy/gate.py decidir >/dev/null; then
      echo "$c"; return 0
    fi
  done < <(gh api "repos/$REPO/commits?sha=$1&per_page=30" --jq '.[].sha' 2>/dev/null)
}

# Os pilares exigidos pelo diff do último SHA verde até o SHA, decididos depois da trava (a execução
# anterior pode ter acabado de publicar um verde mais novo). Qualquer falha em saber o diff roda todos.
if [[ "$PUBLICAR" -eq 1 && "$FORCAR_TODOS" -eq 0 ]]; then
  # O hook dispara o gate antes de o push chegar ao GitHub: sem o commit lá, o histórico não acha o
  # verde e rodaria todos.
  for _ in $(seq 1 20); do
    gh api "repos/$REPO/commits/$SHA" --silent 2>/dev/null && break
    sleep 15
  done
  verde="$(ultimo_verde "$SHA" || true)"
  if [[ -z "$verde" ]]; then
    echo "Sem SHA verde no histórico de $SHA: rodando todos os pilares."
  elif arquivos="$(gh api "repos/$REPO/compare/$verde...$SHA" --paginate \
      --jq '.files[] | .filename, (.previous_filename // empty)' 2>/dev/null)" \
      && exigidos_txt="$(printf '%s\n' "$arquivos" | python3 deploy/gate.py pilares --stdin)"; then
    mapfile -t exigidos <<< "$exigidos_txt"
    [[ -n "${exigidos[0]:-}" ]] || exigidos=()
    # O compare do GitHub lista no máximo 300 arquivos: a partir daí o diff pode estar truncado.
    if (( $(printf '%s\n' "$arquivos" | grep -c .) >= 300 )); then
      echo "Diff de $verde a $SHA grande demais para listar: rodando todos os pilares."
    else
      PILARES=("${exigidos[@]}")
      DESDE="$verde"
      for p in "${TODOS[@]}"; do
        [[ " ${PILARES[*]} " == *" $p "* ]] || DISPENSADOS+=("$p")
      done
      echo "Diff desde o último verde $verde: exigidos ${PILARES[*]:-nenhum}; dispensados ${DISPENSADOS[*]:-nenhum}."
    fi
  else
    echo "Não consegui o diff de $verde a $SHA: rodando todos os pilares."
  fi
fi
echo "Pilares: ${PILARES[*]:-nenhum}"

publicar pending "rodando ${#PILARES[@]} pilares · log $LOG"

# --- poda: o que o gate deixa para trás ----------------------------------------------------------
find "$GATE_DIR/logs" -name '*.log' -mtime +30 -delete 2>/dev/null || true
find "$GATE_DIR" -maxdepth 1 -name 'src-*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
# Imagens de build de versões antigas do Rust (sem a atual); as em uso o docker recusa remover.
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E '^eclume-(gate|desktop-build|desktop-build-windows|mobile-build):' \
  | grep -vF ":$RUST" | xargs -r docker rmi >/dev/null 2>&1 || true

pct="$(df --output=pcent / | tail -n 1 | tr -dc 0-9)"
echo "Disco do host: ${pct}% (limite ${DISK_LIMIT}%) · teto de memória por pilar: $MEMORIA"
(( pct < DISK_LIMIT )) || { echo "Disco do host em ${pct}%: gate recusado."; exit 3; }
# Orçamento dos caches: acima dele, os target/ do cargo (a maior parte) recomeçam do zero.
cache_gb="$(du -s --block-size=1G "$CACHE" | cut -f1)"
if (( cache_gb > CACHE_GB )); then
  echo "Caches em ${cache_gb} GB, acima de ${CACHE_GB} GB: apagando os target/ do cargo."
  rm -rf "$CACHE"/target-*
fi

declare -A RESULTADO=()
inicio=$SECONDS
if (( ${#PILARES[@]} > 0 )); then
# --- imagens: as de base do release, se faltarem, e a do gate (camadas em cache) ------------------
export BUILDKIT_PROGRESS=plain
docker image inspect "eclume-desktop-build:$RUST" >/dev/null 2>&1 \
  || docker build -q -t "eclume-desktop-build:$RUST" -f desktop/build.Dockerfile desktop
docker image inspect "eclume-desktop-build-windows:$RUST" >/dev/null 2>&1 \
  || docker build -q --build-arg "RUST=$RUST" -t "eclume-desktop-build-windows:$RUST" - < desktop/build-windows.Dockerfile
docker build -q --build-arg "RUST=$RUST" -t "$IMG" - < deploy/gate.Dockerfile

# --- serviços: Postgres, Redis, MinIO e o mock, na rede do projeto --------------------------------
compose up -d --wait

for pilar in "${PILARES[@]}"; do
  echo "=== pilar $pilar · $(date -Is) ==="
  mkdir -p "$CACHE/target-$pilar"
  # O mock só para os pilares que o têm na CI: com ECLUME_MOCK_URL, o teste do eclume-sync no
  # desktop deixaria de pular e as URLs de parte das fixtures (127.0.0.1:4010) não chegam ao mock.
  mock=()
  case "$pilar" in contracts|web-browser) mock=(-e ECLUME_MOCK_URL=http://mock:4010) ;; esac
  t0=$SECONDS
  set +e
  docker run --rm --name "$PROJETO-$pilar" --network "${PROJETO}_default" \
    --cpus 2 --cpu-shares "$CPU_SHARES" --memory "$MEMORIA" --memory-swap "$MEMORIA" --shm-size 1g -u 1000:1000 \
    -e HOME=/tmp -e CI=1 -e CARGO_BUILD_JOBS=2 -e CARGO_TARGET_DIR=/target \
    -e npm_config_cache=/tmp/.cache/npm -e UV_PYTHON_INSTALL_DIR=/tmp/.cache/uv-python \
    -e UV_LINK_MODE=copy -e ECLUME_ANDROID_NDK=/opt/ndk \
    -e ECLUME_ANDROID_SDK=/opt/android-sdk -e ECLUME_ANDROID_JDK=/opt/jdk -e GRADLE_USER_HOME=/opt/gradle \
    -e ECLUME_TEST_DATABASE_URL=postgresql+asyncpg://eclume:eclume@postgres:5432/eclume \
    -e ECLUME_TEST_REDIS_URL=redis://redis:6379 -e ECLUME_TEST_S3_ENDPOINT=http://minio:9000 \
    "${mock[@]}" \
    -v "$SRC:/src" -v "$CACHE/target-$pilar:/target" -v "$CACHE/registry:/opt/cargo/registry" \
    -v "$CACHE/home:/tmp/.cache" -v "$NDK:/opt/ndk:ro" \
    -v "$ANDROID_SDK:/opt/android-sdk:ro" -v "$JDK:/opt/jdk:ro" -v "$CACHE/gradle:/opt/gradle" \
    -w /src "$IMG" nice -n 10 bash deploy/pilares.sh "$pilar"
  RESULTADO[$pilar]=$?
  set -e
  echo "=== pilar $pilar: saída ${RESULTADO[$pilar]} em $((SECONDS - t0))s ==="
done
fi

resultados=""
for pilar in "${PILARES[@]}"; do resultados+="$pilar ${RESULTADO[$pilar]}"$'\n'; done
echo "Resultado:"; printf '%s' "$resultados"

if [[ "$PUBLICAR" -eq 0 ]]; then
  publicado=1
  for pilar in "${PILARES[@]}"; do [[ "${RESULTADO[$pilar]}" -eq 0 ]] || exit 1; done
  exit 0
fi
mapfile -t saida < <(printf '%s' "$resultados" | python3 deploy/gate.py descricao --duracao "$((SECONDS - inicio))" --log "$LOG" \
  --dispensados "$(IFS=,; echo "${DISPENSADOS[*]:-}")" --desde "$DESDE")
publicar "${saida[0]}" "${saida[1]}"
publicado=1
[[ "${saida[0]}" == success ]]
