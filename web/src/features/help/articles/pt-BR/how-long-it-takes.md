---
title: Quanto tempo leva
topic: processamento
pages: [gravacao, biblioteca]
related: [processing-stages, why-it-failed, import-files]
terms: [demora, fila, espera, GPU, tempo, processando, aviso, notificação, resumo pronto]
order: 5
updated: 2026-10-01
---
O tempo até uma gravação ficar pronta depende mais da fila do que do tamanho do áudio.

## A fila

O servidor tem um processador de transcrição (a GPU) que atende uma gravação por vez, na ordem de
chegada. Enquanto espera, a gravação aparece como **Na fila** na biblioteca, e a transcrição como
**Esperando** na barra de etapas.

## Depois que chega a vez dela

Uma reunião de uma hora costuma ficar pronta em poucos minutos depois de começar a transcrição. O
tipo de agenda, os campos e o resumo levam mais alguns segundos a um
minuto, conforme o agente configurado no servidor.

## Quando demora mais

- Muitas gravações chegaram juntas, como no fim de um dia cheio de reuniões.
- Um agente demorou a responder, e o servidor está tentando de novo.

A página da gravação se atualiza sozinha: não precisa recarregar.

## Saber quando ficou pronta

Você não precisa ficar olhando a página. O eclume avisa quando o processamento de uma gravação
termina: **resumo pronto**, **o resumo falhou**, **pronta sem resumo** (com o motivo) ou **a
transcrição falhou**. Cancelar ou excluir o resumo é ação sua e não gera aviso.

- **No app desktop**, o aviso chega para todas as gravações da sua conta, vindas do computador, do
  celular ou do navegador. O de resumo pronto tem **Copiar** e **Abrir**; os outros, **Abrir**. Ele
  se desliga em Configurações › Avisos.
- **No navegador**, com uma aba do eclume aberta, o título da aba conta os avisos que chegaram
  enquanto você estava em outra aba, como "(2) Biblioteca · eclume". Para receber também o aviso do
  sistema, ligue **Avisar no navegador** em Ambiente, ou toque em **Avisar quando ficar pronta** ao
  importar um arquivo. A escolha vale só para aquele navegador.
- **No celular**, o app não avisa: ele só fala com o servidor no Wi‑Fi do eclume. A lista mostra o
  título que o servidor deu à gravação, e o detalhe tem **Abrir na web**.
