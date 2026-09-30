---
titulo: Monte o título pelo tipo de agenda
topico: organizar
paginas: [agendas, campos]
relacionados: [configurar-tipo-de-agenda, escrever-uma-regra, campos-em-toda-gravacao]
termos: [título, padrão de título, marcador, assunto, data, chave]
ordem: 5
atualizado: 2026-09-30
---
O título de uma gravação vem sempre do tipo de agenda dela: o campo **Título da gravação** monta o
título, e **Como escrever o assunto** diz ao agente como escrever o `{assunto}`. Como toda gravação
ganha um tipo (quando nenhum se encaixa, fica o tipo padrão), todo título segue um tipo.

## Os marcadores

Clique num marcador abaixo do campo para inseri-lo onde está o cursor:

- `{assunto}`: o título automático, escrito pelo agente pela regra do assunto do tipo.
- `{data}`: a data da gravação, como 27/09/2026.
- `{tipo}`: o nome do tipo de agenda.
- `{chave}`: o valor de um dos seus campos, pela chave dele. Por exemplo, `{cliente}`.

Exemplo: `{cliente} · Reunião de alinhamento · {data}` vira "Guion · Reunião de alinhamento ·
27/09/2026".

## Marcador vazio

Quando um marcador não tem valor, ele some junto com o separador que sobraria (` · ` ou ` - `).
No exemplo acima, sem cliente, o título fica "Reunião de alinhamento · 27/09/2026".

## A regra do assunto

Em **Como escrever o assunto**, diga o que o assunto deve trazer, por exemplo "o cliente e o
assunto principal, em até 8 palavras". Um tipo com a regra vazia usa a do tipo padrão. O tipo
padrão já vem com uma regra, que você pode mudar.

## Quem vale mais

- O padrão do tipo substitui o título automático: o que o agente escreveu entra só por `{assunto}`.
- Sem padrão, vale o título automático.
- Um título que você **editou** ou **aceitou** na gravação nunca é trocado.
