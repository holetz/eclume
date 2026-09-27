---
titulo: Escreva uma regra que preenche um campo
topico: organizar
paginas: [campos]
relacionados: [testar-uma-regra, campos-em-toda-gravacao, origem-dos-valores]
termos: [regra, como identificar, instrução, preencher, agente, prompt]
ordem: 2
atualizado: 2026-09-27
---
A regra de um campo, em **Como identificar**, é o que o agente lê para preencher aquele campo a
partir da transcrição. Escreva como explicaria a alguém que vai ouvir a reunião por você.

## O que uma boa regra diz

1. **O que procurar:** qual informação da conversa vai no campo.
2. **A forma do valor:** nome curto ou completo, maiúsculas, o formato de uma data.
3. **Quando deixar vazio:** o que fazer quando a conversa não traz a informação.

## Exemplo: o campo Cliente

> **Como identificar**
> O cliente é a empresa para quem o trabalho discutido é feito. Use o nome curto: "Guion", não
> "Guion Engenharia Ltda". Deixe vazio quando nenhum cliente for citado.

## Dicas

- Uma regra por campo. Para duas informações, crie dois campos.
- Nos campos do tipo escolha, o agente só usa as opções que você definiu. Não precisa repeti-las
  na regra.
- A regra do título define o título automático. Um tipo de agenda com padrão de título monta o
  título final em cima dele: veja [Monte o título pelo tipo de agenda](/ajuda/padrao-de-titulo).

Antes de salvar, teste a regra: [Teste uma regra antes de salvar](/ajuda/testar-uma-regra).
