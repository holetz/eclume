---
type: project
title: Referências de mercado
description: Soluções de mercado avaliadas (WhisperX, speaches, Anarlog, Meetily, OpenTranscribe, Scriberr) e como o eclume usa cada uma na estratégia compor.
resource: "**"
tags: [references, market, asr, desktop]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#1
maintainer: holetz
---

# Referências de mercado

Estratégia: **compor**. O eclume tem servidor próprio e enxuto. O motor de ASR é o WhisperX,
usado como biblioteca num worker GPU próprio. O desktop reaproveita crates MIT do Anarlog. O resto
se inspira em soluções existentes, sem forks. Pesquisa feita em 2026-09-24.

| Solução | Licença | Uso no eclume |
|---|---|---|
| [WhisperX](https://github.com/m-bain/whisperX) (24k★, v3.8.6) | BSD-2 | **Motor**, como biblioteca, no worker GPU: faster-whisper em lote, alinhamento por palavra (pt via wav2vec2 comunitário), pyannote `community-1` e embeddings de locutor. |
| [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service) | MIT | **Referência** de Dockerfile CUDA, fila de GPU e descarga de modelos. Não entra como sidecar (motivo abaixo). |
| [speaches](https://github.com/speaches-ai/speaches) (3.7k★) | MIT | Engine alternativa OpenAI-compatível (faster-whisper, sem diarização), plugável pela interface de engine. |
| [Anarlog](https://github.com/fastrepl/anarlog), ex-Hyprnote (9.4k★, Tauri 2) | MIT | **Crates Rust** reaproveitados no desktop: `detect` (mic em uso e app de reunião, com Windows, Linux e macOS), `audio-*`, `meeting-capture`, `vad`, `resampler`. |
| [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) | MIT | Referência de UX desktop e de mixagem de mic com áudio do sistema. |
| [OpenTranscribe](https://github.com/attevon-llc/OpenTranscribe) | AGPL-3.0 | **Só referência de UX**: biblioteca, busca, perfis de locutor e prompts por usuário. Nenhum código é copiado, por causa da AGPL. |
| [Scriberr](https://github.com/rishikanthc/Scriberr) | MIT | Referência de API keys, watcher de pasta e chat sobre a transcrição. |

## Por que WhisperX como biblioteca, e não o container pronto

O servidor tem uma GTX 1660 Super com 6 GB de VRAM, arquitetura Turing TU116 e sem tensor cores.

- **Um processo só.** O worker roda ASR, alinhamento, diarização e embeddings de locutor
  (`return_embeddings=True`) em sequência e carrega o pyannote uma única vez. Com o
  whisperx-asr-service como sidecar, o pyannote seria carregado duas vezes em 6 GB, e a impressão
  de voz viria de um modelo diferente do usado na diarização.
- **Configuração para a placa.** `large-v3-turbo` com `compute_type=int8_float16` (~2–3 GB) e
  pyannote `community-1` (~1 GB). O `fp16` puro fica evitado por causa do histórico de NaN na série
  GTX 16xx. Roda um job de GPU por vez, com descarga de modelos ociosos.
- **Sem Ollama residente.** Um LLM local não cabe junto do ASR. Esta produção resume com o
  `claude -p` (imagem com `ECLUME_CLAUDE_CLI=1`); o produto não exige a CLI, e uma API ou o Ollama,
  que só roda com a fila de ASR vazia, servem igual.
