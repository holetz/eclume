# Ambiente do APK de release do app móvel (deploy/release-movel.sh), sobre a imagem de build do
# desktop (desktop/build.Dockerfile, eclume-desktop-build:<versão do Rust>: Ubuntu 24.04 e Node por
# digest e o Rust fixado, o mesmo de mobile/rust-toolchain.toml): os alvos Android do rustup e o
# Python do manifesto. O SDK, o NDK e o JDK de mobile/scripts/android-sdk.sh chegam do host, só
# leitura, e a keystore só no passo de compilação.
#   docker build --build-arg RUST=<versão> -t eclume-mobile-build:<versão> - < mobile/build.Dockerfile
# Contrato: docs/standards/code/mobile-distribuicao.md.
ARG RUST
FROM eclume-desktop-build:${RUST}
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
# Os alvos do APK universal (aarch64, armv7) e o do emulador da fumaça (x86_64).
RUN rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android \
 && chmod -R a+rwX /opt/cargo /opt/rustup
