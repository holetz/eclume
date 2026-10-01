---
titulo: O que cada etapa do processamento faz
topico: processamento
paginas: [gravacao, biblioteca]
relacionados: [pre-processamento, por-que-falhou, quanto-tempo-leva]
termos: [etapas, pipeline, processando, status, pulada, esperando, transcrevendo, resumindo]
ordem: 1
atualizado: 2026-10-01
---
Toda gravação passa pelas mesmas seis etapas, uma depois da outra. A barra de etapas no alto da
página da gravação mostra em qual ela está.

## As seis etapas

1. **Áudio recebido:** o arquivo chegou inteiro ao servidor.
2. **Pré-processamento:** o áudio é preparado para a transcrição, conforme o que quem administra o
   servidor ligou. Veja [O que o pré-processamento faz com o áudio](/ajuda/pre-processamento).
3. **Transcrição:** a fala vira texto, separada por locutor e com o tempo de cada fala.
4. **Tipo de agenda:** um agente escolhe o tipo que melhor descreve a gravação, entre os seus.
   Quando nenhum se encaixa com boa confiança, fica o tipo padrão. O tipo dá as tags padrão e a
   regra do título.
5. **Campos:** um agente lê a transcrição e preenche os campos marcados como
   automáticos, como as tags e os campos que você criou, e escreve o assunto pela regra do tipo. O
   título é montado pelo padrão do tipo.
6. **Resumo:** o agente escreve o resumo pelas instruções do tipo escolhido.

## Os estados de uma etapa

Cada etapa diz o estado em palavra, ao lado do nome, sem depender da cor da barra.

- **Esperando:** a etapa ainda não começou.
- **Em andamento:** a etapa está rodando agora, com o nome do que faz (por exemplo, "Transcrevendo").
- **Concluída:** a etapa terminou; aparece só o nome dela.
- **Falhou:** algo deu errado. O motivo aparece em texto embaixo da barra e, quando dá, o botão para
  tentar de novo. Veja [Por que uma gravação falhou](/ajuda/por-que-falhou).
- **Pulada:** a etapa não precisou ou não pôde rodar, e o motivo aparece em texto embaixo da barra.
  Por exemplo: "Resumo · pulada: nenhum agente configurado; fale com quem administra".

Uma gravação fica **Pronta** quando a última etapa termina, pulada ou não. Na biblioteca, ela
aparece **Na fila** enquanto espera a vez da transcrição, com o nome da etapa enquanto anda, e
**Falhou** ou **Cancelada** quando a transcrição não terminou.

## Por que a gravação espera na fila

Enquanto a gravação está **Na fila**, a página dela diz por que espera, numa frase:

- **Na fila do processador:** a posição ("3ª na fila") e, quando há histórico, quando deve começar
  ("começa em cerca de 12 min (estimativa)"). A previsão sai da duração das últimas transcrições e
  é só uma estimativa.
- **Atrás das suas gravações:** o servidor transcreve uma gravação de cada conta por vez; as suas
  entram na ordem em que chegaram, e a frase diz quantas vêm antes.
- **Minutos de 24 h esgotados:** a conta passou dos minutos de transcrição das últimas 24 h, e a
  frase diz a que horas a gravação entra.
- **Processador fora do ar:** a frase diz desde quando. A gravação está guardada e entra sozinha
  quando ele voltar.

Esperar nunca vira falha: a gravação segue na fila até a vez dela.
