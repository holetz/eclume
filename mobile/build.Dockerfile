# The mobile app's release APK environment (deploy/release-mobile.sh), over the desktop build image
# (desktop/build.Dockerfile, eclume-desktop-build:<Rust version>: Ubuntu 24.04 and Node by digest and
# the pinned Rust, the same as mobile/rust-toolchain.toml): the rustup Android targets and the
# manifest's Python. The SDK, the NDK and the JDK of mobile/scripts/android-sdk.sh come from the host,
# read-only, and the keystore only in the build step.
#   docker build --build-arg RUST=<version> -t eclume-mobile-build:<version> - < mobile/build.Dockerfile
# Contract: docs/standards/code/mobile-distribuicao.md.
ARG RUST
FROM eclume-desktop-build:${RUST}
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
# The universal APK's targets (aarch64, armv7) and the smoke emulator's (x86_64).
RUN rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android \
 && chmod -R a+rwX /opt/cargo /opt/rustup
