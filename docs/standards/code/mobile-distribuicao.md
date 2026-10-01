---
type: standard
title: Distribuição do app móvel
description: Como o app móvel do eclume vira um APK e se atualiza — versão no tauri.conf.json, tag mobile-v<versão>, release no host pelo deploy/release-movel.sh (contêiner com a keystore só leitura, APK universal assinado, certificado conferido contra mobile/certificado-release.sha256, fumaça do APK minificado no emulador), keystore só no host, movel.json e SHA256SUMS, publicação em /srv/eclume/downloads/movel pelo deploy/publicar-movel.sh, que recusa a troca de certificado não declarada, e a atualização dentro do app pela CA fixada.
resource: mobile/src-tauri/tauri.conf.json, mobile/src-tauri/gen/android/app/build.gradle.kts, mobile/scripts/manifesto_movel.py, mobile/scripts/criar-keystore.sh, mobile/scripts/simbolos_jni.py, mobile/scripts/prova-emulador.sh, mobile/build.Dockerfile, mobile/INSTALACAO.md, deploy/release-movel.sh, deploy/publicar-movel.sh
tags: [code, mobile, android, release, apk, host]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#41, holetz/eclume#89, holetz/eclume#90, holetz/eclume#91, holetz/eclume#108
maintainer: holetz
---

# Distribuição do app móvel

O app móvel ([mobile-app.md](mobile-app.md)) sai como um **APK assinado**, baixado do próprio
servidor eclume. Não há loja: publicar na Google Play ou na App Store é decisão e conta da dona do
produto. O iOS está fora do escopo, sem spec aberta.

## Versão e tag

- A versão vive em `mobile/src-tauri/tauri.conf.json` (`version`) e no `[workspace.package]` de
  `mobile/Cargo.toml`, que andam juntos. O `versionCode` do Android sai da versão pelo Tauri.
- A tag é `mobile-v<versão>`. O bump é do conclude da spec que muda o app, nunca de uma task.

## Release no host — `deploy/release-movel.sh`

Espelho do `release-desktop.sh` ([desktop-distribuicao.md](desktop-distribuicao.md)), sem GitHub
Actions: a keystore **nunca** vai para os secrets do GitHub.

- Roda **na estação** e opera o host pelo contexto Docker (`gpu-host`) e por SSH. `--plan` só mostra
  versão, tag, commit, certificado esperado, disco e os impedimentos.
- Com `--publicar`, recusa árvore suja, commit que o GitHub não tem, commit sem o status
  `eclume/gate` = `success` do gate do host ([monorepo.md](monorepo.md); a dispensa é
  `--sem-gate "<motivo>"`, com o rastro `eclume/gate-dispensa`), tag que já existe e a falta de
  `mobile/certificado-release.sha256` ou da keystore no host. Recusa começar com o disco do host em
  90% ou mais, e a trava `~/eclume-build/movel/.trava` impede dois releases ao mesmo tempo.
- O código vai **do commit** (`git archive`) para `~/eclume-build/movel/src`. O contêiner é
  `eclume-mobile-build:<versão do Rust>` (de `mobile/build.Dockerfile`, sobre a imagem de build do
  desktop: Ubuntu 24.04, Node, o Rust fixado com os alvos Android e Python), com `--cpus 2`, uid
  1000, o SDK, o NDK e o JDK de `mobile/scripts/android-sdk.sh` só leitura e o cache do Gradle no
  host. O `npm ci --ignore-scripts` roda sem a keystore; só o build a recebe, **só leitura**, e grava
  o `keystore.properties` dentro do contêiner (apagado no fim).
- Saem o **APK universal** (`aarch64`, `armv7`, minificado pelo R8) e um APK `x86_64` com a mesma
  chave, só para a fumaça. O `apksigner verify --print-certs` dá o SHA-256 do certificado, que
  precisa bater com `mobile/certificado-release.sha256` (o valor versionado, público: já sai no
  `movel.json`); se diferir, o release para.
- `mobile/scripts/manifesto_movel.py` grava `movel.json` e `SHA256SUMS`, conferidos antes de
  publicar.
- **Fumaça do APK minificado:** `mobile/scripts/prova-emulador.sh --fumaca <apk x86_64>` sobe o AVD
  do host, instala, abre a Activity, espera o log do núcleo, força o job do `SyncWorker`
  (`cmd jobscheduler run -f`) e exige o log do sync, sem `UnsatisfiedLinkError`,
  `ClassNotFoundException` nem `FATAL EXCEPTION` no logcat. O Playwright não abre o WebView de um
  APK de release; a fumaça prova o R8 e a ponte JNI pelo caminho que não depende dele. `--publicar`
  sempre a roda.
- Com `--publicar`, o GitHub Release (privado, como o repo) `mobile-v<versão>` com o APK, o
  `movel.json`, o `INSTALACAO.md` e o `SHA256SUMS`, pelo `gh` do host.

O APK de release também é provado a cada gate, no pilar `android` ([monorepo.md](monorepo.md)):
minificado e assinado com uma chave descartável, com os testes de unidade e o lint do plugin e do
app e a conferência dos símbolos JNI (`mobile/scripts/simbolos_jni.py`: cada `external fun` do
`EclumeCore.kt` com o símbolo `Java_…` na `.so`, e a classe com os métodos nativos no dex).

## Keystore e certificado

- A keystore é criada **uma vez**, no host, por `mobile/scripts/criar-keystore.sh --dname "<titular>"`
  (o titular sai da identidade do app, holetz/eclume#17): RSA 4096, validade de 30 anos, alias
  `eclume`, em `/srv/eclume/secrets/eclume-android.jks`, com a senha em
  `/srv/eclume/secrets/android-keystore-password` (os dois 0600). O script se recusa a sobrescrever
  uma keystore existente e imprime o SHA-256 do certificado, a versionar em
  `mobile/certificado-release.sha256`.
- **Perdê-la impede atualizar os apps instalados**: o Android só instala por cima um APK assinado
  pela mesma chave, e a saída é desinstalar e parear de novo.
- **Backup**: a keystore e a senha vão, com toda a pasta `/srv/eclume/secrets/`, no snapshot restic
  cifrado do `deploy/backup.sh` (holetz/eclume#91), no repositório local e na cópia fora do host; o
  ensaio noturno confere o sha256 dos arquivos restaurados, e um host novo os recebe de volta por
  `restaurar-backup.sh --host-novo` ([deploy-producao.md](../../project/deploy-producao.md)). Um
  secret do GitHub **não** é cópia recuperável: não se lê de volta. A cópia fora do host configurada
  (`secrets/restic-fora.env`, com a senha do repositório guardada fora dele) é pré-condição do
  primeiro release.
- Ordem do primeiro release: identidade decidida (#17) → keystore criada com ela → SHA-256
  versionado → cópia fora do host → gate verde → `release-movel.sh --publicar` →
  `publicar-movel.sh`.
- O build de depuração (o do emulador e da prova) usa a chave de debug do SDK e nunca é publicado.

## `movel.json`

O manifesto é contrato com a página `/app-movel` da web (holetz/eclume#38) e com o app instalado.
Mudar um nome de campo exige mudar os dois.

| Campo | O quê |
|---|---|
| `versao` | a versão (`0.1.0`) |
| `publicado_em` | ISO 8601 em UTC (`2026-09-27T18:30:05Z`) |
| `notas` | o texto do release, que o app mostra em "Nova versão disponível" |
| `apk.arquivo` | `eclume-<versão>.apk` |
| `apk.url` | caminho absoluto no servidor, `/downloads/movel/<versão>/eclume-<versão>.apk`: serve a qualquer endereço do servidor |
| `apk.tamanho` | bytes |
| `apk.sha256` | SHA-256 do APK, em hex minúsculo |
| `min_android` | `8.0` (minSdk 26) |
| `certificado_sha256` | SHA-256 do certificado de assinatura, do `apksigner` |
| `instalacao` | `/downloads/movel/INSTALACAO.md` |

O script recusa uma pasta sem exatamente um APK `eclume-<versão>.apk`, sem o `INSTALACAO.md`, com
versão fora de `X.Y.Z` ou com certificado que não seja um SHA-256.

## Publicação no host

`deploy/publicar-movel.sh [mobile-v<versão>]`, espelho do `publicar-desktop.sh`, roda no host (onde
o `gh` está autenticado; da máquina de dev, `ssh holetz@192.168.15.199 'bash -s -- mobile-v0.1.0' <
deploy/publicar-movel.sh`):

- baixa o release para `/srv/eclume/downloads/movel/<versão>/` e confere o `SHA256SUMS` antes de
  qualquer troca;
- troca `/srv/eclume/downloads/movel.json` e `/srv/eclume/downloads/movel/INSTALACAO.md` por cópia
  e `mv` (nunca um arquivo pela metade), só se a versão não for mais antiga que a publicada
  (`FORCAR=1` aponta para uma anterior);
- mantém as três versões mais recentes, e nunca apaga a que o `movel.json` aponta.
- recusa um release cujo `certificado_sha256` difere do `movel.json` já publicado: os apps
  instalados não atualizariam. A troca só passa declarada, com `TROCAR_CERTIFICADO="<motivo>"` (o
  caso da #17), que aparece no log.

O Caddy do eclume serve `/downloads/` ([deploy-producao.md](../../project/deploy-producao.md)).

## Instalação e atualização

- **Instalação:** o navegador do celular não confia na CA interna do eclume. O `INSTALACAO.md`
  explica instalar a `eclume-root.crt` como certificado de usuário ou aceitar o aviso uma vez, e
  conferir o SHA-256 do APK. O app não depende disso: ele fixa a CA sozinho.
- **Atualização no app:** na rede do eclume, uma vez por dia, o núcleo lê o `movel.json` pela CA
  fixada. Com versão maior, Configurações mostra "Nova versão disponível · v<versão>". "Atualizar"
  baixa o APK pela CA fixada para o cache do app, confere o `apk.sha256` e abre o instalador do
  sistema (`FileProvider`, `REQUEST_INSTALL_PACKAGES`); sem a permissão de instalar de fontes
  desconhecidas, abre antes a tela do sistema que a concede. O Android pede a confirmação e
  instala por cima, mantendo as gravações e o pareamento.
