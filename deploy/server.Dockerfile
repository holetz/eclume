# syntax=docker/dockerfile:1.9
# eclume's server image: API (uvicorn), CPU worker (`eclume-server worker`: arq with the
# eclume:default and eclume:agents queues in one process), migrations and the `eclume-server` CLI.
# One image for every role; the production compose picks the command.
#
# Build from the repository ROOT, on the host daemon (the context is filtered by
# deploy/server.Dockerfile.dockerignore, which BuildKit reads because it sits next to this file):
#   docker --context <context> build -f deploy/server.Dockerfile -t eclume-server:prod .

# The `claude` CLI of the `claude-cli` provider (docs/standards/code/server-agentes.md) is optional and
# not free software: it only goes in with --build-arg ECLUME_CLAUDE_CLI=1. The default (0) picks the
# empty stage and BuildKit does not even build the other one. The npm package ships the native binary
# in bin/claude.exe: only it goes into the final image, without Node. Pinned version.
ARG ECLUME_CLAUDE_CLI=0

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS claudecli-0
RUN mkdir /out

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS claudecli-1
RUN npm install -g @anthropic-ai/claude-code@2.1.282 \
 && mkdir /out \
 && cp /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /out/claude

FROM claudecli-${ECLUME_CLAUDE_CLI} AS claudecli

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS build
COPY --from=ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Only the manifests first: the dependency layer is only rebuilt when the lock changes. uv needs
# the pyproject of every workspace member to read the lock.
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
COPY --from=claudecli /out/ /usr/local/bin/
COPY --from=build /app/.venv /app/.venv
# uid 1000 owns /srv/eclume on the host. The claude-cli credential does not come from the host: the
# token arrives by env (CLAUDE_CODE_OAUTH_TOKEN) or through the provider registered in the panel.
RUN mkdir -p /home/app/.claude && chown -R 1000:1000 /home/app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HOME=/home/app \
    DISABLE_AUTOUPDATER=1 \
    MALLOC_ARENA_MAX=2 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /home/app
USER 1000:1000
EXPOSE 8000
# Last: the SHA changes on every deploy and must not invalidate the heavy layers above.
ARG ECLUME_COMMIT=""
ENV ECLUME_COMMIT=$ECLUME_COMMIT
# Migrations run in the compose one-shot `migrate`, never here.
CMD ["uvicorn", "eclume_server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
