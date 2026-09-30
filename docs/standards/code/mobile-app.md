---
type: standard
title: App móvel
description: O app móvel do eclume (Tauri 2, Android) é um microfone portátil — UI React sobre o DS, comandos Tauri e o evento estado sobre o eclume-mobile-core (os crates de gravação e sync do desktop), e o plugin nativo Kotlin pela ponte JNI (serviço em primeiro plano do tipo microfone, notificação, NsdManager, Wi-Fi não medido, WorkManager, instalador); a conexão pelos três caminhos com a CA fixada, a rede do eclume, a sessão com tempo de áudio e marcadores, o sync, as telas e a prova no emulador.
resource: mobile/**
tags: [code, mobile, android, tauri, gravacao, sync, mdns, tls]
timestamp: 2026-09-29
audience: both
authority: current
source: holetz/eclume#41
maintainer: holetz
---

# App móvel

O celular é um **microfone portátil**: grava em Ogg/Opus mono 16 kHz com a tela bloqueada, marca
instantes com nota opcional, guarda as gravações longe do servidor e sincroniza sozinho no Wi‑Fi
da rede do servidor, com o mesmo upload retomável do desktop. **Não lê transcrição nem resumo**:
isso é da web. Android primeiro; iOS tem spec própria (o núcleo, a UI com `data-os` e a interface
do plugin ficam prontos para o lado Swift). O layout e os comandos do pilar estão em
[monorepo.md](monorepo.md#móvel--npm-e-workspace-cargo-em-mobile); a distribuição, em
[mobile-distribuicao.md](mobile-distribuicao.md).

## Arquitetura

```
UI (React, ui/src) ──invoke/listen──▶ src-tauri (comandos, evento estado) ──▶ eclume-mobile-core
                                            │ run_mobile_plugin                    ▲
                                            ▼                                      │ JNI (EclumeCore)
                          plugin eclume-gravador (Kotlin) ─────────────────────────┘
                          serviço, notificação, NsdManager, rede, aparelho, WorkManager, instalador
```

- **`eclume-mobile-core`** (`mobile/crates/core`), sem Tauri e testável no Linux, reaproveita o
  `eclume-recorder` (encoder, fila SQLite, recuperação), o `eclume-sync` (upload retomável, CA
  fixada, login e pareamento) e o `eclume-audio-capture` com a feature `mic` (o `MicSource` por
  `cpal`, AAudio no Android). O que o crate de sync oferece ao celular está em
  [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md#o-que-o-crate-de-sync-oferece-ao-app-móvel);
  a pausa, o tempo de áudio e a fila v4, em [desktop-gravacao.md](desktop-gravacao.md).
- **Um núcleo por processo**: `OnceLock<Mutex<Core>>` (`iniciar`, `global`), independente do
  `tauri::App`. A Activity pode morrer e voltar enquanto o serviço grava, e o WorkManager chama o
  núcleo sem Activity: o Tauri e o JNI são duas portas para o mesmo núcleo.
- **Rede fora da trava.** O que fala com a rede (a sonda, o sync, as leituras autenticadas, o
  download da atualização) é montado sob a trava como um plano (`PlanoDeLeitura`, `PlanoDeSync`,
  `PlanoDeDownload`), roda sem ela e volta por um método curto. A UI lê o estado a cada 250 ms sem
  esperar a rede.
- **Pastas:** tudo vive na pasta de dados do app (`app_data_dir` do Tauri, o `dataDir` do
  Android): `eclume/` com `config.json`, `ca.pem`, `queue.sqlite` e `gravacoes/`, e `no_backup/` (o
  `noBackupFilesDir`) com o `device-token` 0600 (arquivo privado do app, sem cifra pelo Android
  Keystore). O manifesto tem `android:allowBackup="false"` e `dataExtractionRules` que excluem
  tudo do backup na nuvem e da transferência entre aparelhos (Android 12+). O `SyncWorker` abre o
  núcleo com a mesma pasta (`context.dataDir`); a abertura é serializada, para a tela e o worker
  não rodarem a recuperação duas vezes.

## Conexão e credencial

- **Três caminhos para a CA fixada** (`conexao.rs`; o protocolo é o de
  [server-mcp-e-dispositivos.md](server-mcp-e-dispositivos.md#fixação-da-ca-pelos-apps)):
  1. **Descoberto** pelo mDNS: a raiz baixada tem de bater com o `ca` do TXT, e ainda assim a
     pessoa confere a impressão digital antes de mandar e-mail e senha, porque o TXT não é
     autenticado;
  2. **QR** da web (`pair_url`, lido por `parse_pair_url`): a impressão digital vem da tela
     autenticada da web, e o pareamento termina sem senha e sem conferência. Um QR **sem `ca`**
     (a raiz ainda não publicada) não dispensa nada: vai à conferência, e o código só é trocado
     depois de "Confiar";
  3. **Endereço digitado** (sem esquema vira `https://`): TOFU, com a impressão em blocos de 4
     (`3F9A 12C4 …`) para conferir com a web antes de "Confiar".
- Fixada a raiz, o transporte é `TrustMode::Pinned` (só o `ca.pem`), e o `GET /api/v1/server` já
  fixado confirma o `ca_sha256` antes de gravar o servidor na config. A raiz nova vai para
  `ca.pem.novo` e só substitui o `ca.pem` depois dessa confirmação.
- Os comandos que falam com o servidor para conectar (`conectar_*`, `confiar_ca`, `entrar`,
  `parear`) são `async` e rodam numa thread de bloqueio, nunca na thread principal. Trocar de servidor apaga a
  credencial do anterior.
- **Credencial:** `POST /devices/login` ou `POST /devices/pair` com `device_name` = `Build.MODEL`
  (o nome que a web lista e que os marcadores levam) e `platform: android`. O segredo `eclp_` vai
  para o `PatStore` sem chaveiro (o arquivo privado). As recusas viram texto no crate de sync,
  inclusive o 403 `notice_required` ("Aceite o aviso … na web e entre de novo aqui").
- **401** em qualquer chamada autenticada (notado pelo transporte durante o sync, e pelas leituras
  de tipos de agenda e etapas, marcadas com `CredencialRecusada`) apaga o token e leva à tela
  Entrar, sem mexer nas gravações locais.
- **"Sair e esquecer o servidor"** apaga o token, a CA e o servidor da config; as gravações
  aguardando ficam e sobem no próximo servidor pareado. A tela lembra de desvincular o aparelho na
  web: um token de dispositivo não se revoga sozinho.

## Rede do eclume e sync

- **Na rede do eclume** = Wi‑Fi não medido (o plugin, por `registerDefaultNetworkCallback`) **e**
  a sonda `GET /api/v1/server` respondendo em até 3 s, pela CA fixada, com a mesma impressão
  digital (`rede.rs`). Estados: `away`, `on_network`, `syncing {i, n, pct, bytes_s}`,
  `ca_mismatch` (a raiz mudou, ou o TLS recusou a cadeia) e `sem_credencial`.
- **A sonda roda** ao abrir o app, a cada mudança de rede (o aparelho é lido a cada 5 s), a cada
  60 s com o app visível, depois de parar uma gravação e em "Sincronizar agora". Fora do Wi‑Fi não
  medido ela não roda, e nenhum byte sai pelos dados móveis.
- **Sync** (`sync.rs`): em `on_network`, com o sync automático ligado ou por "Sincronizar agora"
  (que devolve as falhas à fila sem esperar o backoff), o `sync_pending` com o `HttpUploader` em
  modo fixado, `source: mobile`, `capture.device_name` do aparelho e
  `client_version: eclume-android/<versão>`. O andamento por parte (bytes enviados, taxa) sai do
  transporte (`Contador`), que também nota o 401.
- A gravação com `details_pending` (a folha "Gravação salva" aberta) espera até 10 min ou até
  Salvar/Pular. Depois do sync, com "Excluir depois de sincronizar", a retenção apaga os arquivos
  confirmados há mais de 7 dias; "Excluir sincronizadas" (o aviso de pouco espaço) apaga já.
- Os **tipos de agenda** da folha ficam em cache na config e são relidos quando a sonda roda
  (`GET /agenda-types`, que desde a 2.4.0 aceita o `recordings:read` da credencial de dispositivo).
- **Em segundo plano**, o `SyncWorker` do WorkManager (periódico de 15 min e um único ao ganhar
  Wi‑Fi, só `UNMETERED`) chama `syncPendentes` pela ponte (`ciclo_do_worker`), que parte do
  Wi‑Fi não medido que o WorkManager garante (o processo aberto só para ele não tem a tela que o
  avisaria) e faz a sonda antes de subir.

## Sessão de gravação

- `gravar` abre o microfone (16 kHz mono pelo mixer) e começa com a taxa de bits da qualidade
  (`padrao` 24 kbps, cerca de 11 MB por hora; `alta` 48 kbps, cerca de 22 MB por hora), com
  `source: mobile` e `ask_details`.
- **Pausar** descarta amostras sem fechar o microfone: reabri-lo em segundo plano esbarraria nas
  restrições "while-in-use" do Android 14+. O **tempo de áudio** (sem as pausas) é o relógio da
  tela, o `at_ms` dos marcadores e o `duration_ms` do upload.
- **Marcador** marca na hora, com `client_id` UUID; a nota vem depois, opcional
  (`anotar_marcador`). **Parar** fecha o arquivo e abre a folha "Gravação salva" (título sugerido
  pela hora de início, os chips dos tipos de agenda; Salvar ou Pular). `recorded_at` é o relógio do
  celular no início, `recorded_at_source: capture`.
- **Limites** (`estimativas.rs`): menos de 1 h de gravação no espaço livre dá o aviso
  "Armazenamento quase cheio" no Início; menos de 5 min, gravando, para e salva sozinho; bateria em
  15 % ou menos, descarregando, dá a faixa "Bateria em N %", com a estimativa só depois de 10 min
  de queda medida.
- **Queda do processo:** o `.ogg.part` já tem as páginas Ogg em disco; na abertura seguinte o
  `session::recover` o acerta e a gravação aparece como "Interrompida". O serviço destruído com a
  gravação em curso para a gravação pela ponte.

## Plugin nativo e serviço em primeiro plano

O plugin `tauri-plugin-eclume-gravador` (`mobile/plugins/gravador`; nome em tempo de execução
`eclume-gravador`, o mesmo prefixo das permissões que o `tauri-plugin` gera pelo crate):

| Peça | O que faz |
|---|---|
| `GravadorPlugin` | permissões `microfone` e `notificacoes` (a UI as pede antes de gravar por `plugin:eclume-gravador\|request_permissions`); `iniciarServico`, `atualizarServico`, `pararServico`, `descobrir(segundos)`, `estadoDoDispositivo`, `abrirInstalador(caminho)`; no `load`, acompanha a rede e agenda o `SyncWorker` |
| `ServicoDeGravacao` | `foregroundServiceType="microphone"`, iniciado com a Activity visível (o toque em Gravar), `START_NOT_STICKY`, com `PARTIAL_WAKE_LOCK`; as ações da notificação vão ao núcleo por `EclumeCore.acao` |
| `Notificacao` | canal `gravacao` de importância baixa, sem som, pública na tela bloqueada; "Gravando" com o cronômetro do sistema (`setWhen` = agora − tempo de áudio) ou "Pausado · 00:42:10"; "2 marcadores · espaço para cerca de 9 h"; Pausar/Continuar, Marcador e Parar |
| `EclumeCore` | `external fun acao`, `estado` e `syncPendentes`, implementadas em `src-tauri/src/jni.rs` sobre o núcleo global; devolvem JSON |
| `Descoberta` | `NsdManager` em `_eclume._tcp` (`registerServiceInfoCallback` na API 34+), TXT cru ao núcleo, que o interpreta por `discovery::parse` |
| `Conectividade`, `Dispositivo` | Wi‑Fi não medido; bateria, espaço livre, `Build.MODEL` e os recortes de borda a borda em dp |
| `SyncWorker`, `Atualizador` | o sync do WorkManager; o instalador do sistema pelo `FileProvider` do app (o APK fica no cache) |

- O Rust chama o plugin sempre **fora da thread do comando** (o Kotlin responde na thread de quem
  chama).
- **Manifesto** (app e plugin): `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`, `ACCESS_NETWORK_STATE`,
  `INTERNET`, `REQUEST_INSTALL_PACKAGES`, `CAMERA` (do leitor de QR) e `ACCESS_LOCAL_NETWORK`,
  declarada à frente do `targetSdk 37`; `network_security_config` sem texto claro (o HTTP do
  servidor de desenvolvimento só em `src/debug`); `FileProvider` só com o `cache-path`. `minSdk 26`, `targetSdk`/`compileSdk 36`.
- **Câmera:** o `tauri-plugin-barcode-scanner` oficial (`windowed`, QR), com a permissão numa
  capability só do celular (`capabilities/movel.json`, `platforms: android, iOS`). O texto lido
  não é confiável: `parse_pair_url` o valida antes de qualquer rede.

## Comandos, evento e UI

- **Comandos Tauri** (`comandos.rs`): `estado`, `descobrir`, `conectar_descoberto`,
  `conectar_endereco`, `confiar_ca`, `cancelar_ca`, `entrar`, `parear`, `gravar`, `pausar`,
  `continuar`, `marcar`, `anotar_marcador`, `parar`, `salvar`, `sincronizar_agora`, `gravacoes`,
  `gravacao` (com as etapas no servidor, em cache fora da rede), `excluir_local`,
  `excluir_sincronizadas`, `tipos_de_agenda`, `configuracoes`, `salvar_configuracoes`, `sair`,
  `visibilidade`, `verificar_atualizacao` e `atualizar`.
- **Evento `estado`** (`eventos.rs`): o `EstadoApp` completo (conexão, rede, sessão com
  `audio_ms`, nível e marcadores, folha, pendentes, avisos, espaço livre, versão), a cada 250 ms
  gravando e a cada mudança no resto. O mesmo laço fecha a gravação que bateu num limite e tenta o
  ciclo de rede a cada 5 s.
- **UI** (`mobile/ui/src`): React + TS, função do `EstadoApp` (`app/estado.ts`), com a ponte tipada
  (`ponte/`) e uma ponte falsa para os testes. O `eclume.css` é a cópia fiel do DS (a camada mobile
  `.m-*`); ajustes de produto em `app.css`. Tema por `data-theme` a partir do
  `prefers-color-scheme`; recortes em `--safe-top`/`--safe-bottom`; alvos de toque de 44 px ou mais.

| Tela do DS | Rota | O que mostra |
|---|---|---|
| Find server | `#/servidor` | "Encontre o seu servidor", a procura de 10 s, "Ler um código da web", "Digitar o endereço" |
| (Endereço) | `#/servidor/endereco` e a fase `confirmar_ca` | o endereço; a impressão digital com Confiar/Cancelar |
| Sign in | fase `sem_credencial` | "Entrar", o servidor, e-mail, senha e a recusa do servidor |
| Scan a code | `#/ler-codigo` | o visor sobre a câmera e os passos da web |
| Home, Away, Back on network, Low storage | `#/` | a faixa de rede, Gravar, "Neste celular" e o aviso de espaço |
| Recording, Paused, Low battery, Name and tag | sessão ou folha | o tempo de áudio, o medidor, os marcadores, Pausar/Marcador/Parar, a faixa de bateria e a folha |
| Recording detail | `#/gravacao/<id>` | o player local (protocolo de assets só em `$APPDATA/eclume/gravacoes`), os marcadores, as etapas no servidor, "Excluir deste celular" |
| Settings | `#/configuracoes` | servidor, sincronização, qualidade, retenção, uso, sair, versão e "Nova versão disponível" |

- **Diferença deliberada do DS:** o DS mostra "AAC 64 kbps" e "58 MB por hora"; o app grava Opus a
  24 ou 48 kbps (o formato que o server espera), e os textos mostram os números reais.

## Testes e prova

- **Núcleo** (`cargo test -p eclume-mobile-core`): a conexão pelos três caminhos, a rede, o sync
  inteiro, a retenção, a atualização e a sessão, com um transporte roteirizado
  (`crates/core/tests/comum`) e uma fonte sintética em tempo real no lugar do microfone.
- **Plugin** (`./gradlew testDebugUnitTest` em `gen/android`): os textos da notificação, as ações,
  a regra do Wi‑Fi, a bateria, o TXT e a autoridade do `FileProvider`.
- **UI** (`npm --prefix mobile test`): as telas pela ponte falsa.
- **Prova no emulador** (`mobile/scripts/prova-emulador.sh` + `mobile/e2e/prova.mjs`): o AVD
  `eclume-35` headless com KVM (`-gpu swiftshader_indirect -no-snapshot`, microfone mudo por
  `QEMU_AUDIO_DRV=none`), o APK de depuração x86_64 com as permissões concedidas, o WebView pelo
  Playwright `_android`, a tela bloqueada e a rede pelo `adb` e a notificação pelo `uiautomator`.
  Contra a produção, com a conta de smoke (`/srv/eclume/secrets/smoke-password`): entra pelo
  endereço conferindo a impressão digital com o `/server`, grava, marca pela tela e pela
  notificação, fica 60 s com a tela bloqueada e o serviço de microfone em primeiro plano, sai da
  rede (e espera o app notar, porque o emulador ainda alcança o servidor pelos dados móveis), para
  e dá título, volta, confere a gravação no servidor (`source: mobile`, dois marcadores) e a
  recuperação depois de `am force-stop` (a gravação fica salva, `interrompida` ou já
  `sincronizada`). Parte do Wi‑Fi ligado, que o AVD guarda de uma prova que caiu no meio. A
  limpeza apaga as gravações da prova e revoga o token do aparelho.
- **Aparelho real:** o celular, com a depuração USB ligada, vai numa porta USB do host (cabo de
  dados, modo MTP). O APK de depuração da prova só traz `x86_64`; para o aparelho, compile
  `npm --prefix mobile run tauri -- android build --debug --apk --target aarch64` no host e
  instale com `adb -s <serial> install -r` (mantém os dados). Esse APK é assinado com a chave de
  depuração: o de release não instala por cima, e trocar exige desinstalar, o que apaga as
  gravações que ainda não subiram. O aceite de 29/09/2026 (Galaxy M34, Android 16) passou pelo
  mDNS, pela entrada, pela gravação com a tela bloqueada e pelo sync ao voltar ao Wi‑Fi.
- **Passos humanos:** o aceite em cada aparelho novo, sobretudo de fabricantes com economia de
  bateria agressiva, e tudo de iOS.
