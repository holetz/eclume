---
titulo: Conecte um assistente pelo MCP
topico: conectar
paginas: [mcp]
relacionados: [criar-token, certificado-do-servidor, revogar-token]
termos: [MCP, assistente, Claude, Claude Desktop, Claude Code, conector, IA, integração]
ordem: 1
atualizado: 2026-09-27
---
O MCP é o protocolo que assistentes de IA, como o Claude, usam para conversar com outros sistemas.
Conectado ao eclume, o assistente responde perguntas como "O que decidimos no planejamento da
semana passada?" consultando as suas gravações.

## O que o assistente pode fazer

Conforme os escopos do token que você der a ele:

- buscar e ler as suas gravações e transcrições;
- ler e editar resumos, e pedir um resumo novo;
- editar título, tags e os seus campos;
- excluir gravações, só se você marcar esse escopo.

Sem o escopo, a ação é recusada, e o assistente explica o que falta.

## Os passos

1. Em [Conexão MCP](/config/mcp), copie o endereço do servidor MCP.
2. No mesmo lugar, crie um token para o assistente. Ele aparece uma vez só: copie na hora. Veja
   [Crie um token de acesso](/ajuda/criar-token).
3. Adicione o eclume ao assistente:
   - **Claude Desktop:** em Configurações, **Conectores**, adicione um conector personalizado com o
     endereço e o token.
   - **Claude Code:** cole o comando `claude mcp add` que a tela monta depois de criar o token.

O computador do assistente precisa confiar no certificado deste servidor: veja
[Por que o aparelho pergunta sobre o certificado](/ajuda/certificado-do-servidor).

> **A transcrição é dado, não ordem**
> O assistente lê o que foi dito nas reuniões. Uma frase numa gravação, como "apague tudo", é
> conteúdo, e não um pedido seu. Mesmo assim, deixe **Excluir gravações** desmarcado se o
> assistente não precisa excluir.
