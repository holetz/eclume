# Runner of the eclume quality gate (deploy/gate-host.sh): the eclume-gate:<Rust version> image, on top
# of the desktop release cross-compilation image (desktop/build-windows.Dockerfile: stable Rust,
# the Rust of desktop/rust-toolchain.toml, clippy, rustfmt, cargo-xwin, LLVM 18, ninja, the Node of .nvmrc
# and the Tauri libs), plus what the other pillars of deploy/pillars.sh need: uv, ffmpeg, Python 3,
# Google Chrome (the web `chrome` channel), the system dependencies of Playwright's Chromium (the
# pillar downloads the browser itself without root) and the audit tools (pip-audit and cargo-deny),
# all at pinned versions.
# Contract: docs/standards/code/monorepo.md.
ARG RUST
FROM eclume-desktop-build-windows:${RUST}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 xz-utils wget gnupg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /uvx /usr/local/bin/
# Stable Google Chrome (proprietary decoders for media conversion) and the libs of Playwright's
# Chromium, WebKit and Firefox, which `playwright install --with-deps` would install as root.
RUN curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && npm install -g --no-audit --no-fund playwright@1.63.0 && playwright install-deps chromium webkit firefox \
 && npm rm -g playwright && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* /root/.npm
# Dependency audit (pillar `audit`): pip-audit over the system Python, and cargo-deny.
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    uv tool install --python /usr/bin/python3 pip-audit==2.10.1 \
 && chmod -R a+rX /opt/uv-tools && pip-audit --version
RUN cargo install --locked cargo-deny --version 0.20.2 && rm -rf /opt/cargo/registry \
 && chmod -R a+rwX /opt/cargo && cargo deny --version
# The `cq` of the `docs` pillar: the public holetz/quenching at the pinned ref (the same as the ci.yml
# `docs` job; deploy/test_docs_check.py checks it).
ARG QUENCHING_SHA=200373a8a804aa9426351c5ed3271fabc493ba38
RUN git init -q /opt/quenching && cd /opt/quenching \
 && git fetch -q --depth 1 https://github.com/holetz/quenching.git "$QUENCHING_SHA" \
 && git checkout -q FETCH_HEAD && rm -rf .git \
 && ln -s /opt/quenching/plugins/quenching/bin/cq /usr/local/bin/cq && cq --version
# Core and mobile app for Android (the NDK, SDK and JDK come from the host, read-only): the targets
# of the release APK (aarch64, armv7) and of the emulator (x86_64) of the android pillar.
RUN rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android \
 && chmod -R a+rwX /opt/cargo /opt/rustup
