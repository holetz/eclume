---
type: standard
title: Estrutura do app web
description: O app web do eclume (web/) fala com a API por um cliente gerado do contrato v1, na mesma origem e com sessão por cookie e CSRF double-submit; organiza-se em shell com navegação agrupada e gaveta de ajuda, features (biblioteca, gravação, pessoas, busca, coleções) e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism.
resource: web/src/**, web/e2e/**, web/playwright.config.ts, web/vite.config.ts, web/package.json
tags: [code, web, react, api, upload, testes]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#10, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#36
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
| `src/app/` | shell, marca (`Brand.tsx`), navegação (`nav.ts`), rotas (`routes.tsx`), `PageHead`, 404, gaveta de ajuda, sessão, providers, tema |
| `src/features/<área>/` | página, componentes, CSS Module e testes de cada área |
| `src/upload/` | motor de upload multipart, sem React |
| `src/styles/` | `global.css` (entrada), `fonts.css`, `eclume.css` (cópia fiel do DS) e `app.css` (produto): [web-design-system.md](web-design-system.md) |
| `src/test/` | dublê de `fetch`, fixtures tipadas e `renderApp` |
| `src/lib/media-convert/` | biblioteca de conversão, autocontida |

- **Rotas em pt-BR** (`/entrar`, `/cadastro`, `/convite/:token`, `/gravacoes/:id`, `/importar`, `/pessoas`,
  `/pessoas/:id`, `/busca`, `/colecoes`, `/tokens`, `/app-desktop`, `/admin/*`), e os filtros na
  query string também em pt-BR (`?de=`, `?colecao=`, `?tag=` na biblioteca;
  `?q=&pessoa=&de=&ate=&tag=&colecao=` na busca).
- **Rotas sob demanda.** `routes.tsx` carrega por `React.lazy` + `Suspense` toda área além da
  biblioteca e do login, cada uma no seu chunk; o bundle inicial caiu de ~477 KB para ~280 KB
  (89 KB gzip). O chunk do WebCodecs (Mediabunny, ~560 KB) só carrega na conversão do import, e
  o aviso de chunk grande do Vite que ainda aparece é dele.
- **Retentar a transcrição.** Numa gravação `failed`, o dono vê "Tentar de novo"
  (`RetryTranscription`, `POST .../retranscribe`), com a falha passageira (`error.retryable`) dita
  como tal; a Saúde do admin tem o mesmo botão por falha recente, pela retentativa do admin.
- **Navegação agrupada numa lista só** (`src/app/nav.ts`): cada item tem `group`, `section`
  (`main` ou `more`), `enabled` e `adminOnly`, e `navGroups()` devolve as duas seções. A principal
  tem Gravações (Biblioteca, Busca, Importar arquivo), Organizar (Pessoas, Coleções, Campos e
  regras, Tipos de agenda) e Administração (só admin); a recolhível **Configurações e ajuda** (um
  `<details class="nav-more">`) tem Minhas configurações (Conexão MCP, Tokens de acesso, App
  desktop, App móvel) e Ajuda (Central de ajuda). Ela abre sozinha quando a rota atual é dela e,
  fora isso, guarda a escolha enquanto a página vive. Uma área nova de outra spec entra desligada,
  com a rota do mapa de telas v6 (`/config/campos`, `/config/agendas`, `/config/mcp`, `/app-movel`,
  `/ajuda`), e ligá-la é mudar `enabled` e registrar a rota. Há um só `<nav aria-label="Principal">`;
  cada grupo é um `role="group"` rotulado pelo título.
- **Cabeçalho de página** é o `PageHead` (`.page-head` do DS: kicker opcional, `h1`, ações e, no
  shell, o botão Ajuda); ele também dá o título da aba. Rota desconhecida mostra
  `NotFoundPage` dentro do shell, com o link de volta à biblioteca.
- **Gaveta de ajuda** (`help.ts`, `HelpProvider`, `HelpDrawer`): o `HelpProvider`, montado no
  `AppShell`, abre a `.help-drawer` com `?` (sem Ctrl, Meta ou Alt, fora de `input`, `textarea`,
  `select` e `contenteditable`) ou pelo botão Ajuda do `PageHead`, e fecha com Esc, devolvendo o
  foco a quem abriu. A página declara o tópico com `useHelpTopic(chave)`; os tópicos moram em
  `HELP_TOPICS` (o conteúdo chega com holetz/eclume#38). A gaveta mostra os links da página, os
  atalhos e, quando `/ajuda` estiver ligada, o link para a central.
- **Chaves do TanStack Query por área**, com prefixo fixo (`['people', ...]`, `['collections']`,
  `['tags']`, `['recordings', ...]`, `['admin', ...]`): uma mutação que muda contagens ou nomes
  vistos em outras telas invalida o prefixo inteiro, além de gravar no cache o que a resposta
  devolveu.
- **Administração** (`/admin/*`, `src/features/admin/`): `AdminRoutes` monta as seções
  (Transcrição, Agentes, Templates padrão, Usuários e convites, Segredos, Saúde) dentro de
  `AdminLayout`, que **exige `role: admin`** — esconder o item do menu não é controle de acesso; o
  membro vê "Sem permissão". A lista de seções mora em `sections.ts`. Segredos só têm campo de
  escrita e nunca mostram o valor; o link de convite, como o segredo do PAT, aparece uma vez; a
  Saúde relê a cada 10 s (`refetchInterval`). As regras do server estão em
  [server-admin.md](server-admin.md).
- **Rotas públicas:** `/entrar`, `/cadastro` (Criar conta, com o aceite obrigatório de "Sou
  responsável por pedir o consentimento das pessoas que gravo."; a tela chega com o contrato de
  holetz/eclume#32) e `/convite/:token` (aceite do convite: nome, senha de 12+ e
  confirmação; 404 vira "convite inválido, expirado ou já usado").
- **Estado de servidor com TanStack Query.** O polling é declarativo (`refetchInterval` de 3 s
  só enquanto há job ou resumo `queued`/`running`). Mutações gravam no cache o que a resposta
  devolve, sem refazer a leitura.
- **Arquivo `.tsx` exporta só componentes** (regra do react-refresh): hooks, constantes e
  funções puras ficam em `.ts` ao lado.

## Visual e acessibilidade

- A base visual é o Design System do eclume ([web-design-system.md](web-design-system.md)):
  tokens e classes do `eclume.css`, fontes Archivo e IBM Plex Mono servidas pelo build, ícones
  Lucide e tema por `data-theme` no `<html>` ("Do sistema" resolve `prefers-color-scheme`; a
  escolha explícita fica no `localStorage`). Cor nova entra como token no DS.
- As telas de acesso usam o `AuthLayout` (`.auth` do DS: campo da marca e formulário alinhado à
  esquerda); o resto fica no `AppShell` (`.shell`, `.sidebar`, `.main`), com a barra superior e o
  menu compacto abaixo de 56rem.
- CSS Modules por componente, só com o que o DS não tem. Sem framework de CSS e sem fonte
  externa.
- Toda ação alcançável por teclado, foco visível, skip link, rótulos em todos os campos,
  `aria-live` em progresso e confirmações. Estado nunca só por cor: o selo tem texto.
- Enum desconhecido na resposta aparece cru, sem quebrar a tela (o contrato só cresce).

## Pessoas, busca e organização

- **Abrir a gravação num instante** é o link `/gravacoes/:id?t=<ms>`: a página destaca a fala
  daquele instante, rola até ela e posiciona o áudio (sem tocar, pela política de autoplay). A
  busca e a página da pessoa geram o link com `recordingAt()`.
- **`highlight` da busca nunca vira `innerHTML`.** `parseHighlight()` separa o texto em pedaços
  marcados e não marcados, desfaz o escape e o React renderiza texto puro dentro de `<mark>`.
- **Datas da busca** são dias locais: `de` vira o início do dia e `ate` o início do dia seguinte
  (`to` é exclusivo no contrato), convertidos a RFC 3339.
- **Ligar locutor a pessoa** usa `PersonCombobox`: combobox ARIA 1.2 com lista em popup (setas,
  Enter, Esc, `aria-activedescendant`), busca no diretório por prefixo e a opção "Cadastrar
  “nome”" quando ninguém tem aquele nome. Cada sugestão por voz pendente aparece como "Parece ser
  <pessoa> — NN%", com Aceitar (liga com um clique) e Recusar; nunca é aplicada sozinha.
- **Voz** ([identificacao-por-voz.md](identificacao-por-voz.md)): a página da pessoa tem a seção
  Voz (consentimento com o termo, amostras, excluir e exportar), e o admin tem a seção
  Identificação por voz (`/admin/voz`), com opt-in, limiar, termo, trilha e purga.
- **Organização da gravação** (tags, coleções, tipo de reunião, cliente, projeto) é um painel da
  página da gravação: o dono edita, quem vê por compartilhamento só lê. Os metadados de
  organização são as chaves `tipo_reuniao`, `cliente` e `projeto` do `RecordingMetadata`; as
  demais chaves gravadas são preservadas.

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
  PAT, outro percorre busca, gravação aberta no segundo do trecho, vínculo de locutor, pessoas
  e coleções, e um terceiro o painel admin. O Prism não emite cookies nem guarda estado, então o teste põe os cookies de sessão na
  resposta do login, pede o upload com `Prefer: code=201` e encaminha o `PUT` de parte (URL
  absoluta das fixtures em `127.0.0.1:4010`) com credencial e CORS. `ECLUME_MOCK_URL` aponta para
  outra porta quando a 4010 está ocupada; `E2E_SCREENSHOTS=1` salva telas claro e escuro em
  `test-results/screens/`; `E2E_CHANNEL=chrome` usa o Google Chrome instalado. O helper `navTo()`
  abre "Configurações e ajuda" quando o link está recolhido. `e2e/visual.spec.ts` é a
  verificação visual contra o DS ([web-design-system.md](web-design-system.md)).
- A CI roda os unitários no job `web` e o E2E, junto dos testes de navegador da conversão, no
  job `web-browser`.
- **E2E contra o backend real** (`npm run test:e2e:real`, `playwright.real.config.ts`,
  `e2e-real/`): nada simulado — login com os cookies do servidor, import com conversão no
  navegador e upload pelas URLs de parte assinadas, transcrição pelo worker e o resumo automático
  do `claude -p`. Roda no host GPU por `bash deploy/e2e-real.sh` (da estação:
  `remote-run . 'bash deploy/e2e-real.sh'`), que sobe um stack efêmero próprio
  (`deploy/docker-compose.e2e.yml`, projeto `eclume-e2e`, Caddy em `127.0.0.1:18443`, dados em
  tmpfs, worker na engine CPU sem GPU), cria organização e admin descartáveis, roda o cenário e
  sai sempre com `down -v` e as imagens `:e2e` apagadas. Nunca toca a produção. Leva ~1 min além
  do build; fica fora da CI (exige o daemon, o Chrome e o login do Claude do host).
