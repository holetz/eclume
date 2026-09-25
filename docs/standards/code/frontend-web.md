---
type: standard
title: Estrutura do app web
description: O app web do eclume (web/) fala com a API por um cliente gerado do contrato v1, na mesma origem e com sessão por cookie e CSRF double-submit; organiza-se em shell, features e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism.
resource: web/src/**, web/e2e/**, web/playwright.config.ts, web/vite.config.ts, web/package.json
tags: [code, web, react, api, upload, testes]
timestamp: 2026-09-24
audience: both
authority: current
source: holetz/eclume#10
maintainer: holetz
---

# Estrutura do app web

O `web/` é uma SPA React + Vite + TS, servida estática e atrás de login. O conteúdo vem da API
v1 ([contrato-v1.md](../api/contrato-v1.md)); a conversão de mídia vem da biblioteca de
[formato-audio-upload.md](formato-audio-upload.md).

## Cliente da API: gerado, nunca escrito à mão

- `npm run gen:api` gera `src/api/schema.gen.ts` a partir de `contracts/openapi-v1.bundled.yaml`
  com `openapi-typescript`. O arquivo é versionado, e a CI roda `gen:api -- --check`: mudou o
  contrato, regenere. **Nenhum tipo da API é declarado à mão**; derive de `Schemas['X']` ou de
  `operations[...]`.
- As chamadas passam por `api` (`src/api/client.ts`, `openapi-fetch`), tipadas pelo caminho.
  `unwrap()` devolve os dados ou lança `ApiError` com o `Problem`; a UI decide por
  `problem.code` e mostra `errorMessage()`, nunca o `title`.
- O `openapi-typescript` declara `typescript ^5` como peer; o `package.json` o sobrepõe com
  `overrides` para usar o TS do projeto.

## Origem única, sessão e CSRF

- O app chama `/api/v1/...` relativo à própria origem, com `credentials: 'same-origin'`. Em
  produção o Caddy serve web e API na mesma origem; em dev, o `vite.config.ts` faz proxy de
  `/api` para `ECLUME_API_URL` (padrão: o mock em `http://127.0.0.1:4010`). Não há CORS.
- A sessão é o cookie `eclume_session`, aberto por `POST /auth/login`. O middleware do cliente
  copia o cookie `eclume_csrf` para `X-CSRF-Token` em todo método mutável.
- Estado da sessão = `useMe()` (`GET /me`; 401 vira `null`). Qualquer 401 fora do login zera a
  sessão no cache, e a guarda `RequireSession` leva a `/entrar?volta=<rota>`; `volta` só aceita
  caminho interno.

## Estrutura de pastas

| Pasta | O que tem |
|---|---|
| `src/api/` | cliente gerado, `client.ts`, `problem.ts` |
| `src/app/` | shell, navegação (`nav.ts`), rotas (`routes.tsx`), sessão, providers, tema |
| `src/features/<área>/` | página, componentes, CSS Module e testes de cada área |
| `src/upload/` | motor de upload multipart, sem React |
| `src/styles/` | tokens (`tokens.css`) e primitivas globais (`global.css`) |
| `src/test/` | dublê de `fetch`, fixtures tipadas e `renderApp` |
| `src/lib/media-convert/` | biblioteca de conversão, autocontida |

- **Rotas em pt-BR** (`/entrar`, `/gravacoes/:id`, `/importar`, `/tokens`, `/app-desktop`).
- **Navegação numa lista só** (`src/app/nav.ts`), com `enabled` e `adminOnly`. As áreas de
  outras specs (Pessoas, Busca, Coleções, Administração) já estão lá, desligadas: ligar uma é
  mudar `enabled` e registrar a rota.
- **Estado de servidor com TanStack Query.** O polling é declarativo (`refetchInterval` de 3 s
  só enquanto há job ou resumo `queued`/`running`). Mutações gravam no cache o que a resposta
  devolve, sem refazer a leitura.
- **Arquivo `.tsx` exporta só componentes** (regra do react-refresh): hooks, constantes e
  funções puras ficam em `.ts` ao lado.

## Visual e acessibilidade

- Tokens em CSS custom properties, tema claro e escuro por `prefers-color-scheme` ou pela escolha
  no shell (`data-theme` no `<html>`, lembrada no `localStorage`). Cores novas entram como token
  nos três blocos de `tokens.css` (claro, escuro por preferência e escuro explícito), com
  contraste AA.
- CSS Modules por componente e primitivas globais (`btn`, `field`, `card`, `badge`, `alert`,
  `progress`). Sem framework de CSS e sem fonte externa.
- Toda ação alcançável por teclado, foco visível, skip link, rótulos em todos os campos,
  `aria-live` em progresso e confirmações. Estado nunca só por cor: o selo tem texto.
- Enum desconhecido na resposta aparece cru, sem quebrar a tela (o contrato só cresce).

## Upload: `src/upload/multipart.ts`

`runUpload(file, options)` segue o contrato:

1. `POST /uploads` com `sha256` (da conversão), `size_bytes`, `content_type`
   `audio/ogg; codecs=opus` e `source: upload`. Um 200 `deduplicated` encerra com a gravação
   existente, sem transferir nada.
2. Número de partes = `ceil(tamanho / part_size)`, calculado do arquivo. Partes sem URL recebem
   URL por `POST part-urls`. Três `PUT` em paralelo na `url` opaca, com os `headers` recebidos,
   guardando o `ETag` (o armazenamento precisa expô-lo por CORS se estiver em outra origem).
3. Falha de rede, 408, 429 e 5xx: nova tentativa com espera (3 no total). 403: pede URL nova
   para a parte e reenvia. Falha de uma parte aborta as outras.
4. Retomar = chamar de novo com `uploadId`: `GET /uploads/{id}` e só as partes fora de
   `parts_received`. Upload `expired`/`aborted` no servidor exige recomeçar.
5. `POST complete` com as partes em ordem. Cancelar = abortar o sinal e `cancelUpload()`
   (`DELETE /uploads/{id}`).

A retomada vale enquanto a página está aberta: o Opus convertido (~15 MB/h) fica em memória.
Depois de recarregar, o import recomeça pela conversão.

## Como é testado

- **Unitários** (`npm test`, vitest + jsdom + Testing Library): `mockFetch()` substitui o `fetch`
  por rotas `"MÉTODO /caminho/:param"`, respondendo com as fixtures de `contracts/fixtures/`
  (`src/test/fixtures.ts`, tipadas pelo schema). `renderApp(rota)` monta o app inteiro numa
  rota. O motor de upload roda no ambiente `node` (o `Blob` do jsdom não serve de corpo para o
  `fetch` do Node).
- **E2E** (`npm run test:e2e`, Playwright): o `webServer` sobe o Vite dev com o proxy apontando
  para o mock, e um cenário percorre login, biblioteca, transcrição, import com conversão real e
  PAT. O Prism não emite cookies nem guarda estado, então o teste põe os cookies de sessão na
  resposta do login, pede o upload com `Prefer: code=201` e encaminha o `PUT` de parte (URL
  absoluta das fixtures em `127.0.0.1:4010`) com credencial e CORS. `ECLUME_MOCK_URL` aponta para
  outra porta quando a 4010 está ocupada; `E2E_SCREENSHOTS=1` salva telas claro e escuro em
  `test-results/screens/`; `E2E_CHANNEL=chrome` usa o Google Chrome instalado.
- A CI roda os unitários no job `web` e o E2E, junto dos testes de navegador da conversão, no
  job `web-browser`.
