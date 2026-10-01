---
titulo: O que o eclume faz sozinho depois de cada gravação
topico: organizar
paginas: [automacao]
relacionados: [etapas-do-processamento, configurar-tipo-de-agenda, tags-cadastradas, colecoes-automaticas, sugestoes-por-voz]
termos: [processamento automático, automação, regras, depois da gravação, voz, tipo de agenda, campos, tags, coleções, resumo]
ordem: 10
atualizado: 2026-10-01
---
Depois que uma gravação chega, o eclume segue sozinho uma sequência de etapas. A página
**Processamento automático**, em **Regras** na barra lateral, mostra todas na ordem em que
acontecem, como cada uma está agora e o caminho até a tela que a configura. Ela só mostra: as
chaves continuam nas telas de cada etapa.

## As etapas, em ordem

1. **Pré-processamento e transcrição:** o áudio é preparado, vira texto e é separado por
   locutor. Quem configura é quem administra o servidor; por isso a etapa não tem link.
2. **Locutores pela voz:** cada locutor é comparado com as vozes das pessoas cadastradas. Com a
   atribuição automática ligada em **Pessoas**, o locutor é ligado à pessoa sozinho quando a
   pontuação passa do mínimo que você escolheu; desligada, a voz só sugere. Veja
   [Como funcionam as sugestões por voz](/ajuda/sugestoes-por-voz).
3. **Tipo de agenda:** o agente escolhe o tipo da reunião entre os seus, em **Tipos de agenda**.
   O tipo dá o título, as tags padrão e as instruções do resumo. Veja
   [Configure um tipo de agenda](/ajuda/configurar-tipo-de-agenda).
4. **Campos personalizados:** o agente preenche os campos marcados como automáticos em
   **Campos personalizados**.
5. **Tags:** junto com os campos, o agente marca os assuntos. Em **Tags** você escolhe se ele usa
   só as tags cadastradas ou pode criar novas. Veja [Cadastre as tags e deixe o agente usá-las](/ajuda/tags-cadastradas).
6. **Coleções com regra:** a gravação entra sozinha nas coleções que têm regra e cuja regra ela
   cumpre. A regra fica em cada coleção, em **Coleções**. Veja
   [Deixe o agente pôr as gravações nas coleções](/ajuda/colecoes-automaticas).
7. **Resumo:** o agente escreve o resumo pelas instruções do tipo de agenda escolhido.

## Quando algo não acontece

Se uma etapa foi pulada ou falhou numa gravação, o motivo aparece na barra de etapas da página da
gravação. Veja [O que cada etapa do processamento faz](/ajuda/etapas-do-processamento).
