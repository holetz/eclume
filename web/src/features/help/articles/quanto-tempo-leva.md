---
titulo: Quanto tempo leva
topico: processamento
paginas: [gravacao, biblioteca]
relacionados: [etapas-do-processamento, por-que-falhou, importar-arquivos]
termos: [demora, fila, espera, GPU, tempo, processando]
ordem: 5
atualizado: 2026-10-01
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
