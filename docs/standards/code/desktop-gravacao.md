---
type: standard
title: Gravação no app desktop
description: O app desktop grava mic e áudio do sistema mixados em Ogg/Opus mono 16 kHz (24 kbps), registra cada gravação numa fila SQLite local (v2) com estados recording → pending → syncing → synced ou failed, retomada, backoff e retenção, e expõe os traits Uploader e MeetingDetector que o sync e a detecção implementam — este é o formato, o ciclo de vida e os pontos de extensão.
resource: desktop/crates/recorder/**, desktop/crates/audio-capture/**, desktop/src-tauri/src/**
tags: [code, desktop, audio, opus, fila, sqlite, tauri]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#6
maintainer: holetz
---

# Gravação no app desktop

O app desktop grava reuniões na máquina do usuário e as guarda até o sync. Tudo que não depende
de dispositivo vive no crate `eclume-recorder` (`desktop/crates/recorder`), testável com áudio
sintético; a captura real vive em `eclume-audio-capture` (`desktop/crates/audio-capture`).

## Fontes

- Duas fontes por gravação: o **mic** padrão (`cpal`) e o **áudio do sistema** (loopback) —
  PipeWire seguindo o sink em uso, com fallback para o monitor do Pulse, no Linux; WASAPI loopback
  seguindo o endpoint em uso no Windows; Core Audio process tap no macOS (14.2+).
- Toda fonte implementa `AudioSource`: `sample_rate()` e `read(timeout)`, que devolve amostras mono
  `f32` na taxa nativa — `Some(vec![])` quando o prazo vence sem amostras, `None` quando a fonte
  acabou. A taxa pode mudar no meio da gravação e é relida a cada leitura.
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
silêncio e desconta essa dívida das amostras que chegarem depois — assim um monitor de sink
suspenso não trava a gravação nem desalinha as faixas.

## Arquivos e fila

- Os dados ficam no diretório de dados do app (`app_data_dir`): `queue.sqlite` e `gravacoes/`.
- A gravação nasce como `gravacoes/<id>.ogg.part` e vira `<id>.ogg` ao parar.
- A fila é a tabela `recordings` (`id`, `path`, `started_at`, `ended_at`, `duration_ms`, `bytes`,
  `status`, `interrupted`, `attempts`, `last_error`, `remote_id`), com instantes em milissegundos
  Unix. O esquema v2 (`user_version = 2`) acrescenta `upload_id` e `sha256` (retomada do upload),
  `next_attempt_at` (backoff), `synced_at` (confirmação do servidor), `purged_at` (arquivo local
  apagado pela retenção) e `meeting_app` (app da reunião detectada, no vocabulário do contrato).
  Uma fila v1 ganha as colunas na abertura, sem perder linhas.

```
recording ──parar──▶ pending ──claim_next──▶ syncing ──▶ synced ──retenção──▶ (purged_at)
    │                   ▲                        │
    └─crash: recover────┘ (interrupted = 1)      └──▶ failed ──retry_due / retry_failed──▶ pending
```

- **Recuperação:** ao abrir, o app chama `session::recover`: cada linha ainda em `recording` tem o
  `.part` renomeado (o Ogg é legível até a última página escrita) e vira `pending` com
  `interrupted = 1`; o que ficou em `syncing` volta a `pending`.
- `claim_next` reserva só `pending`. `mark_failed` agenda `next_attempt_at` por
  `retry_backoff_ms` (30 s dobrando a cada tentativa, até 1 h); `retry_due(agora, max)` devolve à
  fila as falhas cujo prazo venceu, e `retry_failed(max)` as devolve já.
- `purge_candidates(até)` lista as `synced` com `remote_id` cujo arquivo ainda existe;
  `mark_purged` registra a remoção. Nada que o servidor não confirmou sai do disco.

## Pontos de extensão

Implementados pela spec `desktop-deteccao-e-sync`; o detalhe está em
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
  ação mora nele: status (com quantas gravações faltam sincronizar), iniciar/parar, abrir o eclume
  web, mostrar gravações e sair (sair fecha a gravação em curso antes).
- O endereço do eclume web vem de `config.json` no diretório de config do app (`web_url`, padrão
  `https://192.168.15.199:8443`) e pode ser sobreposto por `ECLUME_WEB_URL`.
- Abrir dispositivos pode levar segundos: iniciar/parar roda fora da thread da UI.
