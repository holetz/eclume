# Ambiente de build do app desktop no Linux, para quem não tem as libs de desenvolvimento (ou
# sudo): Ubuntu 24.04 com os mesmos pacotes da CI, o Rust de desktop/rust-toolchain.toml e o Node
# da imagem oficial (o major do .nvmrc). Imagens base por digest; contexto mínimo (só o arquivo do
# Rust, ver build.Dockerfile.dockerignore):
#   docker build -t eclume-desktop-build:<versão do Rust> -f desktop/build.Dockerfile desktop
# Ver desktop/README.md e docs/standards/code/desktop-distribuicao.md.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS node

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libxdo-dev libssl-dev build-essential file \
    libasound2-dev libpipewire-0.3-dev libpulse-dev clang cmake \
    curl ca-certificates git pkg-config xdg-utils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
COPY rust-toolchain.toml /opt/rust-toolchain/rust-toolchain.toml
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none \
 && cd /opt/rust-toolchain && rustup toolchain install \
 && rustup default "$(rustup show active-toolchain | cut -d' ' -f1)" \
 && rustc --version && chmod -R a+rwX /opt/cargo /opt/rustup
