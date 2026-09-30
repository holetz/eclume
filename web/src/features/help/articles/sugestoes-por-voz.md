---
titulo: Como funcionam as sugestões por voz
topico: transcricao
paginas: [pessoas, pessoa, gravacao]
relacionados: [ligar-locutor-a-pessoa, esquecer-a-voz, corrigir-transcricao]
termos: [impressão de voz, biometria, LGPD, limiar, identificação por voz]
ordem: 2
atualizado: 2026-09-30
---
Quando um locutor da transcrição ainda não está ligado a ninguém, o eclume pode sugerir quem é,
comparando a voz com a impressão de voz das pessoas que **você** cadastrou.

## O que é uma impressão de voz

É um conjunto de amostras de uma pessoa: os trechos de fala em que você confirmou que um locutor
era ela. Usa o mesmo modelo que separa os locutores na transcrição.

## Quando o eclume sugere uma pessoa

A sugestão aparece quando a voz fica perto o bastante de uma impressão para passar do limiar que
quem administra o servidor definiu, mas não chega à sua pontuação mínima de atribuição automática.

- Uma sugestão nunca liga sozinha. Ela só vira vínculo quando você aceita.
- Aceitar acrescenta as amostras do locutor à impressão da pessoa, e as próximas sugestões melhoram.
- Recusar deixa o locutor sem pessoa e não muda a impressão.

> **Desligada por padrão**
> Quem administra o servidor precisa ligar a identificação por voz no painel antes de qualquer
> sugestão aparecer. Desligada, nada é comparado e nenhuma amostra é guardada.

## Atribuição automática

Quando a voz de um locutor passa da **pontuação mínima** que você escolhe em [Pessoas](/pessoas)
(padrão 75%) e nenhuma outra pessoa tem voz parecida, o eclume liga o locutor à pessoa sozinho,
na hora da transcrição, e o resumo já sai com o nome dela.

- O locutor aparece como **Atribuído pela voz**, com a pontuação. Use **Confirmar** para valer como
  amostra da voz da pessoa, ou **Desligar pessoa** se errou.
- Uma atribuição automática não entra na impressão de voz até você confirmar: um erro não se espalha.
- Suba a pontuação para ligar menos e sugerir mais, ou desligue a atribuição no mesmo cartão. A
  mudança vale para as próximas gravações.

## Consentimento e remoção

Ao criar sua conta, você aceitou ser responsável por pedir o consentimento das pessoas que grava.
A impressão de voz é dado biométrico pela LGPD: combine com a pessoa também sobre guardá-la. Se
ela pedir, abra a página dela e use **Esquecer a voz**: as amostras e as sugestões pendentes
somem, e os vínculos já confirmados ficam como estão.
