---
title: O que o eclume faz sozinho depois de cada gravação
topic: organizar
pages: [automacao]
related: [processing-stages, configure-agenda-type, registered-tags, automatic-collections, voice-suggestions]
terms: [processamento automático, automação, regras, depois da gravação, voz, marcação dos locutores, aguardando locutores, tipo de agenda, campos, tags, coleções, resumo]
order: 10
updated: 2026-10-05
---
Depois que uma gravação chega, o eclume segue sozinho uma sequência de etapas. A página
**Processamento automático**, em **Regras** na barra lateral, mostra todas na ordem em que
acontecem, como cada uma está agora e o caminho até a tela que a configura. As chaves ficam nas
telas de cada etapa; só a marcação dos locutores se liga ali mesmo.

## As etapas, em ordem

1. **Pré-processamento e transcrição:** o áudio é preparado, vira texto e é separado por
   locutor. Quem configura é quem administra o servidor; por isso a etapa não tem link.
2. **Locutores pela voz:** cada locutor é comparado com as vozes das pessoas cadastradas. Com a
   atribuição automática ligada em **Pessoas**, o locutor é ligado à pessoa sozinho quando a
   pontuação passa do mínimo que você escolheu; desligada, a voz só sugere. Veja
   [Como funcionam as sugestões por voz](/ajuda/voice-suggestions).
3. **Marcação dos locutores:** desligada, a gravação segue com "Locutor N" para quem a voz não
   reconheceu. Ligada (**Exigir a marcação dos locutores**), a gravação com algum locutor sem
   pessoa para em **Aguardando locutores** antes do tipo, dos campos, das coleções e do resumo. Ligue
   cada locutor a uma pessoa na página da gravação e o resto segue sozinho; **Seguir sem nomear**
   solta a gravação sem os nomes. A biblioteca avisa quantas esperam e tem o filtro **Precisam de
   você**. Desligar a chave solta todas as que estavam esperando.
4. **Tipo de agenda:** o agente escolhe o tipo da reunião entre os seus, em **Tipos de agenda**.
   O tipo dá o título, as tags padrão e as instruções do resumo. Veja
   [Configure um tipo de agenda](/ajuda/configure-agenda-type).
5. **Campos personalizados:** o agente preenche os campos marcados como automáticos em
   **Campos personalizados**.
6. **Tags:** junto com os campos, o agente marca os assuntos. Em **Tags** você escolhe se ele usa
   só as tags cadastradas ou pode criar novas. Veja [Cadastre as tags e deixe o agente usá-las](/ajuda/registered-tags).
7. **Coleções com regra:** a gravação entra sozinha nas coleções que têm regra e cuja regra ela
   cumpre. A regra fica em cada coleção, em **Coleções**. Veja
   [Deixe o agente pôr as gravações nas coleções](/ajuda/automatic-collections).
8. **Resumo:** o agente escreve o resumo pelas instruções do tipo de agenda escolhido.

## Quando algo não acontece

Se uma etapa foi pulada ou falhou numa gravação, o motivo aparece na barra de etapas da página da
gravação. Veja [O que cada etapa do processamento faz](/ajuda/processing-stages).
