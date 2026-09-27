---
titulo: De onde veio um valor preenchido
topico: resumos
paginas: [gravacao, campos]
relacionados: [campos-em-toda-gravacao, escrever-uma-regra, tentar-de-novo]
termos: [automático, editado, aceito, aceitar, aceitar tudo, origem, selo, campo]
ordem: 4
atualizado: 2026-09-27
---
No painel de campos da gravação, cada valor tem um selo que diz de onde ele veio.

## Os selos

- **Automático** (contorno tracejado): o agente preencheu pela regra do campo e ninguém conferiu.
- **Aceito:** você conferiu o valor automático e aceitou como está.
- **Editado** (contorno sólido): você escreveu ou mudou o valor.

## Aceitar

- **Aceitar**, ao lado de um valor automático, confirma aquele valor.
- **Aceitar tudo** confirma de uma vez todos os valores automáticos da gravação.

Aceitar não muda o texto do valor: só diz que ele foi conferido.

## A regra de ouro

O preenchimento automático nunca sobrescreve um valor **editado** ou **aceito**. Retranscrever a
gravação ou mudar a regra do campo recalcula só os valores automáticos. O que você conferiu fica.

Para mudar o que o agente preenche, ajuste a regra do campo em
[Campos e regras](/config/campos): veja [Escreva uma regra que preenche um campo](/ajuda/escrever-uma-regra).
