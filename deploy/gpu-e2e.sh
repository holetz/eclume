#!/usr/bin/env bash
# Pilar `gpu-e2e` do gate: a prova de ponta a ponta do caminho CUDA (WhisperX e diarização na GPU do
# host, fila eclume:gpu, MinIO). Sobe deploy/docker-compose.gpu-test.yml (projeto eclume-gpu-test),
# roda os 2 testes de worker-gpu/tests/test_gpu_e2e.py com ECLUME_GPU_E2E=1 num contêiner da imagem
# eclume-gate (--network host: as portas 16379 e 19000 já estão em 127.0.0.1) e derruba o compose
# com `down -v` em todos os caminhos. Pulo vale falha (deploy/pulos-esperados-gpu-e2e.txt é vazia).
# Roda no host GPU, com o docker local dele; o gate-host.sh a chama fora do contêiner dos pilares.
# Contrato: docs/standards/code/monorepo.md.
#
# Antes de subir, espera a GPU livre: o sinal `busy` do worker-gpu de produção (gpu_busy, o mesmo do
# deploy.sh) e a VRAM livre mínima, porque o worker de produção pode manter o modelo residente.
# O mínimo é o pico do teste (3876 MiB) mais folga, não um host vazio: parado, o host já tem ~0,9 GB
# da sessão gráfica (Xorg e apps do desktop) e ~400 MiB que o driver nunca dá como livres (medido em
# 2026-10-07, holetz/eclume#159), então 5120 MiB livres só passariam com o desktop quase fechado.
# Passado o limite, avisa e sai com 75 (inconclusivo), sem subir nada e sem tocar na produção.
#
# Uso: bash deploy/gpu-e2e.sh
# Variáveis: ECLUME_GPU_E2E_ESPERA (minutos de espera pela GPU, 20), ECLUME_GPU_E2E_INTERVALO
#            (segundos entre consultas, 30), ECLUME_GPU_E2E_VRAM_MIN_MIB (VRAM livre mínima, 4096),
#            ECLUME_GATE_IMAGE (imagem do pytest; padrão eclume-gate:<Rust>), ECLUME_GATE_CACHE_HOME
#            (cache do uv, padrão ~/eclume-gate/cache/home).
# Saída: a do pytest (e da checagem de pulos); 75 com a GPU ocupada além da espera.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=deploy/gpu-lib.sh
source "$ROOT/deploy/gpu-lib.sh"

INCONCLUSIVO=75
ESPERA="${ECLUME_GPU_E2E_ESPERA:-20}"
INTERVALO="${ECLUME_GPU_E2E_INTERVALO:-30}"
VRAM_MIN="${ECLUME_GPU_E2E_VRAM_MIN_MIB:-4096}"
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml 2>/dev/null || true)"
IMG="${ECLUME_GATE_IMAGE:-eclume-gate:$RUST}"
CACHE_HOME="${ECLUME_GATE_CACHE_HOME:-$HOME/eclume-gate/cache/home}"
COMPOSE=(docker compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml)

derrubar() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }

# VRAM livre em MiB; vazio quando o nvidia-smi não responde.
vram_livre() {
  nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -dc 0-9
}

# 0 quando a GPU está livre; senão diz o motivo em $motivo.
motivo=""
gpu_livre() {
  local livre
  if [[ "$(gpu_busy)" == 1 ]]; then
    motivo="o worker-gpu de produção está transcrevendo"
    return 1
  fi
  livre="$(vram_livre)"
  if [[ -n "$livre" ]] && (( livre < VRAM_MIN )); then
    motivo="VRAM livre ${livre} MiB, abaixo do mínimo de ${VRAM_MIN} MiB"
    return 1
  fi
  return 0
}

# Um compose de teste deixado de pé por um gate que caiu segura a GPU.
derrubar
trap derrubar EXIT

prazo=$(( SECONDS + ESPERA * 60 ))
until gpu_livre; do
  if (( SECONDS >= prazo )); then
    echo "gpu-e2e inconclusivo: GPU ocupada por ${ESPERA} min ($motivo); nada foi subido nem parado." >&2
    exit "$INCONCLUSIVO"
  fi
  echo "GPU ocupada ($motivo); esperando (até ${ESPERA} min)…" >&2
  sleep "$INTERVALO"
done

echo "::group::compose up ($PWD)"
"${COMPOSE[@]}" up -d --build --wait
echo "::endgroup::"

mkdir -p "$CACHE_HOME"
junit=/src/.gpu-e2e-junit.xml
set +e
docker run --rm --name eclume-gpu-test-pytest --network host -u 1000:1000 \
  -e HOME=/tmp -e CI=1 -e UV_PYTHON_INSTALL_DIR=/tmp/.cache/uv-python -e UV_LINK_MODE=copy \
  -e ECLUME_GPU_E2E=1 \
  -v "$ROOT:/src" -v "$CACHE_HOME:/tmp/.cache" -w /src "$IMG" \
  bash -c "set -e; uv sync --all-packages --locked; \
    uv run pytest worker-gpu/tests/test_gpu_e2e.py -v -s --junitxml=$junit; \
    python3 deploy/pulos.py $junit deploy/pulos-esperados-gpu-e2e.txt"
codigo=$?
set -e
rm -f "$ROOT/.gpu-e2e-junit.xml"
exit "$codigo"
