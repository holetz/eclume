#!/usr/bin/env bash
# The gate's `gpu-e2e` pillar: the end-to-end proof of the CUDA path (WhisperX and diarization on the
# host GPU, the eclume:gpu queue, MinIO). Starts deploy/docker-compose.gpu-test.yml (project
# eclume-gpu-test), runs the 2 tests of worker-gpu/tests/test_gpu_e2e.py with ECLUME_GPU_E2E=1 in a
# container of the eclume-gate image (--network host: ports 16379 and 19000 are already on 127.0.0.1)
# and tears the compose down with `down -v` on every path. A skip counts as a failure
# (deploy/pulos-esperados-gpu-e2e.txt is empty). Runs on the GPU host, with its local docker;
# gate-host.sh calls it outside the pillars container. Contract: docs/standards/code/monorepo.md.
#
# Before starting, it waits for a free GPU: the `busy` signal of the production worker-gpu (gpu_busy,
# the same as deploy.sh's) and the minimum free VRAM, because the production worker may keep the model
# resident. The minimum is the test's peak (3876 MiB) plus slack, not an empty host: idle, the host
# already has ~0.9 GB of the graphical session (Xorg and desktop apps) and ~400 MiB the driver never
# reports as free (measured on 2026-10-07, holetz/eclume#159), so 5120 MiB free would only pass with
# the desktop almost closed. Past the limit, it warns and exits 75 (inconclusive), starting nothing
# and touching nothing in production.
#
# Usage: bash deploy/gpu-e2e.sh
# Variables: ECLUME_GPU_E2E_WAIT (minutes of waiting for the GPU, 20), ECLUME_GPU_E2E_INTERVAL
#            (seconds between checks, 30), ECLUME_GPU_E2E_VRAM_MIN_MIB (minimum free VRAM, 4096),
#            ECLUME_GATE_IMAGE (pytest image; default eclume-gate:<Rust>), ECLUME_GATE_CACHE_HOME
#            (uv cache, default ~/eclume-gate/cache/home). ECLUME_GPU_E2E_ESPERA and
#            ECLUME_GPU_E2E_INTERVALO are the deprecated pt-BR names, still read.
# Exit: pytest's (and the skip check's); 75 with the GPU busy past the wait.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=deploy/gpu-lib.sh
source "$ROOT/deploy/gpu-lib.sh"

INCONCLUSIVE=75
WAIT="${ECLUME_GPU_E2E_WAIT:-${ECLUME_GPU_E2E_ESPERA:-20}}"
INTERVAL="${ECLUME_GPU_E2E_INTERVAL:-${ECLUME_GPU_E2E_INTERVALO:-30}}"
VRAM_MIN="${ECLUME_GPU_E2E_VRAM_MIN_MIB:-4096}"
RUST="$(sed -n 's/^channel = "\(.*\)"/\1/p' desktop/rust-toolchain.toml 2>/dev/null || true)"
IMG="${ECLUME_GATE_IMAGE:-eclume-gate:$RUST}"
CACHE_HOME="${ECLUME_GATE_CACHE_HOME:-$HOME/eclume-gate/cache/home}"
COMPOSE=(docker compose -p eclume-gpu-test -f deploy/docker-compose.gpu-test.yml)

teardown() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }

# Free VRAM in MiB; empty when nvidia-smi does not answer.
free_vram() {
  nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -dc 0-9
}

# 0 when the GPU is free; otherwise it says why in $reason.
reason=""
gpu_free() {
  local free
  if [[ "$(gpu_busy)" == 1 ]]; then
    reason="the production worker-gpu is transcribing"
    return 1
  fi
  free="$(free_vram)"
  if [[ -n "$free" ]] && (( free < VRAM_MIN )); then
    reason="free VRAM ${free} MiB, below the minimum of ${VRAM_MIN} MiB"
    return 1
  fi
  return 0
}

# A test compose left up by a gate that crashed holds the GPU.
teardown
trap teardown EXIT

deadline=$(( SECONDS + WAIT * 60 ))
until gpu_free; do
  if (( SECONDS >= deadline )); then
    echo "gpu-e2e inconclusive: GPU busy for ${WAIT} min ($reason); nothing was started or stopped." >&2
    exit "$INCONCLUSIVE"
  fi
  echo "GPU busy ($reason); waiting (up to ${WAIT} min)…" >&2
  sleep "$INTERVAL"
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
code=$?
set -e
rm -f "$ROOT/.gpu-e2e-junit.xml"
exit "$code"
