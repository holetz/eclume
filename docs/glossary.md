---
type: concept
title: Glossário
description: A busca A–Z única de termos, siglas e vocabulário de domínio do eclume — uma entrada por termo, com link para o doc completo quando ele existe.
resource: docs/**
tags: [glossary, vocabulary, terminology]
timestamp: 2026-09-24
audience: both
authority: current
source: claude-quenching skeleton
maintainer: holetz
---

# Glossário

A **fonte única do que um termo significa aqui**. Uma entrada por termo, na mesma sintaxe de
bullet de todo `index.md`: o termo com link para um doc completo e uma definição de uma frase, ou
o termo em negrito com a definição quando não há doc.

**Resolvendo um termo.** Quando uma palavra, sigla ou jargão do repositório não estiver claro,
**procure aqui primeiro** (`grep -i '<termo>' docs/glossary.md`). Sem entrada, o termo ainda não
foi definido — registre-o com `/quenching:knowledge:define`.

**Este arquivo é a exceção deliberada a "um conceito por arquivo"**: uma lista plana, ordenada
alfabeticamente pelo termo, com uma frase por definição e link para fora em vez de explicação.
Uma entrada **sem link** (termo sem doc próprio) é um estado válido e permanente.

## Terms

- [Anarlog](project/referencias.md) — App de notas de reunião (Tauri 2, MIT) de onde o desktop do eclume reaproveita crates Rust de detecção e captura de áudio.
- [contrato de jobs](standards/api/jobs-transcricao.md) — Acordo entre o server e o worker GPU: filas arq `eclume:gpu`/`eclume:default`, job `transcribe`, artefatos no bucket e `ingest_transcript`/`transcription_failed`.
- [contrato v1](standards/api/contrato-v1.md) — OpenAPI e JSON Schema da transcrição em `contracts/`, fonte da verdade entre o eclume e os clientes; só evolui de forma aditiva.
- **diarização** — Separação de uma gravação em trechos por locutor ("quem falou quando"), feita no worker GPU pelo pyannote.
- **eclume** — Serviço de transcrição institucional e auto-hospedado (eco + lume), extraído do lumea e ligado a ele só por contrato de API.
- **engine** — Implementação da interface de ASR do pacote `eclume_engines` (`whisperx-local`, remota OpenAI-compatível ou CPU para dev).
- **épico** — Spec orquestradora (`holetz/eclume#1`) cujas tasks apontam para specs filhas, cada uma uma issue própria.
- [ffmpeg.wasm](standards/code/formato-audio-upload.md) — O ffmpeg compilado para WebAssembly, fallback da conversão no navegador para contêineres e codecs que o WebCodecs não atende.
- [host GPU](project/host-setup.md) — O servidor `192.168.15.199` (GTX 1660 Super, 6 GB) onde rodam os containers do eclume e do lumea, acessado por `docker --context gpu-host`.
- **impressão de voz** — Embedding de locutor, do mesmo modelo da diarização, usado para sugerir a pessoa que falou; dado biométrico sensível pela LGPD.
- **lumea** — Plataforma de desenvolvimento humano e organizacional da EK, que importa transcrições do eclume por PAT.
- [Mediabunny](standards/code/formato-audio-upload.md) — Biblioteca TypeScript de demux, conversão e mux sobre WebCodecs, a via principal da conversão de mídia no navegador.
- [mock server](../contracts/README.md) — Prism servindo o bundle do contrato v1 com as fixtures (`deploy/docker-compose.mock.yml`, `127.0.0.1:4010`), contra o qual o lumea, o desktop e o web desenvolvem sem o backend.
- **OKF** — Open Knowledge Format: o formato do bundle `docs/`, com homes fixas e frontmatter por doc.
- **PAT** — Personal Access Token: token pessoal com escopo, guardado como hash, usado pelo lumea e pelo desktop para acessar a API.
- **pilar** — Uma das pastas de topo do monorepo com toolchain própria: `server/`, `worker-gpu/`, `engines/`, `web/`, `desktop/`, `contracts/`, `deploy/`.
- [RLS](standards/code/server-nucleo.md) — Row-Level Security do Postgres: as políticas por organização e dono que isolam os dados do eclume sob o papel `eclume_app`.
- **spec** — Unidade de trabalho do ciclo Quenching, guardada como issue do GitHub e conduzida por `develop` → `execute` → `conclude`.
- [WhisperX](project/referencias.md) — Biblioteca de ASR (faster-whisper em lote, alinhamento por palavra, diarização pyannote) usada como motor no worker GPU.
- [updater](standards/code/desktop-distribuicao.md) — Atualização automática do app desktop pelo plugin do Tauri: lê `latest.json` em `/downloads/` do servidor eclume e só instala o pacote assinado com a chave minisign do eclume.
- **worker CPU** — O processo arq do pacote `server` (`eclume_server.worker`, fila `eclume:default`) que ingere as transcrições do worker GPU e descarta uploads vencidos.
- **worker GPU** — O processo arq do pilar `worker-gpu/` que roda ASR, alinhamento, diarização e embeddings num único processo CUDA.
