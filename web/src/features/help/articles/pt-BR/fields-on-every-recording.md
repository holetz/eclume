---
titulo: Acrescente um campo a toda gravação
topico: organizar
paginas: [campos]
relacionados: [escrever-uma-regra, testar-uma-regra, origem-dos-valores, tags-cadastradas]
termos: [campo, campos, cliente, projeto, texto, lista, escolha, título, tags]
ordem: 1
atualizado: 2026-09-30
---
Campos são as informações que você quer em toda gravação, preenchidas pelo agente depois da
transcrição. Eles ficam em [Campos personalizados](/config/campos).

## O título e as tags

O título não aparece aqui: ele vem do tipo de agenda da gravação, pelo padrão e pela regra do
assunto do tipo. Veja [Monte o título pelo tipo de agenda](/ajuda/padrao-de-titulo).

As tags também não aparecem aqui: elas têm cadastro próprio, com a regra geral, a descrição de cada
tag e a escolha entre usar só as cadastradas ou deixar o agente criar outras. Configure tudo em
[Tags](/tags). Veja [Cadastre as tags e deixe o agente usá-las](/ajuda/tags-cadastradas).

## Os seus campos

Use **Novo campo** e escolha o tipo:

- **Texto:** um valor livre, como "Cliente" ou "Projeto".
- **Lista:** vários valores, como "Participantes externos".
- **Escolha:** um valor entre opções que você define, como "Fase do projeto": Proposta, Execução,
  Entrega.

Um exemplo comum é o campo **Cliente**, do tipo texto: ele diz de que cliente foi cada reunião e
vira filtro na biblioteca e na busca.

## Automático ou à mão

Com **Preencher automaticamente depois da transcrição** ligado, o agente preenche o campo pela regra
em **Como identificar**. Desligado, o campo fica vazio para você preencher na gravação. O
liga-desliga **Automático** na lista faz o mesmo sem abrir o campo.

Veja [Escreva uma regra que preenche um campo](/ajuda/escrever-uma-regra).
