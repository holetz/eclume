# Cross-compilation environment of the Windows installer (NSIS) on Linux, on top of the
# desktop/build.Dockerfile image (eclume-desktop-build:<Rust version>): `cargo-xwin` downloads the
# Microsoft CRT and SDK and compiles with clang-cl/lld-link; `makensis` builds the installer. No MSI
# (WiX only runs on Windows). Used by deploy/release-desktop.sh --windows.
# RUST: the version in desktop/rust-toolchain.toml, which is also the base image tag.
ARG RUST
FROM eclume-desktop-build:${RUST}
RUN apt-get update && apt-get install -y --no-install-recommends nsis lld-18 llvm-18 \
 && rm -rf /var/lib/apt/lists/*
# clang-cl, lld-link, llvm-lib, llvm-rc and llvm-mt only live without a version suffix here.
ENV PATH=/usr/lib/llvm-18/bin:$PATH
RUN rustup target add x86_64-pc-windows-msvc \
 && cargo install --locked cargo-xwin --version 0.23.1 \
 && chmod -R a+rwX /opt/cargo /opt/rustup
# libopus (crate `opus`) builds through CMake with the Ninja generator when the target is MSVC;
# without it the build fails with "CMAKE_MAKE_PROGRAM is not set". Own layer, so cargo-xwin is not redone.
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build \
 && rm -rf /var/lib/apt/lists/*
# Authenticode signing on Linux (desktop/scripts/sign-windows.sh): `jsign` (Java) signs through
# any provider (remote service, cloud HSM, token, PKCS#12), at a pinned version with a verified
# sha256; `osslsigncode` verifies the signature and timestamp and `7z` opens the NSIS installer
# to verify the executables inside. Own layer, so the rest is not redone.
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
