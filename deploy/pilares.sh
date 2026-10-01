#!/usr/bin/env bash
# Comandos de prova de cada pilar do eclume: a fonte única que a CI (.github/workflows/ci.yml) e o
# gate do host (deploy/gate-host.sh) chamam. Quem chama prepara o ambiente — actions, apt e
# serviços na CI; imagem eclume-gate e serviços do projeto eclume-gate no gate. Este script não sobe
# nada: os serviços e o mock chegam por ECLUME_TEST_* e ECLUME_MOCK_URL.
#
# Uso: bash deploy/pilares.sh <pilar>     roda os comandos do pilar, parando no primeiro que falha
#      bash deploy/pilares.sh --lista     enumera os pilares, um por linha
# Pilares: python contracts web web-browser desktop mobile docs windows auditoria (os dois últimos
# só no gate).
# Contrato: docs/standards/code/monorepo.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PILARES=(python contracts web web-browser desktop mobile docs windows auditoria)

# Um grupo dobrável por comando no log da CI; no gate, só um cabeçalho.
run() {
  echo "::group::$*"
  "$@"
  echo "::endgroup::"
}

# O link do desktop estoura (Bus error) com o debuginfo cheio na CI; o dev local mantém o cheio.
# O cargo roda de dentro da pasta do workspace: é dali que o rustup lê o rust-toolchain.toml.
cargo_env() {
  export CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_PROFILE_TEST_DEBUG=line-tables-only
  cd "$ROOT/$1"
}

pilar_python() {
  run uv sync --all-packages --locked
  run uv run ruff check .
  run uv run ruff format --check .
  # A suíte do server falha, em vez de pular, se os serviços não estiverem no ar.
  ECLUME_TEST_REQUIRE_SERVICES=1 run uv run pytest
}

pilar_contracts() {
  run uv sync --all-packages --locked
  run uv run python contracts/tools/bundle.py --check
  run uv run pytest contracts/tests
  run bash contracts/tests/smoke-mock.sh
}

pilar_web() {
  run npm --prefix web ci
  run npm --prefix web run gen:api -- --check
  run npm --prefix web run lint
  run npm --prefix web test
  run npm --prefix web run build
}

# Navegador: a conversão de mídia (vitest browser mode) e o E2E contra o mock, no Google Chrome.
pilar_web_browser() {
  export E2E_CHANNEL="${E2E_CHANNEL:-chrome}"
  run npm --prefix web ci
  run npm --prefix web run fixtures
  run npm --prefix web run test:browser
  run npm --prefix web run test:e2e
}

pilar_desktop() {
  cargo_env desktop
  run cargo fmt --all --check
  run cargo check --workspace --locked
  run cargo clippy --workspace --locked -- -D warnings
  run cargo test --workspace --locked
  cd "$ROOT"
  # A UI da janela (desktop/ui) num Chromium, com o Tauri simulado. As dependências de sistema do
  # navegador vêm de quem chama (setup da CI, imagem do gate).
  run npm --prefix desktop/ui-tests ci
  run npm --prefix desktop/ui-tests exec -- playwright install chromium
  run npm --prefix desktop/ui-tests test
}

pilar_mobile() {
  run npm --prefix mobile ci
  run npm --prefix mobile run lint
  run npm --prefix mobile test
  run npm --prefix mobile run build
  cargo_env mobile
  run cargo fmt --all --check
  run cargo check --workspace --locked
  run cargo clippy --workspace --locked -- -D warnings
  run cargo test --workspace --locked
  # O núcleo compila para o Android sem o gradle: prova a compilação cruzada do libopus (cmake) e
  # do SQLite com o NDK fixado de quem chama (ECLUME_ANDROID_NDK: o do sdkmanager na CI, o do host no gate).
  local ndk="${ECLUME_ANDROID_NDK:?ECLUME_ANDROID_NDK aponta para o NDK fixado}"
  local bin="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
  export ANDROID_NDK_HOME="$ndk" ANDROID_NDK_ROOT="$ndk"
  export CC_aarch64_linux_android="$bin/aarch64-linux-android26-clang"
  export AR_aarch64_linux_android="$bin/llvm-ar"
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$bin/aarch64-linux-android26-clang"
  run cargo check -p eclume-mobile-core --target aarch64-linux-android --locked
}

# A documentação: conformidade do bundle OKF (`cq`, do holetz/quenching na ref fixada no
# gate.Dockerfile e no ci.yml) e links, âncoras, caminhos em crase e ordem do glossário.
pilar_docs() {
  run cq knowledge validate docs
  run python3 deploy/docs_check.py
}

# O código só-Windows do desktop, por compilação cruzada (cargo-xwin). Só no gate: na CI o xwin
# baixaria o SDK a cada execução.
pilar_windows() {
  cargo_env desktop
  run cargo xwin clippy --workspace --all-targets --locked \
    --target x86_64-pc-windows-msvc -- -D warnings
}

# Vulnerabilidades conhecidas das dependências de produção: pip-audit sobre o uv.lock, npm audit
# (alta ou crítica) nos projetos que vão para o usuário e cargo-deny (advisories) nos workspaces
# Rust. Exceção só com motivo e prazo: deploy/auditoria-excecoes.txt (Python), `overrides` no
# package.json (npm) e o [advisories] ignore de desktop/deny.toml e mobile/deny.toml (Rust). Só no
# gate: precisa da rede e das ferramentas da imagem eclume-gate.
pilar_auditoria() {
  local req ignorar=() id prazo
  req="$(mktemp)"
  run uv export --locked --all-packages --no-hashes --no-emit-workspace --format requirements-txt -o "$req"
  # Linha da exceção: <id> <prazo AAAA-MM-DD> <motivo>; vencida, deixa de valer e o pilar falha.
  while read -r id prazo _; do
    [[ -z "$id" || "$id" == \#* ]] && continue
    if [[ "$prazo" > "$(date +%F)" ]]; then ignorar+=(--ignore-vuln "$id"); fi
  done < deploy/auditoria-excecoes.txt
  run pip-audit --no-deps --disable-pip -r "$req" "${ignorar[@]}"
  rm -f "$req"
  for projeto in web mobile desktop; do
    run npm --prefix "$projeto" audit --omit=dev --audit-level=high
  done
  for ws in desktop mobile; do
    (cd "$ROOT/$ws" && run cargo deny --locked check advisories)
  done
}

case "${1:-}" in
  --lista) printf '%s\n' "${PILARES[@]}" ;;
  python|contracts|web|web-browser|desktop|mobile|docs|windows|auditoria) "pilar_${1//-/_}" ;;
  *) echo "Uso: bash deploy/pilares.sh <$(IFS='|'; echo "${PILARES[*]}")> | --lista" >&2; exit 2 ;;
esac
