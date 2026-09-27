---
titulo: Por que uma gravação falhou
topico: processamento
paginas: [gravacao]
relacionados: [tentar-de-novo, etapas-do-processamento, quanto-tempo-leva]
termos: [falha, erro, falhou, agente, fila, arquivo corrompido, sem agente]
ordem: 3
atualizado: 2026-09-27
---
Quando uma etapa falha, a barra de etapas da gravação marca qual foi e mostra o motivo. As causas
mais comuns, por etapa:

## Áudio recebido e transcrição

- **O arquivo não abre:** o arquivo chegou danificado ou num formato que o servidor não lê.
  Importe de novo a partir do original.
- **O processador de transcrição não respondeu:** o servidor tenta de novo algumas vezes sozinho.
  Se continuar, avise quem administra o servidor.

## Preenchimento de campos e tipo de agenda

- **Agente sem configuração:** o servidor não tem um agente para essa etapa. Ela aparece como
  pulada, e não como falha.
- **Agente fora do ar ou com resposta inválida:** o servidor tenta de novo algumas vezes antes de
  marcar a falha.

Uma falha no preenchimento não impede as etapas seguintes: o tipo de agenda e o resumo rodam do
mesmo jeito, e os campos ficam vazios para você preencher. Já sem o tipo de agenda o resumo não
tem instruções e fica pulado. Escolha o tipo à mão na gravação, e o resumo sai por ele. Veja
[Tente de novo uma etapa que falhou](/ajuda/tentar-de-novo).

## Resumo

O resumo falha quando o agente de resumos está fora do ar ou demora demais. O servidor tenta de
novo antes de desistir, e você pode pedir outro resumo na página da gravação.
