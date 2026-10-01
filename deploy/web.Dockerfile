# syntax=docker/dockerfile:1.9
# SPA do eclume (web/): build Vite servido estático por um Caddy mínimo, com fallback para o
# index.html nas rotas do cliente. API, /media e /downloads não passam por aqui: o Caddy de borda
# do compose de produção os encaminha antes (docs/project/deploy-producao.md).
#
# Build a partir da RAIZ do repositório (contexto filtrado por deploy/web.Dockerfile.dockerignore):
#   docker --context gpu-host build -f deploy/web.Dockerfile -t eclume-web:prod .

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
# O `tsc -b` do build também checa os testes, que importam contracts/fixtures por caminho relativo:
# a árvore web/ + contracts/ é reproduzida como no repositório.
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY contracts/fixtures /app/contracts/fixtures
COPY web/ ./
RUN npm run build

FROM caddy:2.11@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY deploy/web.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv
EXPOSE 80
