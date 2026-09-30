---
titulo: Configure um tipo de agenda
topico: organizar
paginas: [agendas]
relacionados: [padrao-de-titulo, trocar-tipo-da-gravacao, editar-resumo]
termos: [tipo de agenda, agenda, reunião de equipe, 1:1, conversa com cliente, nota de voz, instruções do resumo, pré-visualizar]
ordem: 4
atualizado: 2026-09-30
---
O tipo de agenda diz que tipo de conversa é a gravação e como resumi-la. Depois da transcrição, um
agente escolhe o tipo, e o tipo define o título, as tags e o resumo.

## O tipo padrão

Toda conta tem o tipo **Geral**, com o selo **Padrão**, no topo da lista. A gravação fica com ele
quando nenhum outro tipo se encaixa com boa confiança (abaixo de 60%), quando só ele existe, quando
não há agente de detecção ou quando a detecção falha. Assim toda gravação tem um tipo, um título e
um resumo. Ele não pode ser excluído e não tem "Como identificar"; o resto você edita, até o nome.

## Os tipos que toda conta recebe

- **Reunião de equipe:** planejar ou revisar trabalho da equipe interna. O resumo traz decisões e
  próximos passos com responsável.
- **1:1:** conversa entre duas pessoas da mesma equipe. O resumo traz os pontos tratados e os
  combinados.
- **Conversa com cliente:** alguém de fora da equipe para quem o trabalho é feito. O resumo traz
  pedidos, compromissos e prazos.
- **Nota de voz:** uma pessoa só falando. O resumo é o texto limpo.

Eles são seus: edite, exclua ou crie outros em [Tipos de agenda](/config/agendas). Excluir um tipo
passa as gravações dele para o tipo padrão.

## O que cada tipo tem

- **Nome.**
- **Título da gravação:** um padrão com marcadores, como `Reunião de equipe · {assunto}`. Veja
  [Monte o título pelo tipo de agenda](/ajuda/padrao-de-titulo).
- **Como escrever o assunto:** a regra que o agente segue para o `{assunto}` do título. Vazia, vale
  a do tipo padrão.
- **Como identificar:** o que o agente lê para escolher o tipo. Diga o que distingue esse tipo dos
  outros.
- **Tags padrão:** somadas às tags automáticas.
- **Instruções do resumo:** em Markdown. O resumo segue estas instruções, com os mesmos títulos.

## Pré-visualizar antes de salvar

**Pré-visualizar numa gravação** mostra, numa gravação que você escolhe, se o agente escolheria
este tipo e com que confiança, o título, as tags e o resumo que sairiam. Nada é gravado.
