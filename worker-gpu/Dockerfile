# Imagem do worker GPU do eclume (WhisperX 3.8.6, torch 2.8, CUDA 12 das wheels).
#
# Referência: o Dockerfile do whisperx-asr-service (murtaza-nasir), que dispensa a base
# nvidia/cuda: as wheels de torch e CTranslate2 trazem o runtime CUDA/cuDNN, e o NVIDIA
# Container Toolkit injeta o driver. Aqui as dependências saem do mesmo uv.lock da CI, pelo uv.
#
# Os modelos NÃO entram na imagem: ficam no volume /models (/srv/eclume/models no host).
# Build a partir da raiz do repositório, no host GPU:
#   docker --context gpu-host build -t eclume-worker-gpu:dev -f worker-gpu/Dockerfile .

FROM python:3.12-slim-bookworm

# Estágio único de propósito: num multi-stage, o .venv (~7 GB) existiria duas vezes no disco do
# host (cache do builder e camada final). O uv vem do binário da imagem oficial.
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

# ffmpeg decodifica o Opus (whisperx.load_audio) e fornece as libs do torchcodec.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Só os manifestos primeiro: a camada pesada (torch e CUDA) só refaz quando o lock muda.
# O uv precisa do pyproject de todo membro do workspace para ler o lock. O triton (~540 MB)
# só serve ao torch.compile, que o worker não usa, e sai na mesma camada.
COPY pyproject.toml uv.lock ./
COPY engines/pyproject.toml engines/README.md engines/
COPY worker-gpu/pyproject.toml worker-gpu/README.md worker-gpu/
COPY server/pyproject.toml server/
RUN uv sync --frozen --no-dev --package eclume-worker --extra gpu --no-install-workspace \
    && rm -rf /app/.venv/lib/python3.12/site-packages/triton

COPY engines/src engines/src
COPY worker-gpu/src worker-gpu/src
RUN uv sync --frozen --no-dev --package eclume-worker --extra gpu --no-editable --inexact

# O CTranslate2 procura cuBLAS e cuDNN no sistema; eles vêm das wheels nvidia-* do torch.
ENV VIRTUAL_ENV=/app/.venv
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    LD_LIBRARY_PATH=/app/.venv/lib/python3.12/site-packages/nvidia/cublas/lib:/app/.venv/lib/python3.12/site-packages/nvidia/cudnn/lib \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    HF_HOME=/models/huggingface \
    TORCH_HOME=/models/torch \
    NLTK_DATA=/usr/share/nltk_data \
    ECLUME_WORK_DIR=/tmp/eclume-work

# punkt_tab é usado pelo alinhamento; embutido para o worker rodar sem rede.
RUN python -c "import nltk; nltk.download('punkt_tab', download_dir='/usr/share/nltk_data', quiet=True)" \
    && mkdir -p /models /tmp/eclume-work \
    && chown 1000:1000 /models /tmp/eclume-work

# Mesmo uid do dono de /srv/eclume no host, para o volume de modelos ser gravável.
USER 1000:1000
VOLUME ["/models"]

CMD ["arq", "eclume_worker.worker.WorkerSettings"]
