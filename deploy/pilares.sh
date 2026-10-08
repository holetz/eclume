#!/usr/bin/env bash
# Comandos de prova de cada pilar do eclume: a fonte única que a CI (.github/workflows/ci.yml) e o
# gate do host (deploy/gate-host.sh) chamam. Quem chama prepara o ambiente — actions, apt e
# serviços na CI; imagem eclume-gate e serviços do projeto eclume-gate no gate. Este script não sobe
# nada: os serviços e o mock chegam por ECLUME_TEST_* e ECLUME_MOCK_URL.
#
# Uso: bash deploy/pilares.sh <pilar>     roda os comandos do pilar, parando no primeiro que falha
#      bash deploy/pilares.sh --lista     enumera os pilares, um por linha
# Pilares: python contracts web web-browser desktop mobile docs windows auditoria android gpu-e2e (os
# quatro últimos só no gate; o gpu-e2e só roda no host, por deploy/gpu-e2e.sh).
# Contrato: docs/standards/code/monorepo.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PILARES=(python contracts web web-browser desktop mobile docs windows auditoria android gpu-e2e)

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
  # O relatório junit alimenta a checagem de pulos: só os da lista versionada passam (deploy/pulos.py).
  local junit="${TMPDIR:-/tmp}/eclume-pytest-junit.xml"
  ECLUME_TEST_REQUIRE_SERVICES=1 run uv run pytest --junitxml="$junit"
  run python3 deploy/pulos.py "$junit" "deploy/pulos-esperados-${ECLUME_PULOS:-ci}.txt"
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
  # O JS inicial cabe no teto de web/bundle-budget.json.
  run npm --prefix web run budget
}

# Navegador: a conversão de mídia e a transcrição longa (vitest browser mode) e o E2E contra o mock,
# no Google Chrome e, no smoke e nos testes de navegador, no WebKit e no Firefox do Playwright. As
# dependências de sistema dos motores vêm de quem chama (setup da CI, imagem do gate).
pilar_web_browser() {
  export E2E_CHANNEL="${E2E_CHANNEL:-chrome}"
  run npm --prefix web ci
  run npm --prefix web exec -- playwright install webkit firefox
  run npm --prefix web run fixtures
  # Um motor de cada vez: a medida de commit do Chromium não divide a máquina com os outros.
  for motor in chromium firefox webkit; do
    run npm --prefix web run test:browser -- --project "$motor"
  done
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
  # As projeções de .design/build/ são versionadas e batem com o .design/tokens.json.
  run cq design build --check
}

# O código só-Windows do desktop, por compilação cruzada (cargo-xwin). Só no gate: na CI o xwin
# baixaria o SDK a cada execução.
pilar_windows() {
  cargo_env desktop
  run cargo xwin clippy --workspace --all-targets --locked \
    --target x86_64-pc-windows-msvc -- -D warnings
}

# Vulnerabilidades conhecidas das dependências de produção: pip-audit sobre o uv.lock com todos os
# extras (o `gpu` é o que a imagem do worker GPU instala: whisperx, torch, transformers), npm audit
# (alta ou crítica) nos projetos que vão para o usuário e cargo-deny (advisories) nos workspaces
# Rust. Exceção só com motivo e prazo: deploy/auditoria-excecoes.txt (Python), `overrides` no
# package.json (npm) e o [advisories] ignore de desktop/deny.toml e mobile/deny.toml (Rust). Só no
# gate: precisa da rede e das ferramentas da imagem eclume-gate.
pilar_auditoria() {
  local req ignorar=() id prazo
  req="$(mktemp)"
  run uv export --locked --all-packages --all-extras --no-hashes --no-emit-workspace --format requirements-txt -o "$req"
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

# O fonte do :tauri-android (tauri-<versão>/mobile/android) vive no registro do cargo, compartilhado e
# persistente. O build.rs de cada plugin Android o copia arquivo a arquivo; se o Gradle escrever um
# build/ ali no meio da cópia, o arquivo listado some e o pilar cai (falha intermitente). O Gradle do
# app escreve o build/ do :tauri-android fora do registro (mobile/src-tauri/gen/android/build.gradle.kts);
# aqui se apaga o build/ que execuções antigas deixaram e se confere que nada voltou.
tauri_android_builds() {
  local base="${CARGO_HOME:-/opt/cargo}/registry/src"
  [[ -d "$base" ]] || return 0
  find "$base" -mindepth 5 -maxdepth 5 -path '*/tauri-[0-9]*/mobile/android/build' -type d -print0
}

# Os caminhos saem separados por NUL e são lidos assim: um nome com LF não pode partir o caminho e
# levar o rm -rf para fora do alvo. O `wait $!` traz de volta o status do find, que a substituição de
# processo perde: sem ele, um registro ilegível passaria por limpo.
tauri_android_limpar_builds() {
  local antigo
  while IFS= read -r -d '' antigo; do rm -rf -- "$antigo"; done < <(tauri_android_builds)
  wait $! || return 1
}

# Falha (e nomeia o que voltou) se algum build/ reapareceu no registro.
tauri_android_invasores() {
  local invasor achados=()
  while IFS= read -r -d '' invasor; do achados+=("$invasor"); done < <(tauri_android_builds)
  wait $! || return 1
  ((${#achados[@]} == 0)) || { echo "o Gradle escreveu no registro do cargo: ${achados[*]}" >&2; return 1; }
}

# O APK de release do celular, verificado: minificado (R8) e assinado com uma chave descartável
# desta execução, com os testes de unidade e o lint do plugin e do app, os símbolos da ponte JNI na
# .so e a classe EclumeCore no dex (mobile/scripts/simbolos_jni.py). Só no gate: o SDK, o NDK e o
# JDK chegam do host só leitura (ECLUME_ANDROID_SDK, ECLUME_ANDROID_NDK, ECLUME_ANDROID_JDK), e o
# build leva perto de 15 min.
pilar_android() {
  local sdk="${ECLUME_ANDROID_SDK:?ECLUME_ANDROID_SDK aponta para o SDK fixado}"
  local ndk="${ECLUME_ANDROID_NDK:?ECLUME_ANDROID_NDK aponta para o NDK fixado}"
  local jdk="${ECLUME_ANDROID_JDK:?ECLUME_ANDROID_JDK aponta para o JDK}"
  export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk" JAVA_HOME="$jdk"
  export NDK_HOME="$ndk" ANDROID_NDK_HOME="$ndk" ANDROID_NDK_ROOT="$ndk"
  export PATH="$jdk/bin:$PATH" GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
  local gradle="$ROOT/mobile/src-tauri/gen/android"
  run npm --prefix mobile ci
  # Uma chave por execução, fora do repositório: o APK de release sai assinado e minificado como o
  # de verdade, sem a keystore do host.
  local chaves
  chaves="$(mktemp -d)"
  keytool -genkeypair -noprompt -keystore "$chaves/gate.jks" -alias gate -keyalg RSA -keysize 2048 \
    -validity 2 -storepass gate-descartavel -keypass gate-descartavel -dname "CN=eclume gate"
  printf 'storeFile=%s\npassword=gate-descartavel\nkeyAlias=gate\n' "$chaves/gate.jks" \
    > "$gradle/keystore.properties"
  tauri_android_limpar_builds
  run npm --prefix mobile run tauri -- android build --apk --target aarch64 --ci
  # O Gradle que o tauri deixa de pé é um segundo JVM de ~2 GiB ao lado do --no-daemon de baixo, e os dois
  # somados estouram o teto de memória do contêiner (holetz/eclume#188).
  (cd "$gradle" && run ./gradlew --stop)
  tauri_android_invasores
  (cd "$gradle" && run ./gradlew --no-daemon :tauri-plugin-eclume-gravador:testDebugUnitTest \
    :tauri-plugin-eclume-gravador:lintRelease :app:lintUniversalRelease)
  local apk
  apk="$(find "$gradle/app/build/outputs/apk" -path '*release*' -name '*.apk' | head -n 1)"
  [[ -n "$apk" ]] || { echo "APK de release não encontrado" >&2; return 1; }
  python3 - "$apk" "$chaves/lib.so" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as apk, open(sys.argv[2], "wb") as so:
    so.write(apk.read("lib/arm64-v8a/libeclume_mobile_lib.so"))
PY
  "$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm" -D --defined-only "$chaves/lib.so" > "$chaves/nm.txt"
  "$sdk/cmdline-tools/latest/bin/apkanalyzer" dex packages "$apk" > "$chaves/dex.txt"
  run python3 mobile/scripts/simbolos_jni.py --nm "$chaves/nm.txt" --dex "$chaves/dex.txt" \
    --kotlin mobile/plugins/gravador/android/src/main/java/io/github/holetz/eclume/movel/gravador/EclumeCore.kt
  rm -rf "$chaves" "$gradle/keystore.properties"
}

# A prova CUDA precisa do docker e da GPU do host, que o contêiner dos outros pilares não tem: o
# gate-host.sh a trata à parte; aqui só delega ao script, e falha claro fora do host.
pilar_gpu_e2e() {
  command -v docker >/dev/null 2>&1 \
    || { echo "gpu-e2e roda só no host GPU (bash deploy/gate.sh --pilares gpu-e2e)." >&2; return 1; }
  bash deploy/gpu-e2e.sh
}

case "${1:-}" in
  --lista) printf '%s\n' "${PILARES[@]}" ;;
  python|contracts|web|web-browser|desktop|mobile|docs|windows|auditoria|android|gpu-e2e) "pilar_${1//-/_}" ;;
  *) echo "Uso: bash deploy/pilares.sh <$(IFS='|'; echo "${PILARES[*]}")> | --lista" >&2; exit 2 ;;
esac
