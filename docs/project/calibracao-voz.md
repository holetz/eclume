---
type: project
title: Calibração do limiar de identificação por voz
description: Como o limiar de sugestão por voz do eclume foi escolhido — 33 leitores reais do LibriVox em 127 reuniões sintéticas diarizadas pelo pyannote community-1 na GTX 1660 SUPER, taxas de falso positivo e falso negativo por limiar, por modo de comparação e por tempo de fala, e o limiar 0,55 com centroide normalizado.
resource: worker-gpu/scripts/voice_calibration.py, server/src/eclume_server/voice.py
tags: [voz, calibracao, limiar, pyannote, lgpd, benchmark]
timestamp: 2026-09-25
audience: both
authority: current
source: holetz/eclume#15
maintainer: holetz
---

# Calibração do limiar de identificação por voz

A sugestão por voz ([identificacao-por-voz.md](/docs/standards/code/identificacao-por-voz.md))
compara o embedding de cada locutor novo com a impressão das pessoas que consentiram. Este é o
experimento que escolheu o modo de comparação, o limiar padrão e a fala mínima.

## Dados

- **Fala real em português**, do LibriVox (domínio público): 14 coleções com o leitor de cada
  seção no catálogo. Entraram **33 leitores** com duas seções ou mais, até 4 seções por leitor, de
  coleções diferentes quando possível. Cada seção é uma sessão de gravação diferente. Só os
  primeiros 5 min de cada seção foram usados.
- **Reuniões sintéticas**: 127 "reuniões" de 2 ou 3 leitores em turnos alternados de 6 a 25 s,
  com 15, 30, 60, 120 ou 240 s de fala por leitor. Foram convertidas para o formato do upload
  (Opus mono 16 kHz, 32 kbps) e diarizadas pelo `DiarizationPipeline` do WhisperX com
  `return_embeddings=True`. É o mesmo caminho e o mesmo modelo do worker GPU
  (`pyannote/speaker-diarization-community-1`, embeddings
  `pyannote/wespeaker-voxceleb-resnet34-LM`, 256 dimensões).
- **O bench de 1 h** do worker (`/srv/eclume/bench/bench-1h.ogg`), com os turnos pelos contos:
  Leni, Vicente Costa Filho e Pontedura.
- **O locutor diarizado é casado com o leitor** pela sobreposição com os turnos conhecidos. Um
  locutor com menos de 80% da fala de um leitor só foi descartado: 4 de 337, um deles o
  Vicente do bench, que a diarização juntou com outro leitor.
- Resultado: **333 locutores rotulados**, de 115 seções e 33 leitores; mediana de 49 s de fala
  por locutor, mínimo de 5,5 s.

## Protocolo

- **Teste**: cada locutor rotulado, comparado com a impressão de cada um dos 33 leitores.
- **Impressão**: `k` amostras sorteadas do leitor, de reuniões e seções **diferentes** das do
  teste. Assim o par genuíno nunca vem da mesma sessão de gravação.
- **Pares**: 330 genuínos (mesmo leitor) e 10.656 impostores (leitor diferente), com `k = 3`.
- **Modos de comparação**:
  - `centroid`: cosseno com a média normalizada das amostras normalizadas, como o
    `l2_normalize(avg(l2_normalize(...)))` do server;
  - `max`: o maior cosseno com uma amostra;
  - `mean`: a média dos cossenos.
- **Falso positivo (FPR)** é o impostor acima do limiar. **Falso negativo (FNR)** é o genuíno
  abaixo dele.

```bash
python3 worker-gpu/scripts/voice_calibration.py manifest --out manifest.json
docker --context gpu-host run --rm -v <dir>:/work eclume-worker-gpu:prod \
  python /work/voice_calibration.py prepare /work/manifest.json --work /work
docker --context gpu-host run --rm --gpus all -v /srv/eclume/models:/models \
  -v /srv/eclume/secrets/hf_token:/run/secrets/hf_token:ro -v /srv/eclume/bench:/bench:ro -v <dir>:/work \
  eclume-worker-gpu:prod python /work/voice_calibration.py embed --work /work --out /work/embeddings.json --extra /work/extra.json
python3 worker-gpu/scripts/voice_calibration.py analyze embeddings.json
```

Custo no host: a diarização das 128 reuniões (~9 h de áudio) levou 25 min na GTX 1660 SUPER, com o
worker de produção ocioso ao lado.

## Resultados

### Por modo, com a impressão de 3 amostras

| Modo | EER | Limiar com FPR 1% | FNR nele | Limiar com FPR 0,1% | FNR nele |
|---|---|---|---|---|---|
| centroide, 1 amostra | 2,1% | 0,460 | 2,1% | 0,575 | 4,2% |
| **centroide, 3 amostras** | **0,9%** | 0,460 | 0,9% | 0,565 | 3,6% |
| máximo, 3 amostras | 0,9% | 0,485 | 0,9% | 0,605 | 2,7% |
| média dos cossenos, 3 | 1,2% | 0,440 | 1,2% | 0,545 | 4,2% |

### Centroide com 3 amostras, por limiar

| Limiar | FPR | FNR |
|---|---|---|
| 0,40 | 2,99% | 0,91% |
| 0,45 | 1,19% | 0,91% |
| 0,50 | 0,44% | 0,91% |
| **0,55** | **0,17%** | **3,64%** |
| 0,60 | 0,07% | 3,94% |
| 0,65 | 0,06% | 4,55% |
| 0,70 | 0,05% | 5,76% |

### Centroide com 3 amostras, no limiar 0,55, pela fala do locutor testado

| Fala | FPR | FNR | Impostores | Genuínos |
|---|---|---|---|---|
| < 20 s | 0,10% | 1,6% | 2.048 | 63 |
| 20–45 s | 0,26% | 2,8% | 2.304 | 71 |
| 45–90 s | 0,24% | 4,5% | 2.112 | 66 |
| 90–180 s | 0,09% | 7,0% | 2.272 | 71 |
| ≥ 180 s | 0,16% | 1,7% | 1.920 | 59 |

### Distribuições

- **Genuínos** (centroide, 3 amostras): p1 0,51, p5 0,68, mediana 0,88.
- **Impostores**: mediana 0,14, p99 0,46, p99,9 0,56.
- **Os raros impostores altos** (máximo 0,92) vêm de poucos pares de leitores próximos. Os
  centroides mais parecidos são AlexOliveira75 e Rennê Luduvico, com 0,58. Há também ruído de
  rótulo: um leitor do catálogo, Vicente Costa Filho, tem duas amostras com cosseno 0,15 entre
  si, o que sugere uma seção lida por outra pessoa.
- **As duas vozes sintéticas** do diálogo de teste da #8 (Piper, faber e cadu) ficam em 0,33.

## Decisão

- **Modo: centroide normalizado das amostras**, com o menor EER junto com o máximo. É uma
  agregação só no SQL, estável quando uma amostra é ruim, e não cresce em custo com o número de
  amostras. O "máximo" ganha pouco em FNR e perde em FPR.
- **Limiar padrão: 0,55.** Com FPR de 0,17% por comparação, uma organização com 50 pessoas com
  consentimento tem ~8% de chance de uma sugestão errada para um locutor desconhecido. A sugestão
  nunca liga sozinha, e recusar custa um clique. Com FNR de ~4%, a pessoa certa quase sempre
  aparece. Abaixo de 0,50 o FPR triplica; acima de 0,60 quase não ganha precisão.
- **Fala mínima de 10 s** para comparar e para virar amostra. Nem o locutor mais curto (5,5 s)
  piorou as taxas. O corte protege de fragmentos de diarização de 1–2 s, que o experimento não
  tem.
- **Audiolivro não é reunião.** Leitura limpa, sem sobreposição e com microfone próximo separa
  melhor que uma sala real. Em reuniões, os genuínos devem cair mais que os impostores subir. Por
  isso o limiar fica no ponto de FPR ≈ 0,1–0,2%, não no do EER, e o admin pode ajustá-lo em
  Administração → Identificação por voz. A trilha de auditoria (`suggested`/`rejected`/
  `accepted` com `score`) é a base para recalibrar com dados reais da organização.
