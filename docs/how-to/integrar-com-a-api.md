---
type: how-to
title: Integrar um programa com a API do eclume
description: Como um programa usa a API v1 do eclume em nome de uma conta — confiar na CA do servidor, criar um token de acesso, escolher escopos e grupos de escopo, autenticar com Bearer, paginar por cursor, sincronizar por since deduplicando por id + revision, ler erros problem+json e o limite de tentativas, e conectar um assistente de IA pelo MCP —, com a referência navegável em /referencia-api.html.
resource: contracts/openapi-v1.yaml, contracts/openapi-v1.bundled.yaml, web/src/features/tokens/scopes.ts, server/src/eclume_server/auth.py
tags: [api, integracao, pat, escopos, paginacao, mcp]
timestamp: 2026-10-01
audience: both
source: holetz/eclume#127
maintainer: holetz
---

# Integrar um programa com a API do eclume

Este guia leva um programa seu (um script, um importador, outro sistema) a ler e mudar dados de
uma conta do eclume pela API v1. Vale para qualquer servidor eclume. Os nomes exatos de rotas,
parâmetros e campos estão na **referência da API**, que todo servidor serve na versão que roda:
`https://<servidor>/referencia-api.html`. As regras por trás do contrato estão em
[contrato-v1.md](../standards/api/contrato-v1.md).

Nos exemplos, `https://eclume.exemplo:8443` é o endereço do seu servidor.

## 1. Confie no certificado do servidor

O eclume usa uma CA própria, que o sistema não conhece. Baixe a raiz e confira a impressão digital
com a que o descritor público publica:

```bash
curl -k -o eclume-root.crt https://eclume.exemplo:8443/downloads/eclume-root.crt
openssl x509 -in eclume-root.crt -outform der | sha256sum
curl --cacert eclume-root.crt https://eclume.exemplo:8443/api/v1/server
```

O SHA-256 do DER tem de ser o `ca_sha256` da resposta de `GET /api/v1/server` (confira também com
quem administra o servidor). Daí em diante, use sempre `--cacert eclume-root.crt` (ou o equivalente
da sua biblioteca HTTP) e nunca desligue a verificação. Durante uma rotação, o descritor traz também
`ca_next_sha256`, e a próxima raiz está em `/downloads/eclume-root-proxima.crt`.

## 2. Crie um token de acesso

Na web, abra **Tokens de acesso** e clique em **Novo token**. Dê um nome que diga qual programa o
usa, escolha os escopos e a validade (30 dias, 90 dias ou nunca). O token (`eclp_…`) aparece **uma
vez só**: guarde-o no cofre do programa, nunca no código. Criar token é só pela web, com a sessão
da conta: um token não cria outro.

## 3. Escolha os escopos

Dê ao programa só o que ele usa. A tela oferece quatro grupos e, em **Escopos individuais**, cada
escopo solto:

| Grupo | Escopos |
|---|---|
| Buscar e ler gravações | `recordings:read`, `transcripts:read` |
| Ler e editar resumos | `summaries:read`, `summaries:write` |
| Editar campos e tags | `recordings:write` |
| Excluir gravações | `recordings:delete` |

Fora dos grupos ficam `transcripts:write` (renomear locutores e corrigir falas), `people:read` e
`people:write`. Um importador de transcrições, como o lumea, vive com `transcripts:read` e
`people:read`. Cada operação da referência diz o escopo que pede; sem ele, a resposta é **403**
`insufficient_scope` com `required_scopes`.

## 4. Autentique

Mande o token em toda requisição:

```bash
curl --cacert eclume-root.crt \
  -H "Authorization: Bearer $ECLUME_TOKEN" \
  https://eclume.exemplo:8443/api/v1/me
```

Com `Authorization` presente, o servidor nunca usa cookie: o programa não precisa de CSRF. Token
inválido, revogado ou vencido é **401** `unauthorized`; rotas só de sessão (criar token, código de
pareamento, voz) respondem **403** `session_required`.

## 5. Pagine por cursor

Toda listagem devolve `{items, next_cursor}`. Peça a próxima página com o cursor recebido até
`next_cursor` vir `null`:

```bash
curl --cacert eclume-root.crt -H "Authorization: Bearer $ECLUME_TOKEN" \
  "https://eclume.exemplo:8443/api/v1/recordings?limit=100"
curl --cacert eclume-root.crt -H "Authorization: Bearer $ECLUME_TOKEN" \
  "https://eclume.exemplo:8443/api/v1/recordings?limit=100&cursor=<next_cursor>"
```

`limit` vai de 1 a 200. O cursor é opaco e vale só para a ordenação (`sort`) que o gerou: não o
monte nem o guarde entre ordenações.

## 6. Sincronize por `since`

Para trazer só o que mudou, use `?since=` nas listagens incrementais (`GET /transcripts`,
`GET /recordings`):

1. Na primeira vez, percorra tudo e guarde o maior `updated_at` que viu.
2. Nas seguintes, peça `?since=<esse updated_at>` e percorra todas as páginas.
3. `since` é **inclusivo** (`updated_at >= since`): o último item da rodada anterior volta.
   Deduplique por `id` + `revision` — a `revision` sobe a cada edição, então o mesmo `id` com
   `revision` maior é uma versão nova, e o mesmo par é repetição.

Um resumo novo ou refeito também move o `updated_at` da transcrição e da gravação, então o
`since` o percebe.

## 7. Leia os erros

Todo erro vem em `application/problem+json` (RFC 9457) com um `code` estável. Decida pelo `code`,
nunca pelo `title`, que é texto para gente:

```json
{"type": "https://eclume.dev/problems/insufficient-scope", "title": "Escopo insuficiente",
 "status": 403, "code": "insufficient_scope", "required_scopes": ["summaries:write"]}
```

- **404** não diz se o recurso não existe ou se não é da conta.
- **422** `validation_failed` traz `errors[]` com o campo e o motivo.
- **403** `quota_exceeded` traz `quota`, `limit` e `used`.
- **429** `rate_limited` traz o cabeçalho `Retry-After` (segundos): espere esse tempo antes de
  repetir. Os logins e o pareamento têm limite de tentativas por IP; a conta também tem teto de
  resumos na fila.
- **500** `internal_error` não traz detalhe; o cabeçalho `X-Request-ID` é o que o administrador
  procura no log.

## 8. Conecte um assistente de IA pelo MCP

O servidor MCP fica em `https://eclume.exemplo:8443/mcp` (fora do `/api/v1` e da referência) e usa
o mesmo token, com os mesmos escopos. Na web, **Conexão MCP** mostra o endereço, cria o token com
os grupos acima e monta o comando `claude mcp add` para o Claude Code; no Claude Desktop, adicione
um conector personalizado com o endereço e o token. A máquina do assistente também precisa confiar
na CA do passo 1. Deixe **Excluir gravações** desmarcado se o assistente não precisa apagar nada:
o texto de uma transcrição é dado, nunca ordem.

## Para testar sem servidor

O contrato tem um mock (Prism) que responde com os exemplos dos fixtures, útil para escrever o
cliente antes de ter conta num servidor; veja [contracts/README.md](../../contracts/README.md).
