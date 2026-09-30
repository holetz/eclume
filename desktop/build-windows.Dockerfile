# Ambiente da compilação cruzada do instalador Windows (NSIS) no Linux, sobre a imagem de
# desktop/build.Dockerfile (eclume-desktop-build:24.04): o `cargo-xwin` baixa o CRT e o SDK da
# Microsoft e compila com clang-cl/lld-link; o `makensis` monta o instalador. Sem MSI (o WiX só
# roda no Windows). Usado por deploy/release-desktop.sh --windows.
FROM eclume-desktop-build:24.04
RUN apt-get update && apt-get install -y --no-install-recommends nsis lld-18 llvm-18 \
 && rm -rf /var/lib/apt/lists/*
# clang-cl, lld-link, llvm-lib, llvm-rc e llvm-mt vivem sem sufixo de versão só aqui.
ENV PATH=/usr/lib/llvm-18/bin:$PATH
RUN rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked cargo-xwin \
 && chmod -R a+rwX /opt/cargo /opt/rustup
# O libopus (crate `opus`) compila pelo CMake com o gerador Ninja quando o alvo é MSVC; sem ele o
# build falha em "CMAKE_MAKE_PROGRAM is not set". Camada própria para não refazer o cargo-xwin.
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build \
 && rm -rf /var/lib/apt/lists/*
