---
titulo: O que cada etapa do processamento faz
topico: processamento
paginas: [gravacao, biblioteca]
relacionados: [pre-processamento, por-que-falhou, quanto-tempo-leva]
termos: [etapas, pipeline, processando, status, pulada, esperando, transcrevendo, resumindo]
ordem: 1
atualizado: 2026-09-27
---
Toda gravação passa pelas mesmas seis etapas, uma depois da outra. A barra de etapas no alto da
página da gravação mostra em qual ela está.

## As seis etapas

1. **Áudio recebido:** o arquivo chegou inteiro ao servidor.
2. **Pré-processamento:** o áudio é preparado para a transcrição, conforme o que quem administra o
   servidor ligou. Veja [O que o pré-processamento faz com o áudio](/ajuda/pre-processamento).
3. **Transcrição:** a fala vira texto, separada por locutor e com o tempo de cada fala.
4. **Preenchimento de campos:** um agente lê a transcrição e preenche os campos marcados como
   automáticos, como o título, as tags e os campos que você criou.
5. **Tipo de agenda:** um agente escolhe o tipo que melhor descreve a gravação, entre os seus. O
   tipo aplica o padrão de título e as tags padrão.
6. **Resumo:** o agente escreve o resumo pelas instruções do tipo escolhido.

## Os estados de uma etapa

- **Esperando:** a etapa ainda não começou. Em geral, a gravação está na fila.
- **Em andamento:** a etapa está rodando agora.
- **Pronta:** a etapa terminou.
- **Falhou:** algo deu errado. A página mostra o motivo e, quando dá, o botão para tentar de novo.
  Veja [Por que uma gravação falhou](/ajuda/por-que-falhou).
- **Pulada:** a etapa não precisou ou não pôde rodar, e o motivo aparece junto. Por exemplo: nenhum
  campo está marcado como automático, ou o servidor não tem um agente configurado para aquela
  etapa.

Uma gravação fica **pronta** quando a última etapa termina, pulada ou não.
