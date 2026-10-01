---
type: standard
title: Gravação no app desktop
description: O app desktop grava mic e áudio do sistema mixados em Ogg/Opus mono 16 kHz (24 kbps), e a nota de voz só com o microfone e parada pelo silêncio; registra cada gravação numa fila SQLite local (v4, com natureza, origem da data, fonte, marcadores, título e tipo de agenda escolhidos ao parar) com estados recording → pending → syncing → synced ou failed, retomada, backoff e retenção, e expõe os traits Uploader e MeetingDetector que o sync e a detecção implementam — este é o formato, o ciclo de vida, a pausa e o tempo de áudio, o detector de silêncio, os marcadores e os pontos de extensão; os crates são compartilhados com o app móvel.
resource: desktop/crates/recorder/**, desktop/crates/audio-capture/**, desktop/src-tauri/src/**
tags: [code, desktop, audio, opus, fila, sqlite, tauri]
timestamp: 2026-10-01
audience: both
authority: current
source: holetz/eclume#6, holetz/eclume#28, holetz/eclume#40, holetz/eclume#41, holetz/eclume#57
maintainer: holetz
---

# Gravação no app desktop

O app desktop grava reuniões na máquina do usuário e as guarda até o sync. Tudo que não depende
de dispositivo vive no crate `eclume-recorder` (`desktop/crates/recorder`), testável com áudio
sintético; a captura real vive em `eclume-audio-capture` (`desktop/crates/audio-capture`).

## Fontes

- Duas fontes por gravação: o **mic** (`cpal`) e o **áudio do sistema** (loopback) —
  PipeWire no monitor de um sink, com fallback para o monitor do Pulse, no Linux; WASAPI loopback
  num endpoint no Windows; Core Audio process tap no macOS (14.2+).
- **Escolha em Configurações · Áudio**, cada fonte com "Nenhum":

| Fonte | `config.json` | Valores |
|---|---|---|
| Microfone | `mic` | `null` (padrão do sistema), o nome do dispositivo, ou `"none"` |
| Áudio do sistema | `system_source` | `"follow"` (padrão: seguir a saída em uso), o id de uma saída, ou `"none"` |

  `list_input_devices()` lista os microfones e `MicSource::open_named` abre o escolhido;
  `list_output_devices()` lista as saídas (Linux: o nome do sink, com a descrição como rótulo;
  Windows: os endpoints ativos; macOS: vazia, o tap segue a saída em uso e ignora um id com
  aviso) e `SystemSource::open_target` abre a escolhida. Uma escolha que sumiu cai no padrão, com
  aviso na janela (`fell_back`). O booleano antigo `system_audio` ainda é lido (`false` vira
  `"none"`) e não é mais gravado. As duas fontes em Nenhum são recusadas ("Escolha ao menos uma
  fonte de áudio"); com o microfone em Nenhum, "Nova nota" e o atalho respondem "A nota precisa
  de um microfone".
- **Teste por fonte.** "Fale para testar" (microfone) e "Toque algo para testar" (sistema) abrem a
  fonte por até 10 s só para o medidor, sem gravar (`source_test`, `source_test_meter`); um teste
  por vez, e começar outro encerra o atual. O botão vira "Parar" (`source_test_stop`), que fecha a
  fonte na hora, e fica desabilitado com a fonte em Nenhum. Trocar a fonte ou sair das
  configurações também para o teste.
- Toda fonte implementa `AudioSource`: `sample_rate()` e `read(timeout)`, que devolve amostras mono
  `f32` na taxa nativa — `Some(vec![])` quando o prazo vence sem amostras, `None` quando a fonte
  acabou. A taxa pode mudar no meio da gravação e é relida a cada leitura. Dois métodos com
  padrão completam o trait: `state()` (`SourceState::Live` ou `Reconnecting { since }`) e
  `dropped_samples()` (descartes por anel cheio); o `impl` para `Box<T>` repassa os dois.
- **O microfone se reconecta.** `MicSource` é um `Reconnecting` (`audio-capture/src/reconnect.rs`)
  sobre o abridor do `cpal`: quando o anel fecha (erro do stream, dispositivo tirado, perfil
  Bluetooth trocando), a fonte solta o anel velho numa thread à parte e reabre, também numa thread
  à parte, com espera de 0,5 s dobrando até 5 s, sem desistir enquanto a gravação existir. Enquanto
  reconecta, `read` entrega **silêncio no ritmo do relógio**, na última taxa: a faixa não fica para
  trás, e duração, marcadores e as duas faixas seguem alinhados com a reunião. Cada tentativa
  resolve a escolha de novo (o nome, senão o padrão com `fell_back`). Um seguidor confere a cada
  2 s o microfone que deveria estar em uso (com "padrão do sistema", o padrão do SO; com um nome,
  ele quando reaparece) e pede a troca depois de duas leituras seguidas, o critério do
  `EndpointFollower` do áudio do sistema no Windows. O `None` de `read` segue significando fim de
  verdade.
- O laço de gravação copia o estado de cada faixa e os descartes para o `Progress`
  (`source_states()`, `dropped_samples()`) a cada volta; descartes novos vão ao log no máximo a cada
  10 s, e o total entra na linha "gravação X fechada".
- **Microfone fora:** o reaper (1 s) chama `AppState::watch_sources()`. Uma perda acima de 5 s (a
  troca de perfil do Bluetooth leva de 1 a 3 s) põe "gravando sem microfone: tentando reconectar"
  na janela, "sem microfone" na linha da bandeja e a notificação "Microfone perdido · gravando sem a
  sua voz, tentando reconectar"; a volta limpa o aviso.
- Grava-se com o que abrir: uma fonte que falha vira aviso na janela ("gravando sem …"), e só é
  erro quando nenhuma abre.

## Formato do arquivo

| Item | Valor |
|---|---|
| Contêiner | Ogg, um stream lógico, `OpusHead` e `OpusTags` em páginas próprias |
| Codec | Opus, `Application::Voip`, 24 kbps, frames de 20 ms |
| Canais e taxa | mono, 16 kHz (`input sample rate` = 16000 no `OpusHead`) |
| Granule | em 48 kHz; o da última página é `pre-skip + amostras reais × 3`, então a duração é exata |
| Páginas | uma a cada ~1 s de áudio, descarregada no disco ao fechar |

É o mesmo formato que o navegador produz no upload
([formato-audio-upload.md](formato-audio-upload.md)); só a taxa de bits difere (24 kbps aqui,
pensando em reuniões longas). A mixagem reamostra cada fonte para 16 kHz (sinc, `rubato`), soma
com limitador rígido em ±1,0 e, se uma fonte fica mais de 200 ms atrás das outras, completa-a com
silêncio — assim um monitor de sink suspenso ou o loopback do WASAPI ocioso (que não entrega
pacote nenhum enquanto nada toca) não travam a gravação. Esse silêncio vira uma dívida de no
máximo 200 ms, descontada **só do excedente**: das amostras que a fonte entrega à frente da fila
mais longa das outras, o caso de uma rajada atrasada. A fonte que volta a entregar em tempo real
depois de um silêncio entra alinhada e inteira; descontar a dívida de toda amostra nova apagava o
áudio do sistema depois da primeira pausa (holetz/eclume#28).

## Nota de voz e parada por silêncio

- `AppState::start_note()` abre **só o microfone**, pelo mesmo `capture.rs` e com o dispositivo
  escolhido: uma nota é fala de quem grava, e o áudio do sistema traria música e notificações. A
  linha da fila nasce com `kind = 'note'`, e o upload leva `kind: note`.
- **Detector** (`recorder/src/vad.rs`, puro), sobre as amostras mixadas a 16 kHz que o
  `record_loop` já produz, em quadros de 20 ms (320 amostras):

| Parâmetro | Valor |
|---|---|
| Nível | RMS do quadro em dBFS |
| Piso de ruído | o percentil 20 dos níveis dos últimos 3 s (150 quadros, só os anteriores ao quadro); um ventilador ligado no meio vira piso em cerca de 1 s. Silêncio digital (abaixo de −90 dBFS) entra na janela mas nunca vira piso: quando o percentil cai nele, valem só os limites absolutos, para as pausas zeradas de um supressor de ruído não levarem o piso até a própria fala |
| Voz | entra com `nível > max(piso + 12 dB, −55 dBFS)` e se mantém com `nível > max(piso + 8 dB, −58 dBFS)` (histerese) |
| Voz sustentada | o quadro atual é voz, e pelo menos 5 dos últimos 10, o atual incluído, também (100 ms em 200 ms): só ela zera o silêncio e conta como voz ouvida. Um clique, uma tecla ou uma porta batendo não reiniciam a contagem |
| Gate da fala | depois da primeira voz sustentada, só zera o silêncio o quadro a no máximo 25 dB abaixo do pico recente da fala (o pico cai 2,5 dB/s). Uma respiração, um "hum" distante ou uma cadeira ficam de fora: numa nota real, uma respiração 30 dB abaixo da fala segurava a parada por 1,8 s a mais |
| `Silence` | o silêncio, contado desde o último quadro de voz sustentada, passou do configurado (2, 4 ou 8 s; padrão 4 s), e só depois de ter havido voz sustentada. A contagem regressiva da janela só aparece depois de 300 ms sem voz, para não piscar entre as sílabas |
| `NoSpeech` | nenhuma voz nos primeiros 10 s |
| Medidor | os últimos 16 níveis, de −60 a 0 dBFS mapeados para 0 a 1 |

- Com "Nunca" (`note_silence_s: null`), o detector só alimenta o medidor. Energia com piso
  adaptativo basta para "a pessoa parou de falar" com um só locutor perto do microfone, sem
  dependência nativa e testável com áudio sintético; um VAD treinado (WebRTC por FFI, Silero por
  `onnxruntime`) não compensa.
- **Sessão.** `session::start` recebe `StartOptions { kind, stop_after_silence }`. Um `Progress`
  compartilhado expõe `position_ms()` (amostras gravadas ÷ 16), `meter()`, `level()` e
  `stop_reason()`. O
  `record_loop` encerra sozinho em `Silence` ou `NoSpeech`, e o reaper, que fecha as gravações
  terminadas a cada 1 s, decide pelo motivo: `SourcesEnded` dá o aviso de sempre; `Silence`, a
  notificação "Nota salva · 42 s · processando no servidor"; `NoSpeech` **descarta** a nota
  (`queue.discard` e o arquivo apagado) com "Nota descartada · não ouvimos voz".
- **Parada manual** pelo mesmo atalho, pelo botão ("Parar nota") ou pela bandeja; parada à mão
  nunca é descartada. Com uma gravação em curso, "Nova nota" responde "Já há uma gravação em
  andamento", e o atalho não abre outra captura.
- A janela mostra o medidor (`note_meter`, a cada 100 ms) e "Silêncio · para em N s". Nada mais
  abre (variante A): a bandeja troca o ícone e mostra o tempo — no título, no macOS e no Linux; na
  dica, no Windows, cuja área de notificação não mostra texto.

## Pausa, tempo de áudio e nível

- `ActiveRecording::set_paused(bool)` pausa sem fechar as fontes: o laço continua lendo e mixando,
  e descarta o que lê. Reabrir o microfone em segundo plano esbarraria nas restrições do celular
  (Android 14+), e o dispositivo aberto dá a retomada instantânea.
- **Tempo de áudio** é o gravado sem as pausas: `audio_ms()` (o `position_ms()` do `Progress`) é o
  `at_ms` dos marcadores e vira o `duration_ms` do upload. O relógio das telas mostra o tempo de
  áudio.
- `level()` é o RMS do último trecho gravado, de 0 a 1, e cai a 0 pausado: é o medidor contínuo que
  a UI lê a cada 100 ms (o `meter()` da nota continua sendo o histórico em dBFS do detector).
- `RecorderConfig` leva, além de `dir` e `bitrate`, a `source` gravada na fila (`desktop`, o
  padrão, ou `mobile`) e `ask_details`: com ele, `stop` deixa a linha com `details_pending`.

## Marcadores

- `AppState::add_marker(note)` marca o `position_ms()` da gravação ativa — a posição no **áudio**,
  e não o relógio, para um vazio de fonte não desalinhar o marcador — com um `client_id` UUID v4, na
  tabela `markers` da fila. `set_marker_note` edita a nota (até 500 caracteres) enquanto a gravação
  não subiu.
- Entradas: o botão "Marcador" da janela (com a nota do último marcador), o item "Adicionar
  marcador" da bandeja (só gravando) e o atalho global, que não abre nada nem notifica, para não
  atrapalhar a reunião. A dica da bandeja diz "3 marcadores".
- **Marcadores automáticos:** a perda do microfone acima de 5 s marca "microfone perdido" no
  instante da queda (a posição no áudio menos o tempo fora), e a volta marca "microfone de volta".
  No celular, também "silenciado pelo sistema" ([mobile-app.md](mobile-app.md)).
- Os marcadores sobem **junto do upload** (`UploadCreate.markers`), idempotentes pelo `client_id`:
  a retomada e o upload deduplicado reenviam os mesmos, e o servidor mescla sem duplicar
  (holetz/eclume#34).

## Arquivos e fila

- Os dados ficam no diretório de dados do app (`app_data_dir`): `queue.sqlite` e `gravacoes/`.
- A gravação nasce como `gravacoes/<id>.ogg.part` e vira `<id>.ogg` ao parar.
- A fila é a tabela `recordings` (`id`, `path`, `started_at`, `ended_at`, `duration_ms`, `bytes`,
  `status`, `interrupted`, `attempts`, `last_error`, `remote_id`), com instantes em milissegundos
  Unix. O esquema v2 (`user_version = 2`) acrescenta `upload_id` e `sha256` (retomada do upload),
  `next_attempt_at` (backoff), `synced_at` (confirmação do servidor), `purged_at` (arquivo local
  apagado pela retenção) e `meeting_app` (app da reunião detectada, no vocabulário do contrato).
  O esquema v3 (`user_version = 3`) acrescenta `kind` (`meeting|note`, padrão `meeting`),
  `recorded_at_source` (`capture|file_metadata|user`, padrão `capture`), `source`
  (`desktop|upload`, padrão `desktop`), `original_name` e `content_type` (nulo é
  `audio/ogg; codecs=opus`), e a tabela `markers (client_id PRIMARY KEY, recording_id, at_ms,
  note, created_at)`. O esquema v4 (`user_version = 4`) acrescenta `title` e `agenda_type_id`
  (escolhidos ao parar e levados no `UploadCreate`), `details_pending` (0/1) e o valor `mobile` em
  `source`. Uma fila v1, v2 ou v3 ganha as colunas na abertura, sem perder linhas.
- Métodos da v3: `set_kind`, `begin_import` (a importação já nasce `pending`,
  [desktop-importacao.md](desktop-importacao.md)), `discard`, `add_marker`, `set_marker_note` e
  `markers(recording_id)`. Da v4: `set_source`, `set_details_pending`, `save_details(id, título,
  tipo)` (vazios viram nulos; libera o sync; só antes do upload) e `release_details_pending`.

```
recording ──parar──▶ pending ──claim_next──▶ syncing ──▶ synced ──retenção──▶ (purged_at)
    │                   ▲                        │
    ├─crash / .part preso: recover_orphans ──┘   └──▶ failed ──retry_due / retry_failed──▶ pending
    │    (abertura ou varredura a cada minuto; interrupted = 1)
    └─falha ou pânico da gravação: parar fecha mesmo assim (interrupted = 1)
```

- **Parada que sempre fecha:** `ActiveRecording::stop` guarda o erro ou pânico da thread de
  gravação no log em vez de abortar; o motivo vira `StopReason::Failed` (pânico sem motivo também).
  O `.part` é renomeado com até 5 tentativas (200 ms dobrando, ~3 s: antivírus e indexador do
  Windows seguram o arquivo por instantes) e a linha vira `pending` com a duração de
  `Progress::position_ms` e, quando a gravação falhou, `interrupted = 1` (`Queue::mark_interrupted`).
  `stop` só devolve erro quando a fila falha ou o `.part` segue preso; aí a linha fica em
  `recording` para a varredura.
- **Recuperação:** `session::recover_orphans(fila, vivas)` acerta cada linha em `recording` cujo
  id não está em `vivas`: renomeia o `.part` (o Ogg é legível até a última página escrita) e a
  passa a `pending` com `interrupted = 1`, uma linha por vez: um `rename` recusado deixa aquela
  linha como está, no log, e segue. Ao abrir, o app chama `session::recover` (órfãs sem vivas,
  mais o que ficou em `syncing` de volta a `pending` e todo `details_pending` caído: a folha que
  segurava o sync já não existe); a abertura nunca falha por um `.part` preso. Com o app aberto,
  o reaper chama `AppState::sweep_orphans` a cada minuto, com o id da gravação ativa lido e mantido
  sob o lock de estado (ordem estado → fila), e nenhuma gravação começa no meio da varredura.
  **Regra:** a varredura só toca linha `recording` cujo id não pertence a nenhuma sessão viva do
  processo; uma sessão em parada também conta como viva.
- `claim_next` reserva só `pending`, e pula a que tem `details_pending` até `DETAILS_WAIT_MS`
  (10 min) depois do fim: a folha esquecida aberta não segura o sync para sempre. `mark_failed` agenda `next_attempt_at` por
  `retry_backoff_ms` (30 s dobrando a cada tentativa, até 1 h); `retry_due(agora, max)` devolve à
  fila as falhas cujo prazo venceu, e `retry_failed(max)` as devolve já.
- `purge_candidates(até)` lista as `synced` com `remote_id` cujo arquivo ainda existe;
  `mark_purged` registra a remoção. Nada que o servidor não confirmou sai do disco.

## Pontos de extensão

Implementados pela `holetz/eclume#13`; o detalhe está em
[desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md).

- `Uploader::upload(&QueuedRecording) -> Result<String>` envia o arquivo e devolve o id remoto;
  `sync_pending(&Mutex<Queue>, &dyn Uploader)` passa por todas as `pending`, isola cada falha na
  própria linha e não segura a fila durante o upload. A implementação é o `HttpUploader` do
  `eclume-sync`, que guarda o upload em curso na fila compartilhada (`AppState::shared_queue()`).
- `MeetingDetector::poll() -> Option<MeetingEvent>` (`Started { app }` / `Ended`), consultado a
  cada segundo; a implementação é o `DebouncedDetector` do `eclume-detect`. A gravação que ele
  inicia usa `AppState::start_recording_as` com a origem (manual ou detecção, e o app), e a
  manual continua por `start_recording`.
- `AppState::set_syncing(bool)` liga o estado "Sincronizando" que a bandeja mostra.

## App e bandeja

- A janela nasce oculta e fechar só a esconde; o app vive na bandeja (AppIndicator no Linux, barra
  de menus no macOS, área de notificação no Windows). No Linux o clique só abre o menu, então toda
  ação mora nele, como o frame "Tray menu" do DS: a linha de status, "Iniciar gravação" ou "Parar
  gravação", "Nova nota", "Adicionar marcador" (só gravando), "Importar arquivo…", "Abrir o
  eclume", "Abrir a biblioteca na web" e "Sair" (que fecha a gravação em curso antes), com os
  atalhos como acelerador. A pergunta de reunião entra como dois itens. A UI da janela está em
  [desktop-interface.md](desktop-interface.md).
- O endereço do eclume web vem de `config.json` no diretório de config do app (`web_url`: o
  servidor em que a pessoa entrou, [desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md)) e
  pode ser sobreposto por `ECLUME_WEB_URL`.
- Abrir dispositivos pode levar segundos: iniciar/parar roda fora da thread da UI.
- **Parada fora do lock:** `AppState::stop_recording` tira `active` sob o estado e guarda o id em
  `stopping`; sem lock nenhum, `ActiveRecording::close` (sinal, join da thread de gravação,
  desmontagem do driver, `fsync`, `rename`); com a fila, `Closed::deliver`; sob o estado, limpa
  `stopping`. Enquanto `stopping` existe, o estado visível segue "Gravando", iniciar ou parar de
  novo é `Busy` e a varredura de órfãs conta o id como vivo. "Sair" fecha a gravação numa thread e
  chama `app.exit(0)` ao fim. Nenhum join de thread de captura espera sem prazo:
  `join_with_deadline` (`eclume-audio-capture`, 3 s) solta a thread presa com aviso no log.
- **Laços isolados de pânico:** o reaper, o sync, a pasta sincronizada, a detecção e o relógio da
  nota rodam cada passada por `supervise::pass` (`catch_unwind`); um pânico fica no log (com o
  backtrace do hook) e o laço espera 1 s dobrando até 60 s, zerada no sucesso. O updater roda cada
  checagem numa subtarefa e trata o `JoinError` de pânico do mesmo jeito. Um mutex envenenado não
  inutiliza o app: o estado e a fila seguem pelo `into_inner`, com o envenenamento no log.
- **Flag de "em curso" só por guarda:** `syncing`, `mirror.running` e `importing` se desligam no
  `Drop` de uma guarda (`AppState::syncing`, `mirror_running`, `import_guard`), que pega o estado
  mesmo envenenado: "Sincronizando" e "Já há uma importação em andamento" não ficam presos depois
  de um pânico.
- **Comandos `#[tauri::command(async)]`:** comando síncrono só lê ou escreve memória e a fila
  SQLite. Chaveiro, processo externo (`gsettings`), registro de início automático, arquivos fora
  da fila e rede vão em `#[tauri::command(async)]` (hoje `settings`, `save_settings`, `sign_out`,
  `storage_info`, `confirm_server`, `open_data_dir`, `open_log_dir`, além dos de rede). Abrir
  Configurações não consulta o chaveiro: a origem da credencial fica em cache no estado,
  atualizada ao entrar, sair e salvar. Um comando `async` nunca chama API do Tauri que despacha
  para a thread principal (atalhos, bandeja, janela) com o estado ou a fila presos.
- Quando a gravação para sozinha porque as fontes caíram ou porque a gravação falhou, o reaper
  (a cada segundo) fecha a linha e sai uma notificação do SO: "A gravação parou" com "<tempo>
  salvos · as fontes de áudio caíram" ou "<tempo> salvos · falha ao gravar"; a janela mostra o
  mesmo aviso.
- `config.json` é gravado por um temporário vizinho (`.config.json.tmp`) com `sync_all` e
  renomeação; falhando, o temporário é apagado. A abertura só o grava quando a versão aberta muda
  `last_version`. Um arquivo ilegível é renomeado para `config.json.ilegivel-<ms>` antes de o
  padrão valer, e a janela avisa "A configuração estava ilegível e voltou ao padrão; a cópia está
  em …".
- A bandeja (menu, ícone, título e dica) só é tocada na thread principal. Os setters do Tauri
  (`set_text`, `set_menu`, `set_icon`, `set_title`, `set_tooltip`) despacham para ela e bloqueiam
  até a resposta: uma thread de fundo que os chamasse segurando um lock que a thread principal
  também usa travaria o app (#83). Código de fundo pede a atualização por `tray::refresh` ou
  `refresh_ui`, que roda na hora na thread principal e, de outra thread, só enfileira; quem roda lê
  o estado do momento.
- O log (`info`, ou o filtro de `RUST_LOG`) vai para o stderr e para `eclume.log` no diretório de
  logs do app (`app_log_dir`: `%LOCALAPPDATA%\io.github.holetz.eclume\logs` no Windows,
  `~/.local/share/io.github.holetz.eclume/logs` no Linux, `~/Library/Logs/io.github.holetz.eclume`
  no macOS). Acima de 5 MB, o arquivo vira `eclume.log.1`, na abertura e também com o app aberto
  (o `Tee` conta os bytes e gira sob o lock do `env_logger`). No Windows o release
  não tem console, então o arquivo é o único registro de falhas de captura, sync e atualização.
  A primeira linha de cada abertura traz a versão e o SO. Um panic vai para o mesmo log (hook
  próprio) com a thread, o local e o backtrace: o hook padrão só escreve no stderr, que o app
  aberto pelo menu do sistema não guarda onde a pessoa ache.
