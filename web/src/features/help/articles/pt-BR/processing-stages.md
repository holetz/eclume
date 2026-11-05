---
title: O que cada etapa do processamento faz
topic: processamento
pages: [gravacao, biblioteca]
related: [preprocessing, why-it-failed, how-long-it-takes]
terms: [etapas, pipeline, processando, status, pulada, esperando, transcrevendo, resumindo, aguardando locutores, aguardando você]
order: 1
updated: 2026-10-08
---
Toda gravação passa pelas mesmas sete etapas, uma depois da outra. A barra de etapas no alto da
página da gravação mostra em qual ela está.

## As sete etapas

1. **Áudio recebido:** o arquivo chegou inteiro ao servidor.
2. **Pré-processamento:** o áudio é preparado para a transcrição, conforme o que quem administra o
   servidor ligou. Veja [O que o pré-processamento faz com o áudio](/ajuda/preprocessing).
3. **Transcrição:** a fala vira texto, separada por locutor e com o tempo de cada fala. Na
   [nota de voz](/ajuda/voice-notes) há um locutor só, sem separação de vozes.
4. **Locutores:** depois da identificação pela voz, confere se todo locutor com fala tem uma
   pessoa. Só para a gravação quando a sua conta exige a marcação dos locutores (em
   **Processamento automático**); aí ela fica **Aguardando locutores** até você ligar cada locutor
   a uma pessoa ou escolher **Seguir sem nomear**.
5. **Tipo de agenda:** um agente escolhe o tipo que melhor descreve a gravação, entre os seus.
   Quando nenhum se encaixa com boa confiança, fica o tipo padrão. O tipo dá as tags padrão e a
   regra do título.
6. **Campos:** um agente lê a transcrição e preenche os campos marcados como
   automáticos, como as tags e os campos que você criou, e escreve o assunto pela regra do tipo. O
   título é montado pelo padrão do tipo.
7. **Resumo:** o agente escreve o resumo pelas instruções do tipo escolhido.

## Os estados de uma etapa

Cada etapa diz o estado em palavra, ao lado do nome, sem depender da cor da barra.

- **Esperando:** a etapa ainda não começou.
- **Em andamento:** a etapa está rodando agora, com o nome do que faz (por exemplo, "Transcrevendo").
- **Concluída:** a etapa terminou; aparece só o nome dela.
- **Falhou:** algo deu errado. O motivo aparece em texto embaixo da barra e, quando dá, o botão para
  tentar de novo. Veja [Por que uma gravação falhou](/ajuda/why-it-failed).
- **Aguardando você:** só a etapa **Locutores**: a gravação espera você nomear os locutores sem
  pessoa, e o motivo aparece embaixo da barra. Quando o último ganha nome, o resto segue sozinho.
- **Pulada:** a etapa não precisou ou não pôde rodar, e o motivo aparece em texto embaixo da barra.
  Por exemplo: "Resumo · pulada: nenhum agente configurado; fale com quem administra".

Uma gravação fica **Pronta** quando a última etapa termina, pulada ou não. Na biblioteca, ela
aparece **Na fila** enquanto espera a vez da transcrição, com o nome da etapa enquanto anda,
**Aguardando locutores** quando espera os nomes, e **Falhou** ou **Cancelada** quando a
transcrição não terminou. O filtro **Precisam de você** da biblioteca junta as que esperam os nomes.

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
