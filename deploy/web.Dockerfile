# syntax=docker/dockerfile:1.9
# Imagem da borda do eclume (`eclume-edge`): o Caddy 2.11 com o build Vite do SPA (web/) em /srv/web
# e as regras dele em /etc/caddy/spa.caddy (deploy/web.Caddyfile). O Caddyfile de cada compose
# (`configs.content`: TLS, /api, /media, /mcp, /downloads) monta por cima de /etc/caddy/Caddyfile e
# inclui as regras do SPA com `import` (docs/project/deploy-producao.md). Sozinha, a imagem serve o
# SPA na porta 80, sem TLS.
#
# Build a partir da RAIZ do repositório (contexto filtrado por deploy/web.Dockerfile.dockerignore):
#   docker compose -f deploy/docker-compose.prod.yml build caddy

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
# O `tsc -b` do build também checa os testes, que importam contracts/fixtures por caminho relativo,
# e o build gera a referência da API (/referencia-api.html) do contracts/openapi-v1.bundled.yaml:
# a árvore web/ + contracts/ é reproduzida como no repositório.
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY contracts/fixtures /app/contracts/fixtures
COPY contracts/openapi-v1.bundled.yaml /app/contracts/openapi-v1.bundled.yaml
COPY web/ ./
RUN npm run build

FROM caddy:2.11@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY deploy/web.Caddyfile /etc/caddy/spa.caddy
COPY <<'EOF' /etc/caddy/Caddyfile
{
	admin off
	auto_https off
}

:80 {
	import /etc/caddy/spa.caddy
}
EOF
COPY --from=build /app/web/dist /srv/web
EXPOSE 80 8443
