# syntax=docker/dockerfile:1.9
# Imagem do server do eclume: API (uvicorn), worker CPU (arq, fila eclume:default), migrations e
# o CLI `eclume-server`. Uma imagem para os quatro papéis; o compose de produção escolhe o comando.
#
# Build a partir da RAIZ do repositório, no daemon do host (o contexto é filtrado por
# deploy/server.Dockerfile.dockerignore, lido pelo BuildKit por estar ao lado deste arquivo):
#   docker --context gpu-host build -f deploy/server.Dockerfile -t eclume-server:prod .

# A CLI `claude` do provider `claude-cli` (docs/standards/code/server-agentes.md). O pacote npm
# traz o binário nativo em bin/claude.exe: só ele entra na imagem final, sem Node. Versão fixada
# na mesma do host (~/.local/bin/claude).
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS claudecli
RUN npm install -g @anthropic-ai/claude-code@2.1.282

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS build
COPY --from=ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Só os manifestos primeiro: a camada de dependências só refaz quando o lock muda. O uv precisa
# do pyproject de todo membro do workspace para ler o lock.
COPY pyproject.toml uv.lock ./
COPY engines/pyproject.toml engines/README.md engines/
COPY server/pyproject.toml server/README.md server/
COPY worker-gpu/pyproject.toml worker-gpu/README.md worker-gpu/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package eclume-server --no-install-workspace
COPY engines/src engines/src
COPY server/src server/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --package eclume-server --no-editable

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
COPY --from=claudecli /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude
COPY --from=build /app/.venv /app/.venv
# uid 1000 é o dono de /srv/eclume e de ~/.claude/.credentials.json no host: o worker CPU monta a
# credencial do Claude gravável em /home/app/.claude (o OAuth renova o token).
RUN mkdir -p /home/app/.claude && chown -R 1000:1000 /home/app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOME=/home/app \
    DISABLE_AUTOUPDATER=1
WORKDIR /home/app
USER 1000:1000
EXPOSE 8000
# Por último: o SHA muda a cada deploy e não pode invalidar as camadas pesadas acima.
ARG ECLUME_COMMIT=""
ENV ECLUME_COMMIT=$ECLUME_COMMIT
# Migrations rodam no one-shot `migrate` do compose, nunca aqui.
CMD ["uvicorn", "eclume_server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
