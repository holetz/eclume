# Executor do gate de qualidade do eclume (deploy/gate-host.sh): a imagem eclume-gate:24.04, sobre a
# de compilação cruzada do release do desktop (desktop/build-windows.Dockerfile: Rust estável,
# clippy, rustfmt, cargo-xwin, LLVM 18, ninja e as libs do Tauri), mais o que os outros pilares de
# deploy/pilares.sh pedem: Node 22, uv, ffmpeg, Python 3, o Google Chrome (canal `chrome` do web) e
# as dependências de sistema do Chromium do Playwright (o navegador em si o pilar baixa sem root).
# Contrato: docs/standards/code/monorepo.md.
FROM eclume-desktop-build-windows:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 xz-utils wget gnupg \
 && rm -rf /var/lib/apt/lists/*
# Node 22 oficial em /usr/local (à frente do nodejs do apt no PATH), conferido pelo SHASUMS256.
RUN set -eu; base=https://nodejs.org/dist/latest-v22.x; \
    arquivo="$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $2}')"; \
    curl -fsSLO "$base/$arquivo"; \
    curl -fsSL "$base/SHASUMS256.txt" | grep " $arquivo\$" | sha256sum -c -; \
    tar -xJf "$arquivo" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE; \
    rm "$arquivo"; node --version
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
# Google Chrome estável (decoders proprietários da conversão de mídia) e as libs do Chromium do
# Playwright, que o `playwright install --with-deps` instalaria com root.
RUN curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && npx --yes playwright@1 install-deps chromium \
 && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* /root/.npm
# Núcleo do app móvel para o Android (o NDK chega do host, só leitura).
RUN rustup target add aarch64-linux-android && chmod -R a+rwX /opt/cargo /opt/rustup
