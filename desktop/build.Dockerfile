# Ambiente de build do app desktop no Linux, para quem não tem as libs de desenvolvimento (ou
# sudo): Ubuntu 24.04 com os mesmos pacotes da CI e o Rust estável. Ver desktop/README.md.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libxdo-dev libssl-dev build-essential file \
    libasound2-dev libpipewire-0.3-dev libpulse-dev clang cmake \
    curl ca-certificates git pkg-config xdg-utils nodejs npm \
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable -c clippy,rustfmt \
 && chmod -R a+rwX /opt/cargo /opt/rustup
