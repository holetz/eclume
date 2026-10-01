# Executor do gate de qualidade do eclume (deploy/gate-host.sh): a imagem eclume-gate:<versão do Rust>, sobre a
# de compilação cruzada do release do desktop (desktop/build-windows.Dockerfile: Rust estável,
# o Rust de desktop/rust-toolchain.toml, clippy, rustfmt, cargo-xwin, LLVM 18, ninja, o Node do .nvmrc
# e as libs do Tauri), mais o que os outros pilares de deploy/pilares.sh pedem: uv, ffmpeg, Python 3,
# o Google Chrome (canal `chrome` do web), as dependências de sistema do Chromium do Playwright (o
# navegador em si o pilar baixa sem root) e as ferramentas da auditoria (pip-audit e cargo-deny),
# todas com versão fixada.
# Contrato: docs/standards/code/monorepo.md.
ARG RUST
FROM eclume-desktop-build-windows:${RUST}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 xz-utils wget gnupg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7 /uv /uvx /usr/local/bin/
# Google Chrome estável (decoders proprietários da conversão de mídia) e as libs do Chromium, do
# WebKit e do Firefox do Playwright, que o `playwright install --with-deps` instalaria com root.
RUN curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && npm install -g --no-audit --no-fund playwright@1.63.0 && playwright install-deps chromium webkit firefox \
 && npm rm -g playwright && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* /root/.npm
# Auditoria de dependências (pilar `auditoria`): pip-audit sobre o Python do sistema e cargo-deny.
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
    uv tool install --python /usr/bin/python3 pip-audit==2.10.1 \
 && chmod -R a+rX /opt/uv-tools && pip-audit --version
RUN cargo install --locked cargo-deny --version 0.20.2 && rm -rf /opt/cargo/registry \
 && chmod -R a+rwX /opt/cargo && cargo deny --version
# O `cq` do pilar `docs`: o holetz/quenching público na ref fixada (a mesma do job `docs` do ci.yml;
# deploy/test_docs_check.py confere).
ARG QUENCHING_SHA=9150af364e40ec7ca9c4f918cb60593e93ae4eea
RUN git init -q /opt/quenching && cd /opt/quenching \
 && git fetch -q --depth 1 https://github.com/holetz/quenching.git "$QUENCHING_SHA" \
 && git checkout -q FETCH_HEAD && rm -rf .git \
 && ln -s /opt/quenching/plugins/quenching/bin/cq /usr/local/bin/cq && cq --version
# Núcleo do app móvel para o Android (o NDK chega do host, só leitura).
RUN rustup target add aarch64-linux-android armv7-linux-androideabi && chmod -R a+rwX /opt/cargo /opt/rustup
