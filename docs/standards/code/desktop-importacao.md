---
type: standard
title: Importação de arquivos no app desktop
description: Como o app desktop importa um arquivo de áudio ou vídeo — diálogo nativo ou arrastar para a janela, a leitura da duração e da data de gravação (mvhd, tags, modificação) confirmada pela pessoa, a conversão local para Ogg/Opus mono 16 kHz a 32 kbps pelo symphonia e pela libopus, o fallback de copiar o original e a entrada na fila com source upload.
resource: desktop/crates/import/**, desktop/src-tauri/src/import.rs, desktop/ui/js/vistas/importar.js
tags: [code, desktop, importacao, audio, opus, symphonia]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#40
maintainer: holetz
---

# Importação de arquivos no app desktop

O app importa uma gravação feita fora dele (gravador, celular, a gravação de uma reunião) e a põe
na mesma fila das suas. O arquivo da pessoa nunca é tocado: o app lê, converte uma cópia e envia.
A parte pura vive no crate `eclume-import` (`desktop/crates/import`), testada com fixtures geradas
por ffmpeg (`tests/fixtures/gerar.sh`); o app (`src-tauri/src/import.rs`) liga o diálogo, os
eventos e a fila.

## Entrada

- "Importar arquivo…" (janela, bandeja e `Ctrl/⌘+O`) chama `pick_import_file`, o diálogo nativo
  do `tauri-plugin-dialog` aberto no Rust, com o filtro "Áudio e vídeo" (os 20 formatos de
  `import::EXTENSIONS`).
- Arrastar para a **janela** chega pelo `WindowEvent::DragDrop`, que emite `import-dropped` com o
  caminho. A janela não tem API de arquivo: ela só recebe caminhos do Rust. O ícone da bandeja ou
  do Dock não recebe arquivos.

## Leitura (`probe`)

`probe_import(path)` devolve `{duration_ms, has_audio, decodable, recorded_at, date_origin}` sem
decodificar o áudio. A data de gravação vem, nesta ordem de confiança:

| Ordem | Fonte | `date_origin` |
|---|---|---|
| 1 | MP4, MOV e M4A: o `creation_time` do `moov/mvhd`, lido por `mp4date.rs` sem dependência (versões 0 e 1, época de 1904); zero ou antes de 1990 não vale | `mvhd` |
| 2 | tags de data do `symphonia` (`RecordingDate`, `Date`, `OriginalDate`: ID3 `TDRC`/`TYER`, Vorbis `DATE`, MP4 `©day`), só com dia completo | `tag` |
| 3 | a data de modificação do arquivo menos a duração (o início provável) | `file_mtime` |

- A tela "Importar um arquivo" mostra o nome, a duração e o campo "Gravado em" na hora local, com
  a `.date-source`: "lida do arquivo" (1 e 2) ou "data de modificação do arquivo; confira" (3).
- Confirmar sem mudar envia `recorded_at_source: file_metadata`; mudar envia `user`. É a
  semântica do contrato (holetz/eclume#34): lida do arquivo e confirmada na importação.
- Um arquivo sem trilha de som é recusado antes da conversão.

## Conversão (`convert`)

- **Decodificação.** O `symphonia` 0.5 (Rust puro, MPL-2.0, sem modificação) decodifica MP3, AAC,
  ALAC, FLAC, Vorbis e PCM, nos contêineres MP4/MOV/M4A, MKV/WebM, Ogg e WAV. O Opus dentro de
  WebM e Ogg, que o `symphonia` só demultiplexa, vai para a libopus do crate `opus` que o recorder
  já traz. O vídeo é ignorado.
- **Codificação.** Mixagem para mono, o `Mixer` do recorder (o reamostrador do workspace) até
  16 kHz e o `OggOpusWriter` do recorder a **32 kbps**, o bitrate do navegador
  ([formato-audio-upload.md](formato-audio-upload.md)). Sai `gravacoes/<id>.ogg` (escrito como
  `.part` e renomeado no fim), com o progresso pelo evento `import-progress` (0 a 1).
- **Fallback.** Um codec ou contêiner que o `symphonia` não lê (AVI, AC-3, WMA, AMR) é **copiado**
  como está para `gravacoes/<id>.<ext>`, com o `content_type` pela extensão. O servidor aceita
  `audio/*` e `video/*`, e o worker decodifica com ffmpeg.
- **Cancelar** (`cancel_import`) interrompe entre pacotes e apaga o parcial. O fim sai por
  `import-finished` (o id na fila) ou `import-failed` (o texto do erro).

Por que converter no app: o vídeo de uma reunião tem GB, e o áudio que interessa, ~14 MB/h. O
servidor passa a receber o mesmo formato do navegador e do desktop. Por que `symphonia` e não um
ffmpeg embutido: um ffmpeg por plataforma soma ~80 MB, exige `externalBin` com binário universal no
macOS e traz LGPL/GPL conforme o build; o `symphonia` compila no `cargo xwin` e cobre os formatos
das fixtures do navegador, menos o AVI, que cai no fallback.

Por que copiar em vez de apontar para o original: a retenção apaga arquivos de `gravacoes/`, e o
arquivo da pessoa nunca pode ser apagado. A cópia também sobrevive se ela mover ou apagar o
original antes do envio.

## Entrada na fila

`queue.begin_import` cria a linha já `pending` ([desktop-gravacao.md](desktop-gravacao.md), fila
v3), com `source = 'upload'`, `kind = 'meeting'`, o `recorded_at` e a origem confirmados, o
`original_name` (o nome sem extensão) e o `content_type` só quando o arquivo foi copiado (nulo é
Ogg/Opus). O upload manda `filename` `<original_name>.<extensão do arquivo enviado>`, para o
título derivar dele, e a fila da janela mostra "kickoff-guion · 47 min".
