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
- **diarização** — Separação de uma gravação em trechos por locutor ("quem falou quando"), feita no worker GPU pelo pyannote.
- **eclume** — Serviço de transcrição institucional e auto-hospedado (eco + lume), extraído do lumea e ligado a ele só por contrato de API.
- **engine** — Implementação da interface de ASR do pacote `eclume_engines` (`whisperx-local`, remota OpenAI-compatível ou CPU para dev).
- **épico** — Spec orquestradora (`holetz/eclume#1`) cujas tasks apontam para specs filhas, cada uma uma issue própria.
- [host GPU](project/host-setup.md) — O servidor `192.168.15.199` (GTX 1660 Super, 6 GB) onde rodam os containers do eclume e do lumea, acessado por `docker --context gpu-host`.
- **impressão de voz** — Embedding de locutor, do mesmo modelo da diarização, usado para sugerir a pessoa que falou; dado biométrico sensível pela LGPD.
- **lumea** — Plataforma de desenvolvimento humano e organizacional da EK, que importa transcrições do eclume por PAT.
- **OKF** — Open Knowledge Format: o formato do bundle `docs/`, com homes fixas e frontmatter por doc.
- **PAT** — Personal Access Token: token pessoal com escopo, guardado como hash, usado pelo lumea e pelo desktop para acessar a API.
- **pilar** — Uma das pastas de topo do monorepo com toolchain própria: `server/`, `worker-gpu/`, `engines/`, `web/`, `desktop/`, `contracts/`, `deploy/`.
- **spec** — Unidade de trabalho do ciclo Quenching, guardada como issue do GitHub e conduzida por `develop` → `execute` → `conclude`.
- [WhisperX](project/referencias.md) — Biblioteca de ASR (faster-whisper em lote, alinhamento por palavra, diarização pyannote) usada como motor no worker GPU.
- **worker GPU** — O processo arq do pilar `worker-gpu/` que roda ASR, alinhamento, diarização e embeddings num único processo CUDA.
