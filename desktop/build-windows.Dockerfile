# Ambiente da compilação cruzada do instalador Windows (NSIS) no Linux, sobre a imagem de
# desktop/build.Dockerfile (eclume-desktop-build:<versão do Rust>): o `cargo-xwin` baixa o CRT e o SDK da
# Microsoft e compila com clang-cl/lld-link; o `makensis` monta o instalador. Sem MSI (o WiX só
# roda no Windows). Usado por deploy/release-desktop.sh --windows.
# RUST: a versão de desktop/rust-toolchain.toml, que também é a tag da imagem de base.
ARG RUST
FROM eclume-desktop-build:${RUST}
RUN apt-get update && apt-get install -y --no-install-recommends nsis lld-18 llvm-18 \
 && rm -rf /var/lib/apt/lists/*
# clang-cl, lld-link, llvm-lib, llvm-rc e llvm-mt vivem sem sufixo de versão só aqui.
ENV PATH=/usr/lib/llvm-18/bin:$PATH
RUN rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked cargo-xwin --version 0.23.1 \
 && chmod -R a+rwX /opt/cargo /opt/rustup
# O libopus (crate `opus`) compila pelo CMake com o gerador Ninja quando o alvo é MSVC; sem ele o
# build falha em "CMAKE_MAKE_PROGRAM is not set". Camada própria para não refazer o cargo-xwin.
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build \
 && rm -rf /var/lib/apt/lists/*
# Assinatura Authenticode no Linux (desktop/scripts/assinar-windows.sh): o `jsign` (Java) assina
# por qualquer fornecedor (serviço remoto, HSM na nuvem, token, PKCS#12), numa versão fixa com o
# sha256 conferido; o `osslsigncode` confere assinatura e carimbo e o `7z` abre o instalador NSIS
# para conferir os executáveis de dentro. Camada própria, para não refazer o resto.
ARG JSIGN=7.5
ARG JSIGN_SHA256=602a51c3545a6dc4fb99bd2ea7152b26d1345916d0c93ddfbd5936cb735af91c
RUN apt-get update && apt-get install -y --no-install-recommends \
      default-jre-headless osslsigncode p7zip-full \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/jsign \
 && curl -fsSLo /opt/jsign/jsign.jar \
      "https://github.com/ebourg/jsign/releases/download/${JSIGN}/jsign-${JSIGN}.jar" \
 && echo "${JSIGN_SHA256}  /opt/jsign/jsign.jar" | sha256sum -c - \
 && printf '#!/bin/sh\nexec java -jar /opt/jsign/jsign.jar "$@"\n' > /usr/local/bin/jsign \
 && chmod 755 /usr/local/bin/jsign
