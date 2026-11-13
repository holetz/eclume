# Build environment of the desktop app on Linux, for whoever lacks the development libraries (or
# sudo): Ubuntu 24.04 with the same packages as CI, the Rust of desktop/rust-toolchain.toml and the
# Node of the official image (the .nvmrc major). Base images by digest; minimal context (only the
# Rust file, see build.Dockerfile.dockerignore):
#   docker build -t eclume-desktop-build:<Rust version> -f desktop/build.Dockerfile desktop
# See desktop/README.md and docs/standards/code/desktop-distribuicao.md.
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS node

FROM ubuntu:25.10@sha256:7cc5e35f6567ee8c66d2abb4aab0fd866669e6207c237c3a8f0947a5c7f17092
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
