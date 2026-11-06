# syntax=docker/dockerfile:1.9
# eclume's edge image (`eclume-edge`): Caddy 2.11 with the Vite build of the SPA (web/) in /srv/web
# and its rules in /etc/caddy/spa.caddy (deploy/web.Caddyfile). Each compose's Caddyfile
# (`configs.content`: TLS, /api, /media, /mcp, /downloads) mounts over /etc/caddy/Caddyfile and
# includes the SPA rules with `import` (docs/project/deploy-producao.md). On its own, the image serves
# the SPA on port 80, without TLS.
#
# Build from the repository ROOT (context filtered by deploy/web.Dockerfile.dockerignore):
#   docker compose -f deploy/docker-compose.prod.yml build caddy

FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
# The build's `tsc -b` also checks the tests, which import contracts/fixtures by relative path, and
# the build generates the API reference (/referencia-api.html) from contracts/openapi-v1.bundled.yaml:
# the web/ + contracts/ tree is reproduced as in the repository.
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
