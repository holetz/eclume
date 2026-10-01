---
type: standard
title: Distribuição do app móvel
description: Como o app móvel do eclume vira um APK e se atualiza — versão no tauri.conf.json, tag mobile-v<versão>, workflow mobile-release com APK universal assinado pela keystore de release (secrets ANDROID_KEYSTORE_*), conferido pelo apksigner, movel.json e SHA256SUMS, publicação em /srv/eclume/downloads/movel pelo deploy/publicar-movel.sh e a atualização dentro do app pela CA fixada.
resource: mobile/src-tauri/tauri.conf.json, mobile/src-tauri/gen/android/app/build.gradle.kts, mobile/scripts/manifesto_movel.py, mobile/scripts/criar-keystore.sh, mobile/INSTALACAO.md, .github/workflows/mobile-release.yml, deploy/publicar-movel.sh
tags: [code, mobile, android, release, apk, ci]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#41, holetz/eclume#89, holetz/eclume#90
maintainer: holetz
---

# Distribuição do app móvel

O app móvel ([mobile-app.md](mobile-app.md)) sai como um **APK assinado**, baixado do próprio
servidor eclume. Não há loja: publicar na Google Play ou na App Store é decisão e conta da dona do
produto. iOS tem spec própria.

## Versão e tag

- A versão vive em `mobile/src-tauri/tauri.conf.json` (`version`) e no `[workspace.package]` de
  `mobile/Cargo.toml`, que andam juntos. O `versionCode` do Android sai da versão pelo Tauri.
- A tag é `mobile-v<versão>`. O bump é do conclude da spec que muda o app, nunca de uma task.

## Workflow `mobile-release.yml`

Roda por tag `mobile-v*` ou à mão (`workflow_dispatch` com `publicar` e `notas`), nunca em PR:

1. confere que a tag bate com a versão do `tauri.conf.json` e, quando vai publicar, que o commit tem
   o status `eclume/gate` = `success` do gate do host ([monorepo.md](monorepo.md)), sem dispensa;
2. num `ubuntu-24.04`, que já traz o SDK, instala o Java 21, o Node do `.nvmrc`, o Rust de
   `mobile/rust-toolchain.toml` (com os alvos `aarch64-linux-android` e `armv7-linux-androideabi`)
   e o NDK `28.2.13676358` de `mobile/scripts/android-sdk.sh` pelo `sdkmanager`, e roda o `npm ci`
   antes de a keystore existir no runner;
3. decodifica a keystore de `ANDROID_KEYSTORE_B64` num arquivo temporário e grava
   `gen/android/keystore.properties` (`storeFile`, `password`, `keyAlias`; fora do git), que o
   `app/build.gradle.kts` lê para o `signingConfig` de release;
4. `tauri android build --apk --target aarch64 --target armv7`: o **APK universal**;
5. `apksigner verify --print-certs` confere a assinatura e dá o SHA-256 do certificado;
6. `mobile/scripts/manifesto_movel.py` grava `movel.json` e `SHA256SUMS` na pasta do release, com
   o `INSTALACAO.md`;
7. com `publicar`, o GitHub Release (privado, como o repo) `mobile-v<versão>` com o APK, o
   `movel.json`, o `INSTALACAO.md` e o `SHA256SUMS`.

Sem os secrets, o workflow para antes do build. No Linux, um build Android por release custa 1× o
minuto: não há matriz.

## Keystore e secrets

- A keystore é criada **uma vez**, no host, por `mobile/scripts/criar-keystore.sh`: RSA 4096,
  validade de 30 anos, alias `eclume`, em `/srv/eclume/secrets/eclume-android.jks`, com a senha em
  `/srv/eclume/secrets/android-keystore-password` (os dois 0600, no backup do deploy). O script se
  recusa a sobrescrever uma keystore existente.
- **Perdê-la impede atualizar os apps instalados**: o Android só instala por cima um APK assinado
  pela mesma chave, e a saída é desinstalar e parear de novo.
- Os secrets do repositório são `ANDROID_KEYSTORE_B64` (a keystore em base64),
  `ANDROID_KEYSTORE_PASSWORD` e `ANDROID_KEY_ALIAS`. Gravá-los exige a confirmação da dona do
  repositório; o script imprime os comandos `gh secret set`.
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
