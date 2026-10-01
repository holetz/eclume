# `how-to/` — receitas para quem instala, integra e desenvolve o eclume

Passo a passo para uma tarefa concreta, válido para qualquer instalação: nada aqui depende do host
desta produção, que tem o próprio runbook em [project/](../project/index.md). Cada página tem
`type: how-to`.

* [auto-hospedar.md](auto-hospedar.md) — subir o eclume num servidor próprio, com ou sem GPU: requisitos, `.env.prod`, deploy por contexto Docker, primeiro admin, provider de resumo, rede local, internet e cadastro
* [integrar-com-a-api.md](integrar-com-a-api.md) — um programa usando a API v1 em nome de uma conta: CA do servidor, token e escopos, Bearer, cursor, sincronização por `since` com `id` + `revision`, erros `problem+json`, limite de tentativas e o MCP
* [desenvolver-sem-gpu.md](desenvolver-sem-gpu.md) — do clone a uma gravação transcrita e resumida numa máquina Linux ou Windows sem GPU e sem host de build
