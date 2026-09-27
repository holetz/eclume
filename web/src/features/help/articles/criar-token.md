---
titulo: Crie um token de acesso
topico: conectar
paginas: [tokens, mcp]
relacionados: [revogar-token, conectar-assistente-mcp, vincular-aparelho]
termos: [token, escopo, escopos, validade, chave, API, acesso, lumea]
ordem: 2
atualizado: 2026-09-27
---
Um token de acesso deixa outro programa usar o eclume em seu nome, com as permissões que você
escolher. Crie em [Tokens de acesso](/tokens) ou, para um assistente de IA, em
[Conexão MCP](/config/mcp).

## Os escopos

Os escopos vêm em quatro grupos:

- **Buscar e ler gravações:** listar, buscar e ler gravações e transcrições.
- **Ler e editar resumos:** ler o resumo, editar e pedir um novo.
- **Editar campos e tags:** mudar título, tags e os seus campos.
- **Excluir gravações:** apagar gravações. Vem desmarcado.

Em **Escopos individuais** ficam as permissões fora dos grupos, como ler o diretório de pessoas.
Uma integração como o lumea usa só `transcripts:read` e `people:read`.

## A validade

Escolha 30 dias, 90 dias ou Nunca. Um token vencido aparece como **Expirado** e para de funcionar.

## O token aparece uma vez

Depois de criar, o eclume mostra o token uma única vez. Copie e guarde num lugar seguro, como um
gerenciador de senhas. Perdeu? Revogue e crie outro: veja [Revogue um token](/ajuda/revogar-token).
