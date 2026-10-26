---
type: standard
title: App móvel
description: O app móvel do eclume (Tauri 2, Android) é um microfone portátil — UI React sobre o DS, comandos Tauri e o evento estado sobre o eclume-mobile-core (os crates de gravação e sync do desktop), e o plugin nativo Kotlin pela ponte JNI (serviço em primeiro plano do tipo microfone, notificação, NsdManager, Wi-Fi não medido, WorkManager, instalador); a conexão pelos três caminhos com a CA fixada, a rede do eclume, a sessão com tempo de áudio e marcadores, o sync, as telas e a prova no emulador.
resource: mobile/**
tags: [code, mobile, android, tauri, gravacao, sync, mdns, tls]
timestamp: 2026-10-05
audience: both
authority: current
source: holetz/eclume#41, holetz/eclume#122, holetz/eclume#130, holetz/eclume#114, holetz/eclume#123, holetz/eclume#117, holetz/eclume#118, holetz/eclume#121, holetz/eclume#102, holetz/eclume#101, holetz/eclume#144
maintainer: holetz
---

# App móvel

O celular é um **microfone portátil**: grava em Ogg/Opus mono 16 kHz com a tela bloqueada, marca
instantes com nota opcional, guarda as gravações longe do servidor e sincroniza sozinho no Wi‑Fi
da rede do servidor, com o mesmo upload retomável do desktop. **Não lê transcrição nem resumo**:
isso é da web, e o celular não notifica o fim do processamento (só fala com o servidor no Wi‑Fi do
eclume; o aviso é do desktop e do web, holetz/eclume#118). Só Android: o iOS está fora do escopo, sem spec aberta (o plugin recusa o iOS em
`mobile/plugins/gravador/src/lib.rs`; o núcleo, a UI com `data-os` e a interface do plugin não
fecham a porta para um lado Swift). O layout e os comandos do pilar estão em
[monorepo.md](monorepo.md#mobile--npm-and-cargo-workspace-in-mobile); a distribuição, em
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
  `ca.pem.novo` e só substitui o `ca.pem` depois dessa confirmação. O `ca.pem` tem **exatamente
  um** certificado, o da impressão digital conferida: o `pin.rs` grava só o primeiro do
  `eclume-root.crt`, e o modo fixado recusa um PEM com mais de um.
- **Migração na abertura** (holetz/eclume#102): com servidor na config e `ca.pem` presente,
  `Core::abrir` passa `pin::trim_saved` no `ca.pem`. Um arquivo com mais de um certificado é
  regravado só com o primeiro, e a credencial é apagada com o motivo `pin::CA_TRIMMED`
  (`Conexao::perdeu_credencial_por`), que manda entrar de novo, trocar a senha e desvincular a
  entrada antiga na web. Com um certificado só, nada muda.
- **Próxima raiz** (holetz/eclume#101). A sonda que confirma a CA fixada guarda a próxima que o
  descritor anuncia (`ca_next_sha256`): baixa `/downloads/eclume-root-proxima.crt` pela mesma
  conexão fixada, confere e grava um certificado só em `ca.proxima.pem` (`pin::learn_next`); sem
  anúncio, apaga a guardada, e fixar outro servidor ou sair também. Quando a sonda dá `CaMudou` e
  há próxima guardada, o núcleo lê o descritor fixando a próxima (fora da trava) e, se ele a
  confirma, troca `ca.proxima.pem` por `ca.pem` (`rename`) e grava a impressão nova na config
  (`Conexao::promover_proxima`): a sonda vale como ok e o aparelho segue pareado. Sem próxima, ou
  com outra raiz, segue `ca_mismatch`.
- A fase `sem_credencial` leva um `motivo` opcional (fora do JSON quando vazio), que a tela Entrar
  mostra num `.alert.alert-warning` acima do formulário; ele some depois de entrar.
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
- **Em segundo plano**, o `SyncWorker` do WorkManager (só `UNMETERED`) sobe com o app fechado.
  Gatilhos: o periódico de 15 min e uma passada na abertura (`KEEP`), e `agendarSync` em Parar
  (com o prazo da folha, 10 min), Salvar e Pular, no nome único `eclume-sync-ao-conectar` com
  `APPEND_OR_REPLACE`: encadeia depois de um sync em curso, sem cancelá-lo. O worker é um
  `CoroutineWorker`: `sondarPendentes` (sonda e pendentes, partindo do Wi‑Fi não medido que o
  WorkManager garante) decide; na rede do eclume e com algo a subir, ele entra em **primeiro plano
  `dataSync`** (canal `sync`, "Enviando N gravações"), fora do limite de 10 min do WorkManager; se o
  Android recusar (Android 12+ sem a isenção de bateria), segue como trabalho comum. O sync
  (`syncPendentes`, `ciclo_do_worker`) roda em `Dispatchers.IO`. O resultado é `success` quando
  subiu tudo ou não havia o que subir, e **`retry`** quando o ciclo deu erro, foi interrompido ou
  alguma gravação falhou (backoff exponencial a partir de 1 min; o backoff do núcleo decide que
  falha está vencida).
- **Interrupção por requisição:** o `Medidor` tem a marca `interrompido`, ligada por
  `mudou_rede(false)` (o callback de rede do sistema, na hora, por `EclumeCore.rede`, também no
  processo aberto só pelo worker, e a leitura de 5 s) e por `interromper_sync()` (o worker parado
  pelo sistema: o cancelamento da corrotina chama `EclumeCore.interromperSync`), e desligada por
  `preparar_sync` sob a trava do núcleo. Com ela, o `Contador` devolve `SyncInterrupted` (do
  `eclume-recorder`) sem tocar a rede, o `Client` não retenta, e `sync_pending` devolve a gravação a
  `pending` sem gastar tentativa (`Queue::release_claim`) e encerra a passada; o próximo Wi‑Fi
  retoma das partes que faltam no servidor. O desktop não aciona a interrupção.

## Sessão de gravação

- `gravar` abre o microfone (16 kHz mono pelo mixer) e começa com a taxa de bits da qualidade
  (`padrao` 24 kbps, cerca de 11 MB por hora; `alta` 48 kbps, cerca de 22 MB por hora), com
  `source: mobile` e `ask_details`.
- **Pausar** descarta amostras sem fechar o microfone: reabri-lo em segundo plano esbarraria nas
  restrições "while-in-use" do Android 14+. O **tempo de áudio** (sem as pausas) é o relógio da
  tela, o `at_ms` dos marcadores e o `duration_ms` do upload.
- **Marcador** marca na hora, com `client_id` UUID; a nota vem depois, opcional
  (`anotar_marcador`). **Parar** fecha o arquivo e abre a folha "Gravação salva" (título sugerido
  pela hora de início, os chips dos tipos de agenda e o **Idioma da transcrição**; Salvar ou
  Pular). O seletor de idioma vem da ponte (`idiomas`): "Padrão da conta: <idioma>" (valor vazio,
  a gravação sobe sem idioma e vale o da conta), "Detectar automaticamente" (`auto`), Português,
  Español e English; o padrão da conta é lido de `GET /me/transcription` no ciclo que lê os tipos
  de agenda e fica no cache (`idioma_da_conta`) para a folha fora da rede. `save_details` grava o
  idioma na linha da fila, que o upload manda. `recorded_at` é o relógio do
  celular no início, `recorded_at_source: capture`.
- **Limites** (`estimativas.rs`): menos de 1 h de gravação no espaço livre dá o aviso
  "Armazenamento quase cheio" no Início; menos de 5 min, gravando, para e salva sozinho; bateria em
  15 % ou menos, descarregando, dá a faixa "Bateria em N %", com a estimativa só depois de 10 min
  de queda medida.
- **Queda do processo:** o `.ogg.part` já tem as páginas Ogg em disco; na abertura seguinte o
  `session::recover` o acerta e a gravação aparece como "Interrompida". O serviço destruído com a
  gravação em curso para a gravação pela ponte.
- **Parada sem pedido avisa:** `verificar_limites` devolve a gravação e o motivo
  (`sem_espaco`, `fonte_encerrada`); o laço passa o motivo e o tempo salvo a
  `pararServico`, e o serviço posta "A gravação parou · <motivo> · <tempo> salvos" no canal
  `avisos` antes de sair (o mesmo aviso do `onDestroy` com gravação em curso).
- **Vigia do processo:** ao entrar em primeiro plano, o serviço grava "gravando desde" nas
  `SharedPreferences` do plugin e arma `setAndAllowWhileIdle` (`ELAPSED_REALTIME_WAKEUP`, 5 min;
  o Doze estica até ~9 min). O `VigiaDaGravacao` (receiver não exportado) rearma enquanto o
  serviço vive; num processo novo, com a marca e sem serviço, avisa "A gravação foi interrompida ·
  Toque para abrir" e limpa a marca. `encerrar` e o `onDestroy` cancelam o alarme e limpam a
  marca. Sem `START_STICKY`: o reinício em segundo plano não reabre o microfone no Android 14+.
- **Troca de rota não encerra:** plugar ou tirar um fone com microfone (P2, USB-C, Bluetooth)
  derruba o stream, e o `MicSource` se reconecta dentro da fonte
  ([desktop-gravacao.md](desktop-gravacao.md) §Fontes): a gravação segue no mesmo arquivo, com
  silêncio no meio. A reabertura acontece com o serviço de microfone em primeiro plano ativo (o
  mesmo processo), o que o Android 14+ exige. O `EstadoSessao` traz `microfone` (`ok` ou
  `reconectando`) e `silenciada`; o laço de `eventos.rs` chama `Core::vigiar` a cada 250 ms, que
  marca "microfone perdido" (queda acima de 5 s, no instante da queda) e "microfone de volta", e
  redesenha a notificação quando o microfone ou o silêncio mudam. A tela da gravação mostra a
  faixa "Microfone reconectando" ou "Silenciado pelo sistema".

## Plugin nativo e serviço em primeiro plano

O plugin `tauri-plugin-eclume-gravador` (`mobile/plugins/gravador`; nome em tempo de execução
`eclume-gravador`, o mesmo prefixo das permissões que o `tauri-plugin` gera pelo crate):

| Peça | O que faz |
|---|---|
| `GravadorPlugin` | permissões `microfone` e `notificacoes` (a UI as pede antes de gravar por `plugin:eclume-gravador\|request_permissions`); `iniciarServico` (respondido pelo serviço depois do `startForeground`, ou rejeitado com o motivo ou por prazo de 5 s), `atualizarServico`, `pararServico(motivo?, duracaoMs?)`, `descobrir(segundos)`, `estadoDoDispositivo` (com `notificacoes` e `isencaoDeBateria`: `concedida`, `pedir` ou `recusada`), `abrirConfiguracoesDoApp`, `pedirIsencaoDeBateria`, `abrirInstalador(caminho)`, `abrirUrl(url)`, `consumirAtalho` (`{gravar}`, `true` uma vez por toque no atalho); no `load`, acompanha a rede, agenda o `SyncWorker` e lê o atalho da partida a frio (`activity.intent`); no `onNewIntent`, o do app já aberto |
| `Atalho` | a ação `io.github.holetz.eclume.movel.GRAVAR_AGORA` e a regra pura `ehGravarAgora(acao, flags)` (a ação, sem `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`), testada na JVM por `AtalhoTest` |
| `ServicoDeGravacao` | `foregroundServiceType="microphone"`, iniciado com a Activity visível (o toque em Gravar), `START_NOT_STICKY`, com `PARTIAL_WAKE_LOCK`; as ações da notificação vão ao núcleo por `EclumeCore.acao`; na API 29+, `registerAudioRecordingCallback` enquanto grava (removido ao encerrar e no `onDestroy`): quando `isClientSilenced()` muda, `EclumeCore.acao("silenciado" \| "audivel")`, que marca "silenciado pelo sistema". Abaixo da API 29 não há sinal |
| `Notificacao` | canal `gravacao` de importância baixa, sem som, pública na tela bloqueada; "Gravando" com o cronômetro do sistema (`setWhen` = agora − tempo de áudio) ou "Pausado · 00:42:10"; "2 marcadores · espaço para cerca de 9 h", ou "Microfone desconectado · reconectando", ou "Silenciado pelo sistema"; Pausar/Continuar, Marcador e Parar |
| `EclumeCore` | `external fun acao`, `estado`, `syncPendentes` (com `interrompido`), `sondarPendentes`, `rede(wifiNaoMedido)` e `interromperSync`, implementadas em `src-tauri/src/jni.rs` sobre o núcleo global; devolvem JSON |
| `Descoberta` | `NsdManager` em `_eclume._tcp` (`registerServiceInfoCallback` na API 34+), TXT cru ao núcleo, que o interpreta por `discovery::parse` |
| `Conectividade`, `Dispositivo` | Wi‑Fi não medido; bateria, espaço livre, `Build.MODEL` e os recortes de borda a borda em dp |
| `SyncWorker`, `Atualizador` | o sync do WorkManager (`CoroutineWorker`, primeiro plano `dataSync` pelo `SystemForegroundService` com `foregroundServiceType="dataSync"` mesclado no manifesto, `agendarSync`); o instalador do sistema pelo `FileProvider` do app (o APK fica no cache) |

- O Rust chama o plugin sempre **fora da thread do comando** (o Kotlin responde na thread de quem
  chama). `gravar` é `async`: numa thread de bloqueio, abre a gravação e espera o
  `iniciarServico`; na recusa, desfaz a gravação aberta (fila e disco) e devolve o motivo à tela.
- **Três respostas do núcleo:** o serviço lê o JSON da ponte como sessão, sem sessão
  (`"sessao": null`) ou erro (`{"erro": …}`, `RespostaDoNucleo`). Erro nunca encerra: mantém o
  primeiro plano e a última notificação (num `INICIAR`, entra com a notificação neutra). Só "sem
  sessão" encerra, e Parar sempre encerra, mesmo com erro, avisando "A gravação parou com erro".
- **A ponte JNI não aborta:** as três funções `Java_…_EclumeCore_*` passam por `responder`
  (`catch_unwind`), que devolve `{"erro": "pânico: …"}`.
- **Canais:** `gravacao` (importância baixa, silencioso, a notificação contínua) e `avisos`
  (importância padrão, toca: a gravação parou ou foi interrompida).
- **Isenção de bateria:** `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (o app não sai pela Play, onde a
  política o restringe). Antes do primeiro Gravar com `isencaoDeBateria: pedir`, o Início explica e
  oferece pedir; Configurações mostram o estado e oferecem pedir depois.
- **Atalho "Gravar agora"** (`res/xml/shortcuts.xml` do app, com `ic_atalho_gravar` e o meta-data
  `android.app.shortcuts` na `MainActivity`, que é `singleTask`): atalho estático com intent para a
  `MainActivity` e a ação `GRAVAR_AGORA` (ação, não extra; `targetPackage` e `targetClass` escritos à
  mão, acompanham o `applicationId`). O atalho só abre o app: nunca sobe o serviço (o de microfone
  exige a Activity visível). O plugin guarda o toque num `AtomicBoolean` e troca a ação do intent da
  Activity por `MAIN`, para recriação e recentes não dispararem de novo. O bloco das Configurações
  rápidas (`BlocoGravar`, `TileService`) é a segunda etapa e ainda não está no app: abrirá a
  Activity pela mesma ação.
- **Manifesto** (app e plugin): `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `WAKE_LOCK`,
  `ACCESS_NETWORK_STATE`,
  `INTERNET`, `REQUEST_INSTALL_PACKAGES`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `CAMERA` (do
  leitor de QR) e `ACCESS_LOCAL_NETWORK`,
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
  `visibilidade`, `verificar_atualizacao`, `atualizar` e `abrir_na_web` (abre
  `endereco_na_web` pelo `abrirUrl` do plugin).
- **Título do servidor e "Abrir na web"** (holetz/eclume#118): o ciclo de rede, no máximo a cada
  60 s (`INTERVALO_DOS_TITULOS_MS`), lê `GET /recordings?since=` (`sync::buscar_titulos`, todas as
  páginas; a primeira a partir da enviada mais antiga ainda sem título, as seguintes do `since`
  anterior, em memória) e grava cada título na fila v5 (`set_server_title`); abrir o detalhe faz o
  mesmo com o `title` de `GET /recordings/{id}`. `GravacaoLocal.titulo_do_servidor` vai à lista e
  ao detalhe, que mostram o título local, senão o do servidor, e só então "Sem título".
  `DetalheLocal.endereco_na_web` é `<servidor pareado>/gravacoes/<id no servidor>`; com ele, o
  detalhe tem **Abrir na web**, que abre o navegador do sistema (Intent `ACTION_VIEW`, como o
  instalador) — o navegador precisa confiar na raiz do servidor (artigo
  `certificado-do-servidor`).
- **Evento `estado`** (`eventos.rs`): o `EstadoApp` completo (conexão, rede, sessão com
  `audio_ms`, nível e marcadores, folha, pendentes, avisos, espaço livre, versão), a cada mudança.
  O laço roda a 250 ms com o app visível (o medidor precisa) e a 1 s invisível (`visibilidade`,
  pelo `visibilitychange` da UI), quando só confere os limites e o microfone, sem `estado()` nem
  `emit`; ao voltar a ficar visível, emite já no primeiro tick. O mesmo laço fecha a gravação que
  bateu num limite e tenta o ciclo de rede a cada 5 s. O token do aparelho fica em memória na
  `Conexao` (lido na abertura, trocado em entrar, parear, sair e perda da credencial): o estado não
  relê o disco.
- **Sessão antes da fase:** com uma gravação ou a folha "Gravação salva" em curso, a tela é a de
  gravação, seja qual for a fase da conexão; com `sem_credencial`, ela mostra a faixa "Entre de novo
  para sincronizar" sem tirar Pausar, Marcador e Parar.
- **Atalho:** o App chama `consumirAtalho()` na montagem e a cada volta à visibilidade. Consumido
  na fase `conectado`, sem sessão nem folha, vai à rota `/` e segue o mesmo fluxo do botão Gravar
  (`app/gravar.ts`: permissões, a explicação da bateria, `gravar` e as mensagens de erro); com sessão
  ou folha, nada (a tela de gravação já está); em outra fase, é descartado e a tela da fase explica
  o que falta. Cada toque vale uma vez.
- **Permissões:** microfone negado mostra "Abrir configurações do app"; notificações bloqueadas
  viram a faixa "Notificações bloqueadas" no Início, com o mesmo botão.
- **UI** (`mobile/ui/src`): React + TS, função do `EstadoApp` (`app/estado.ts`), com a ponte tipada
  (`ponte/`) e uma ponte falsa para os testes. O `eclume.css` é a cópia do DS gerada de
  `design-system/styles.css` pelo `design-system/sincronizar.py` (a camada mobile `.m-*`), conferida
  pelo `test_sincronizar.py` e contra a do web por `ui/src/styles/copia.test.ts` (tipado pelo
  `tsconfig.node.json`, porque lê o arquivo do disco); ajustes de produto em `app.css`. Nenhum
  `style` fixo nas telas: espaços e tamanhos são classes do `app.css` com `--space-*` e os
  tamanhos do DS, e `style` só leva custom property (o `--h` das barras do medidor); o
  `no-restricted-syntax` do `eslint.config.js` barra o resto. Tema por `data-theme` a partir do
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

- **Estados e etapas pelo vocabulário compartilhado.** `ui/src/app/vocabulario.js` (e `.d.ts`) é
  cópia byte a byte de `web/src/lib/vocabulario.js`, conferida por `vocabulario.test.ts` (pula sem
  o web ao lado). Os selos da lista e do detalhe são os estados no aparelho, com o mesmo nome do
  desktop (Gravando, Aguardando envio, Enviando, Enviada, Interrompida, Falhou o envio em perigo).
  O detalhe mostra as sete etapas na ordem do servidor (tipo de agenda antes de campos), cada uma
  com o estado em palavra quando não concluída, e a lista "Motivos das etapas" sob a barra com o
  `reason` (texto de `MOTIVOS`) de uma etapa pulada ou em espera, ou o `error.message` de uma que
  falhou. A etapa Locutores em `waiting` (a conta exige nomear os locutores, holetz/eclume#144)
  aparece "Locutores · aguardando você" com o motivo; nomear é no web. A
  `Etapa` do núcleo (`sync.rs`) traz `reason` e `error` com `#[serde(default)]`, da mesma leitura de
  `GET /recordings/{id}`.
- **A espera na fila** (holetz/eclume#117): a mesma leitura traz `job.queue`; `buscar_etapas`
  devolve `NoServidor { etapas, espera }`, o núcleo guarda os dois no cache do detalhe e o
  `DetalheLocal` leva `espera`. Sob as etapas, o detalhe mostra em `role="status"` a frase de
  `fraseDaEspera` do vocabulário, a mesma do web e do desktop.
- **Diferença deliberada do DS:** o DS mostra "AAC 64 kbps" e "58 MB por hora"; o app grava Opus a
  24 ou 48 kbps (o formato que o server espera), e os textos mostram os números reais.

## Testes e prova

- **Núcleo** (`cargo test -p eclume-mobile-core`): a conexão pelos três caminhos, a rede, o sync
  inteiro (com o Wi‑Fi caindo entre as partes e a retomada), a sonda e o relatório do worker, a
  retenção, a atualização e a sessão, com um transporte roteirizado
  (`crates/core/tests/comum`) e uma fonte sintética em tempo real no lugar do microfone.
- **Plugin** (`./gradlew testDebugUnitTest` em `gen/android`): a decisão `success`/`retry` e o
  primeiro plano do `SyncWorker`, os textos da notificação e dos avisos, as três respostas do núcleo (`RespostaDoNucleo`, com o `org.json` real só nos testes), as
  ações, a regra do Wi‑Fi, a bateria e a isenção, o TXT e a autoridade do `FileProvider`.
- **App** (`cargo test -p eclume-mobile`): `responder` transforma erro e pânico em JSON, e o
  intervalo do laço por visibilidade.
- **UI** (`npm --prefix mobile test`): as telas pela ponte falsa.
- **Prova no emulador** (`mobile/scripts/prova-emulador.sh` + `mobile/e2e/prova.mjs`): o AVD
  `eclume-35` headless com KVM (`-gpu swiftshader_indirect -no-snapshot`, microfone mudo por
  `QEMU_AUDIO_DRV=none`), o APK de depuração x86_64 com as permissões concedidas, o WebView pelo
  Playwright `_android`, a tela bloqueada e a rede pelo `adb` e a notificação pelo `uiautomator`.
  Contra a produção, com a conta de smoke (`/srv/eclume/secrets/smoke-password`): entra pelo
  endereço conferindo a impressão digital com o `/server`, grava, marca pela tela e pela
  notificação, fica 60 s com a tela bloqueada e em **Doze forçado** (`dumpsys battery unplug`,
  `dumpsys deviceidle force-idle`, depois `unforce` e `reset`) com o serviço de microfone em
  primeiro plano e o tempo de áudio andando, sai da rede (e espera o app notar, porque o emulador
  ainda alcança o servidor pelos dados móveis), para e dá título, e volta à rede **com o app
  morto** (Home, `am kill`, Wi‑Fi ligado, o id do job do `SyncWorker` pelo `dumpsys jobscheduler` e
  `cmd jobscheduler run -f`) até a gravação aparecer no servidor sem abrir o app (`source: mobile`,
  dois marcadores); por fim, a recuperação depois de `am force-stop` (a gravação fica salva,
  `interrompida` ou já `sincronizada`). Parte do Wi‑Fi ligado, que o AVD guarda de uma prova que caiu no meio. A
  limpeza apaga as gravações da prova e revoga o token do aparelho.
- **Pilar `android` do gate** ([monorepo.md](monorepo.md)): o APK de release minificado com uma
  chave descartável, `testDebugUnitTest` e `lintRelease` do plugin e do app e a ponte JNI conferida
  por `mobile/scripts/simbolos_jni.py` na `.so` e no dex.
- **Fumaça do APK de release** (`prova-emulador.sh --fumaca <apk x86_64>`, no `release-movel.sh`):
  abre, força o job do `SyncWorker` e exige o log do sync, sem `UnsatisfiedLinkError`,
  `ClassNotFoundException` nem `FATAL EXCEPTION` ([mobile-distribuicao.md](mobile-distribuicao.md)).
- **Áudio:** o microfone do emulador entrega silêncio; a captação de um som conhecido pelo
  `-allow-host-audio` com uma fonte virtual do PulseAudio é experimento pendente, e até lá o
  conteúdo do áudio é passo humano no aparelho.
- **Aparelho real:** o celular, com a depuração USB ligada, vai numa porta USB do host (cabo de
  dados, modo MTP). O APK de depuração da prova só traz `x86_64`; para o aparelho, compile
  `npm --prefix mobile run tauri -- android build --debug --apk --target aarch64` no host e
  instale com `adb -s <serial> install -r` (mantém os dados). Esse APK é assinado com a chave de
  depuração: o de release não instala por cima, e trocar exige desinstalar, o que apaga as
  gravações que ainda não subiram. O aceite de 29/09/2026 (Galaxy M34, Android 16) passou pelo
  mDNS, pela entrada, pela gravação com a tela bloqueada e pelo sync ao voltar ao Wi‑Fi.
- **Passos humanos:** o aceite em cada aparelho novo, sobretudo de fabricantes com economia de
  bateria agressiva, e tudo de iOS.
