---
type: standard
title: Estrutura do app web
description: O app web do eclume (web/) fala com a API por um cliente gerado do contrato, na mesma origem e com sessão por cookie e CSRF double-submit; o painel de administração é um app à parte, com login, sessão e moldura próprios; organiza-se em shell com navegação agrupada, o item Perguntar em destaque no topo e gaveta de ajuda, features (biblioteca no tempo com o modal Importar, gravação centrada no resumo, pessoas, busca, coleções, organizar, regras com a visão do processamento automático, minhas configurações agrupadas, central de ajuda, admin) e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism.
resource: web/src/**, web/e2e/**, web/playwright.config.ts, web/vite.config.ts, web/package.json
tags: [code, web, react, api, upload, testes]
timestamp: 2026-10-06
audience: both
authority: current
source: holetz/eclume#10, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#36, holetz/eclume#37, holetz/eclume#38, holetz/eclume#39, holetz/eclume#72, holetz/eclume#75, holetz/eclume#76, holetz/eclume#77, holetz/eclume#78, holetz/eclume#79, holetz/eclume#86, holetz/eclume#110, holetz/eclume#111, holetz/eclume#112, holetz/eclume#113, holetz/eclume#100, holetz/eclume#114, holetz/eclume#99, holetz/eclume#98, holetz/eclume#117, holetz/eclume#118, holetz/eclume#119, holetz/eclume#116, holetz/eclume#115, holetz/eclume#120, holetz/eclume#121, holetz/eclume#127, holetz/eclume#144, holetz/eclume#143, holetz/eclume#142, holetz/eclume#145, holetz/eclume#153
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
- `quota_exceeded` (holetz/eclume#98) tem mensagem por `quota`, com o `limit` do problem (bytes em
  GB/MB): tamanho do arquivo, armazenamento cheio, uploads ao mesmo tempo e pedidos ao agente em
  24 h. O Importar mostra essa mensagem no item recusado, como os demais erros de upload.
- O `openapi-typescript` declara `typescript ^5` como peer; o `package.json` o sobrepõe com
  `overrides` para usar o TS do projeto.

## Origem única, sessão e CSRF

- O app chama `/api/v1/...` relativo à própria origem, com `credentials: 'same-origin'`. Em
  produção o Caddy serve web e API na mesma origem; em dev, o `vite.config.ts` faz proxy de
  `/api` para `ECLUME_API_URL` (padrão: o mock em `http://127.0.0.1:4010`). Não há CORS.
- A sessão do usuário é o cookie `eclume_session`, aberto por `POST /auth/login`. A do painel
  admin é outra, `eclume_admin_session` (só viaja para `/api/v1/admin`), aberta por
  `POST /admin/auth/login`. O `csrfMiddleware` copia para `X-CSRF-Token`, em todo método
  mutável, o cookie da área: `eclume_admin_csrf` quando a URL começa por `/api/v1/admin/`,
  `eclume_csrf` nos demais casos (`isAdminUrl`).
- Estado da sessão do usuário = `useMe()` (`GET /me`; 401 vira `null`). O `unauthorizedMiddleware`
  zera essa sessão no cache a cada 401 fora do login e **fora de `/api/v1/admin/`** (o 401 do
  painel é da sessão de admin), e a guarda `RequireSession` leva a `/entrar?volta=<rota>`; `volta`
  só aceita caminho interno.
- **A sessão não cai por um refetch.** `RequireSession` e `RequireAdmin` só mostram "Tentar de
  novo" com `isError` **e sem dado em cache**: um refetch de `/me` (ou `/admin/me`) que falha sobre
  a sessão carregada mantém o shell, a fila de importação, o rascunho do resumo e o chat. A sessão
  só cai por 401.
- **Faixa de conexão** (`ConnectionBanner`, no topo do `AppShell`): sem rede (`onlineManager`) ou
  com `/me` falhando sobre a sessão em cache, um `.alert-warning` com `role="status"` diz "Sem
  conexão com o servidor. O que está na tela pode estar desatualizado; tentando de novo…", relê
  `/me` a cada 10 s, dobrando a cada falha até 60 s, enquanto o servidor não responde, e some sozinha. Consultas e mutações já
  pausam sem rede e retomam na volta (o `networkMode` padrão); a faixa só dá o motivo.
- **O que é de uma conta não atravessa para outra** (`app/accountScope.ts`): a aba guarda o id da
  última conta (`eclume-conta` no `sessionStorage`, marcado pelo login, pelo cadastro e pela
  sessão que já vinha do cookie). Entrar com outra conta remove as consultas fora de `['admin']`
  (menos a sessão recém-lida) e os rascunhos `eclume-resumo-rascunho:*`. Um 401 com a sessão
  aberta remove as consultas fora de `['admin']` e zera `['me']`, sem apagar rascunhos: a mesma
  conta que volta os reencontra. O `useLogout` usa a mesma remoção.

## Markdown gerado e CSP

- **Markdown gerado por LLM nunca carrega imagem.** O resumo (`SummaryDoc`), a cópia para colar
  (`copy-summary.ts`), as respostas do Agente (`AgentPage`) e a pré-visualização do tipo de agenda
  (`AgendaTypePreview`) passam ao `react-markdown` os `components` de `src/app/markdown.tsx`
  (`SAFE_MARKDOWN`, ou `safeMarkdown(próprios)` quando a tela troca outros elementos, que nunca
  sobrepõem `img` nem `a`): `![alt](url)` vira um link de texto (`alt`, ou a URL sem ele) e todo
  link abre em outra aba com `rel="noopener noreferrer"`. Um resumo envenenado não faz o navegador
  buscar uma URL de fora (rastreio, `Referer`). A ajuda, de conteúdo próprio, fica fora disso.
- **A CSP é da imagem web** (`deploy/web.Caddyfile`): `default-src 'self'`,
  `img-src 'self' data: blob:`, `media-src 'self' blob:`, `connect-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `frame-ancestors 'none'`,
  `base-uri 'none'` e `object-src 'none'`, com `X-Content-Type-Options: nosniff` e
  `Referrer-Policy: no-referrer`. O app respeita: nenhum script ou estilo inline no `index.html`,
  nenhum recurso de outra origem (fontes e ícones vêm dos assets), o áudio de `/media` na mesma
  origem e o ffmpeg.wasm dos assets do Vite. Recurso novo de fora pede mudar a CSP junto. A única
  exceção é a referência da API (`/referencia-api.html` e `/referencia-api/*`, HTML do Redoc gerado
  no build): o mesmo `script-src 'self'`, mas `style-src 'self' 'unsafe-inline'`, porque o Redoc
  injeta o CSS em `<style>`; norma em [contrato-v1.md](../api/contrato-v1.md). O Caddy
  de borda repete `nosniff`, `Referrer-Policy` e `frame-ancestors 'none'` (sem sobrescrever a CSP
  do web) para `/api`, `/media`, `/mcp` e `/downloads`.

## Estrutura de pastas

| Pasta | O que tem |
|---|---|
| `src/api/` | cliente gerado, `client.ts`, `problem.ts` |
| `src/app/` | shell, marca (`Brand.tsx`), navegação (`nav.ts`), rotas (`routes.tsx`), `PageHead`, 404, gaveta de ajuda, sessão, providers, tema, e as peças do DS `Dialog`, `ConfirmDialog`, `MenuButton`, `CopyValue`, `HelpHint` e `storage.ts` |
| `src/features/<área>/` | página, componentes, CSS Module e testes de cada área |
| `src/upload/` | motor de upload multipart, sem React |
| `src/styles/` | `global.css` (entrada), `fonts.css`, `eclume.css` (cópia fiel do DS) e `app.css` (produto): [web-design-system.md](web-design-system.md) |
| `src/test/` | dublê de `fetch`, fixtures tipadas e `renderApp` |
| `src/lib/media-convert/` | biblioteca de conversão, autocontida |
| `src/shared/` | o que mais de uma feature usa e não tem dono de domínio: `format.ts` (estado e etapa da gravação, datas, horas, durações, tamanhos e o relógio do áudio) e o `Switch` do DS |

- **Fronteiras entre features** (`src/test/boundaries.test.ts`, um teste da suíte): o grafo de
  imports entre `src/features/*` (código de produção, sem testes) não tem ciclo; só o próprio
  admin e `app/routes.tsx` importam `features/admin/` (o `eslint.config.js` veta o mesmo com
  `no-restricted-imports`); e `src/shared/` não importa de `features/` nem de `app/`. Peça com
  dono mora na dona (o `PersonCombobox`, com o seu CSS, em `features/people/`); importar o
  `queries.ts` de outra feature continua permitido enquanto não fechar ciclo. Sem barril: quem
  usa importa do arquivo que define.

- **Rotas em pt-BR** (`/entrar`, `/cadastro`, `/redefinir-senha`, `/parear`, `/gravacoes/:id`, `/pessoas`,
  `/pessoas/:id`, `/busca`, `/agente`, `/agente/:sessionId`, `/agente/conversas`, `/agente/habilidades`, `/colecoes`, `/config/campos`, `/config/agendas`, `/config/mcp`,
  `/config/ambiente`, `/tokens`, `/app-desktop`, `/app-movel`, `/ajuda`, `/ajuda/:slug`, `/admin/entrar`, `/admin/*`),
  nenhuma começando por `/mcp` (o endereço do servidor MCP); `/importar` redireciona para
  `/?importar=1` (o modal) e `/perguntas`, o nome antigo do Agente, para `/agente`. Os parâmetros também são pt-BR:
  - biblioteca (`/`): `visao=semana|mes|lista`, `data=AAAA-MM-DD` (qualquer dia do período),
    `tipo=reuniao|nota`, `situacao=pronta|processando|falhou`, `tag`, `pessoa`, `colecao`,
    `campo=<field_id>:<valor>` (todos repetíveis) e `importar=1`;
  - gravação: `t=<ms>`;
  - busca: `q`, `pessoa`, `periodo=7d|30d|ano`, `de`, `ate`, `tag`, `colecao` e `campo`
    (repetível);
  - pessoa: `aba=gravacoes|falas|amostras`; Campos personalizados: `campo`; Tipos de agenda: `tipo`.
  A biblioteca mostra só as gravações do usuário: não há filtro Minhas/Compartilhadas.
- **Rotas sob demanda.** `routes.tsx` carrega por `React.lazy` + `Suspense` toda área além da
  biblioteca e do login, cada uma no seu chunk. O chunk do WebCodecs (Mediabunny, ~560 KB) só
  carrega na conversão do import, e o aviso de chunk grande do Vite que ainda aparece é dele.
- **Orçamento do JS inicial** (`npm run budget`, depois do build, no pilar `web`):
  `scripts/bundle-budget.mjs` soma o `<script type="module">` e os `modulepreload` do
  `dist/index.html` (bruto e gzip nível 9) e falha acima de `bundle-budget.json`
  (`inicial_gzip_kb`). Medido em 2026-10-05: 29 arquivos, 466 KB (155,9 KB gzip), teto de 158 KB
  gzip; subiu de 155 KB na integração das specs holetz/eclume#141 a #145 (a faixa "Precisam de
  você" da biblioteca, a etapa Locutores no aviso de processamento e o grupo Agente no menu, todos
  no shell ou na biblioteca, que carregam de saída). Mudar o teto é editar o JSON no mesmo commit da
  mudança, com o motivo.
- **Data router.** `routes.tsx` exporta a árvore como `routes: RouteObject[]`; o `App.tsx` monta
  `createBrowserRouter(routes)` uma vez, fora do componente, com o `RouterProvider` de
  `react-router/dom` dentro do `AppProviders`, e o `renderApp` dos testes monta a mesma árvore num
  `createMemoryRouter`. As telas buscam dados pelo React Query: nada de loaders, actions nem o
  `lazy` do roteador.
- **Erro por rota, sem tela branca.** Há dois `errorElement`: o `RootError` na raiz (página
  inteira, para login, cadastro, parear e `/admin/*`) e o `RouteError` numa rota sem caminho filha
  do `RequireSession`, que aparece no `Outlet` do shell com a barra, o cabeçalho e a fila de
  importação de pé; a troca de localização reinicia o boundary, então a barra tira do erro. A
  falha de chunk (mensagem do `import()` dinâmico do Chromium, Firefox ou WebKit, ou o preload do
  Vite) vira "O eclume foi atualizado"; a exceção comum, "Algo deu errado nesta tela". As duas têm
  "Recarregar", nunca mostram pilha e registram no `console.error`.
- **Recarga única por chunk antigo** (`app/chunkReload.ts`, registrado no `main.tsx`): no
  `vite:preloadError`, se a última recarga por chunk (carimbo `eclume-recarga-chunk` no
  `sessionStorage`) tem mais de 60 s, grava o carimbo, cancela o evento e recarrega; senão o erro
  segue para o `RouteError`. A janela de tempo, e não uma bandeira eterna, deixa um segundo deploy
  na mesma aba recarregar de novo. O estático da imagem `eclume-web` responde `404` sem
  `immutable` para `/assets/*` ausente, então o `import()` falha rápido e com motivo.
- **Guarda de saída** (`app/useLeaveGuard.tsx`): com alterações não salvas, fechar ou recarregar a
  aba dispara o aviso do navegador (`beforeunload`), e ir para outra rota do app pede confirmação
  pelo `useBlocker`, só quando o `pathname` muda (o `?t=` da gravação e a seleção na URL passam);
  devolve o diálogo com "Continuar editando" e "Descartar". Usam o guarda a edição do resumo e a
  seleção de Campos personalizados e Tipos de agenda; o `ImportProvider` fica só com o
  `beforeunload`, porque vive no shell e não desmonta na navegação interna.
- **Retentar a transcrição.** Toda gravação `failed` mostra "Tentar de novo"
  (`RetryTranscription`, `POST .../retranscribe`), sem comparar com `recording.owner` (obsoleto: a
  conta só vê o que é dela; um 403/404 aparece pelo `errorMessage`), com a falha passageira
  (`error.retryable`) dita como tal; a Saúde do admin tem o mesmo botão por falha recente, pela retentativa do admin.
- **Idioma da transcrição.** A lista de idiomas do Whisper vive em `src/lib/languages.ts` (usada
  pelo admin e pelas telas do usuário, sem cruzar features) e o seletor em
  `shared/LanguageSelect.tsx`; o padrão aparece sempre nomeado pelo idioma real ("Padrão do
  servidor: Português", "Padrão da conta: Inglês"), e "Detectar automaticamente" só para `auto`.
  Conta tem **Idioma da transcrição** (`GET`/`PATCH /me/transcription`, grava na hora; vazio é o
  padrão do servidor). O Importar tem a coluna **Idioma** por arquivo, partindo do padrão da conta
  e levada só na criação do upload. A gravação mostra o idioma no kicker e, em `RecordingHeader`,
  **Transcrever de novo em…** (`RetranscribeAction`, em `RetryTranscription.tsx`) para gravação
  pronta ou falha, com o diálogo de idioma e a confirmação do que muda (revisão nova, correções à
  mão perdidas, pessoas dos locutores de volta, campos, tipo e resumo refeitos); o 409 vira "Já há
  uma transcrição em andamento.". Tudo isso fica em rotas e no modal sob demanda: o motor de upload
  do bundle inicial só ganhou o campo `language`.
- **Agente** (`src/features/agent/`, holetz/eclume#142): `agent.ts` tem os hooks sobre
  `/agent/sessions`; `AgentPage` (`/agente/:sessionId?`, uma rota só, para a primeira pergunta
  abrir a conversa sem remontar a tela) mostra as conversas recentes ao lado (até 20, com Nova
  conversa e Todas as conversas), a conversa e o compositor com **Anexar** (`.txt,.md,.csv,.pdf,.docx`,
  até 5 por pergunta e 10 MB cada, conferidos antes do envio) e os anexos da próxima pergunta, que
  saem com o ×. Sem conversa na rota, a primeira pergunta ou o primeiro anexo cria a conversa,
  semeia o cache dela vazia e troca a rota (`replace`). Cada resposta consulta a própria mensagem a
  cada 2 s até `done` ou `failed`; a conversa tem `staleTime` de 1 min, porque as mutações da tela
  já atualizam o cache e reler a conversa no meio de uma pergunta apagaria a pergunta enviada. Os
  arquivos gerados e os anexos são links `download` para `GET /agent/files/{id}/content` (mesma
  origem, sessão por cookie). `ConversationsPage` (`/agente/conversas`) lista todas por página, com
  Renomear (diálogo) e Excluir (confirmação).
- **Habilidades e ações do Agente** (holetz/eclume#145, `features/agent/skills.ts`,
  `SkillsPage.tsx`, `ActionCard.tsx`): `SkillsPage` (`/agente/habilidades`) lista as habilidades,
  cria e edita num diálogo (nome normalizado sem barra e em minúsculas, descrição, instruções e, com
  "Limitar as ferramentas", as permitidas do catálogo `GET /agent/tools`), liga, desliga e exclui
  com confirmação. No compositor do Agente, o seletor "Habilidade" lista as ligadas e manda
  `skill`; uma mensagem que começa com `/` vai como está, porque o servidor lê o prefixo. A pergunta
  mostra o chip `/nome`. Cada proposta da resposta (`AgentMessage.actions`) vira um `ActionCard`
  (`section` "Ação proposta"): o resumo, o estado, os 10 primeiros alvos com link (e "e mais N") e
  Confirmar/Descartar enquanto `proposed`; confirmada, consulta `GET /agent/actions/{id}` a cada 2 s
  até terminar e mostra o resultado por alvo.
- **Navegação agrupada numa lista só** (`src/app/nav.ts`): cada item tem `section` (`main` ou
  `header`), `enabled` e, opcionais, `matches` (prefixos que também acendem o item: a Biblioteca
  fica marcada em `/gravacoes/`) e `excludes` (prefixos sob a rota do item que são de outro e não
  o acendem); o item comum tem `group`, e `navGroups()` devolve as duas seções.
  **Agente** (`/agente`, holetz/eclume#142; antes Perguntar, em `/perguntas`) é o único item **destacado** (`featured`, com
  `icon` e sem grupo): é o primeiro da lista e da barra lateral, `navGroups()` o deixa de fora e
  `featuredItem()` o entrega ao `AppShell`, que o desenha antes dos grupos como `.btn-primary` do
  DS em largura total, com o ícone `MessageSquareText` (`aria-hidden`) e `aria-current="page"` em
  `/agente` e numa conversa (`/agente/:sessionId`), mas não em `/agente/conversas` nem em `/agente/habilidades` (`excludes`), onde fica no tom de "pressionado" (`--color-accent-700`). Enquanto a conta não tem
  gravação (a mesma pergunta `GET /recordings` com `limit=1` da biblioteca, chave
  `['recordings', 'any']`), ele perde o destaque, não o lugar: vira `.btn-secondary`, ainda primeiro e
  acessível. A principal, abaixo dele, tem o grupo **Agente** (Conversas, em `/agente/conversas`, e
  Habilidades, em `/agente/habilidades`), Gravações (Biblioteca, Busca; importar é o modal da
  biblioteca), Organizar, com os dados da conta (Pessoas, Coleções, Tags), e Regras, com o que age
  sozinho depois de cada gravação (Processamento automático, Tipos de agenda, Campos
  personalizados); as rotas não mudam com o grupo. A `header` vai para os menus do cabeçalho:
  Minhas configurações e Ajuda (Central de ajuda). Na engrenagem, cada item tem a sua parte
  (`part`), na ordem **Conta e privacidade** (Conta), **Aparelhos** (App desktop, App móvel),
  **Integrações** (Conexão MCP, Tokens de acesso) e **Ambiente**; o `AppShell` abre cada parte com
  um `{ heading }` do `MenuButton`, um `role="separator"` com `aria-label` e o texto em
  `.menu-heading` (`app.css`), que o teclado não foca. Submenus aninhados não entram, pelo custo
  de teclado e de toque. Uma área nova entra desligada, com a rota do mapa
  de telas v6, e ligá-la é mudar `enabled` e registrar a rota. Há um só
  `<nav aria-label="Principal">`; cada grupo é um `role="group"` rotulado pelo título, e o destaque
  fica fora deles. Não há item "Painel admin": a conta de usuário não tem papel, e o painel se abre
  pelo endereço `/admin/entrar`, com conta própria.
- **Cabeçalho do shell** (`ShellFrame` com `account`): uma faixa de 3,25rem (`--shell-header`),
  fixa no topo em qualquer largura, com a marca à esquerda e a conta à direita: nome e e-mail, o
  menu **Ajuda** ("Ajuda desta página", que abre a gaveta, e "Central de ajuda"), o menu
  **Configurações** (Minhas configurações) e, depois de uma barra de 2px, **Sair**. Escolher um
  item navega sem mexer na barra lateral, que só tem a navegação principal. Abaixo de 56rem, o
  nome e o e-mail somem e o botão Menu abre a barra lateral por cima. Telas que grudam elementos no
  topo (os filtros da biblioteca, o chat da gravação) usam `top: var(--shell-header)`.
- **Cabeçalho de página** é o `PageHead` (`.page-head` do DS: kicker opcional, `h1`, ações e, no
  shell, o botão Ajuda); ele também dá o título da aba (`usePageTitle`), com o contador do
  observador de desfechos na frente quando há. Rota desconhecida mostra
  `NotFoundPage` dentro do shell, com o link de volta à biblioteca.
- **Gaveta de ajuda** (`help.ts`, `HelpProvider`, `HelpDrawer`): o `HelpProvider`, montado no
  `AppShell`, abre a `.help-drawer` com `?` (sem Ctrl, Meta ou Alt, fora de `input`, `textarea`,
  `select` e `contenteditable`) ou pelo botão Ajuda do `PageHead`, e fecha com Esc, devolvendo o
  foco a quem abriu. A página declara a sua chave de página com `useHelpTopic(chave)`, e o corpo da
  gaveta (carregado sob demanda) mostra a busca, os artigos daquela chave e os atalhos, com o link
  para a central. Artigos, chaves, busca e dicas em linha:
  [web-central-de-ajuda.md](web-central-de-ajuda.md).
- **Chaves do TanStack Query por área**, com prefixo fixo (`['people', ...]`, `['collections']`,
  `['tags']`, `['recordings', ...]`, `['admin', ...]`): uma mutação que muda contagens ou nomes
  vistos em outras telas invalida o prefixo inteiro, além de gravar no cache o que a resposta
  devolveu.
- **Administração** (`/admin/*`, `src/features/admin/`) é um **app à parte dentro do web**, fora
  de `RequireSession` e do `AppShell`; `/admin/entrar` e `/admin/*` carregam sob demanda o chunk
  do painel, e nada dele entra no bundle inicial do usuário.
  - **Sessão própria.** `adminSession.ts` tem `useAdminMe()` (`GET /admin/me`, chave
    `['admin', 'me']`, 401 → `null`), `useAdminLogin()` e `useAdminLogout()` (que limpa todo o
    prefixo `['admin']`). A guarda é o `RequireAdmin`: sem sessão de admin, vai para
    `/admin/entrar?volta=<rota>`; `volta` só vale dentro de `/admin/`. Um 401 em
    `/api/v1/admin/` no meio do uso chega pelo `onAdminUnauthorized` do `client.ts` e devolve ao
    login. O painel nunca lê `useMe`, e o app do usuário nunca lê a chave do admin. Esconder link
    não é controle de acesso: a fronteira é o cookie de caminho `/api/v1/admin`.
  - **Entrar como admin** (`/admin/entrar`) usa o `AuthLayout` na variante `admin` (`.auth-admin`
    do DS, campo da marca em tinta), sem cadastro nem "esqueci a senha": conta e senha de admin
    ficam no CLI (`eclume-server admin create` e `admin set-password`).
  - **Moldura** `AdminShell`, sobre o `ShellFrame` que também serve ao `AppShell` (barra lateral
    fixa e menu compacto abaixo de 56rem; sem `account`, sem o cabeçalho do app): marca, selo "Admin", o grupo "Plataforma" e, no
    rodapé, o nome e o e-mail do admin com "Sair". A barra vem de `ADMIN_SECTIONS`
    (`sections.ts`), na ordem Usuários (`/admin/usuarios`), Pré-processamento de áudio
    (`/admin/audio`), Transcrição (`/admin/transcricao`), Locutores (`/admin/locutores`), Agentes
    (`/admin/agentes`), Tipos de agenda padrão (`/admin/tipos-de-agenda`) e Saúde
    (`/admin/saude`). `/admin` vai para Usuários; as rotas antigas redirecionam com `replace`:
    `/admin/voz` e `/admin/segredos` → Locutores, `/admin/templates` → Tipos de agenda padrão. Rota
    desconhecida mostra "Página não encontrada" dentro do painel.
  - **Salvar da configuração** fica desabilitado sem mudança, e cada tela manda só os seus blocos
    no `PATCH /admin/settings` (merge por bloco), para uma tela não sobrescrever a outra.
  - **Segredos só de escrita**, no `SecretField` (guardado, Substituir, Apagar com confirmação; a
    tela nunca mostra parte do valor), cada um junto do que o usa: o token do Hugging Face em
    Locutores, a chave compartilhada da Anthropic e o token de cada provider em Agentes. Não há
    tela Segredos.
  - **Desligar a identificação por voz pede confirmação** (`ConfirmDialog`) antes do `PATCH`,
    porque o server apaga as impressões de voz da plataforma nesse momento.
  - **Aviso de dados fora do servidor** (`ExternalDataNotice`, `.alert-warning` com `role="note"`):
    em Agentes (finalidades de agente) e em Transcrição (a engine remota), lido de `GET /privacy`,
    diz o que sai e para quem e que os usuários veem isso em Conta › Privacidade e dados e no
    cadastro. Relê quando a configuração muda (`usePrivacy(revision)`); sem destino externo, nada
    aparece.
  - **A Saúde relê a cada 15 s** (`HEALTH_REFRESH_MS`, alinhado ao heartbeat do worker), só com a
    aba visível (`refetchIntervalInBackground: false`), e mantém os últimos dados num erro.
  - **Nenhuma tela do painel mostra conteúdo de usuário**: nem título de gravação, nem nome de
    arquivo, nem link para `/gravacoes`. Usuários mostra nome, e-mail, cadastro, contagem de
    gravações e estado; as falhas da Saúde mostram etapa e código.
  - **Gerar link de senha** (Usuários, só nas contas ativas): o diálogo pede confirmar quem pede,
    `POST /admin/users/{id}/password-reset` e, na resposta, mostra o link uma única vez com o
    `CopyValue` e a orientação de entregá-lo por fora; fechar o diálogo descarta o link.

  As regras do server estão em [server-admin.md](server-admin.md).
- **Rotas públicas:** `/entrar`, `/cadastro`, `/redefinir-senha`, `/parear` e `/admin/entrar`. Criar conta (`SignupPage`) lê
  de `GET /auth/signup` se o cadastro está aberto e o aviso em vigor, pede nome, e-mail, senha de
  12+ (`MIN_PASSWORD`, o `minLength` do contrato) e o aceite obrigatório do aviso, e envia a
  `notice_version` aceita. **Criar conta** fica sempre ativo: enviar com falta não chama a API,
  mostra no `role=alert` o que falta, na ordem do formulário ("Para criar a conta, falta o nome, o
  e-mail, a senha com 12 caracteres e o aceite do aviso."), foca o primeiro campo pendente e liga o
  resumo ao botão por `aria-describedby`; a lista acompanha o preenchimento; a resposta abre a sessão, como o login. `email_taken` vira "Já existe
  uma conta com este e-mail."; cadastro fechado (`open: false` ou `signup_closed`) mostra o aviso
  no lugar do formulário. Antes do aceite, quando os resumos ou o chat saem do servidor
  (`GET /privacy`, `location: external`), uma linha diz quais e para quem ("Neste servidor, os
  resumos e o chat são feitos fora dele, por Anthropic…"); sem destino externo, nada aparece. O
  título da entrada (`AuthLayout`, variante `user`) é "Cada palavra, guardada no seu servidor.":
  o áudio e a transcrição ficam guardados nele, sem prometer que nada sai (holetz/eclume#116; a
  forma final sai do Claude Design).
- **Senha esquecida:** a entrada diz "Esqueceu a senha? Peça um link a quem administra o
  servidor." (o servidor não envia e-mail). `ResetPasswordPage` (`/redefinir-senha#<segredo>`, fora
  do `RequireSession`) lê o segredo do fragmento ao montar, antes de qualquer redirecionamento, e o
  manda no corpo de `POST /auth/password-reset/check` (mostra o e-mail da conta) e de
  `POST /auth/password-reset` (senha nova duas vezes, 12+). Sem segredo ou com
  `invalid_reset_link`, mostra "Este link venceu ou já foi usado. Peça outro a quem administra o
  servidor." no lugar do formulário. Redefinida, relê a sessão e leva a `/entrar` com o aviso
  "Senha redefinida. Entre com a nova." por `state`, como a conta excluída.
- **Aceite do aviso em vigor:** com `notice_required: true` em `/me`, o `RequireSession` mostra o
  `NoticePage` (na `.auth`) no lugar do shell, até `POST /me/notice` com a versão lida de
  `GET /auth/signup`.
- **Estado de servidor com TanStack Query.** O polling de espera é declarativo e tem um ritmo só
  (`app/polling.ts`, `pollWhile(estáEsperando, inicial)`): o intervalo inicial (2–3 s) nos
  primeiros 2 min de espera, depois dobrando a cada minuto até 30 s, e nada com a consulta em
  `error`; voltar para a aba ou a rede voltar recomeçam do inicial. Vale para gravação, resumo,
  chat da gravação, chat da base, pré-visualização e código de vínculo. Três leituras têm ritmo
  próprio (holetz/eclume#153), todas com recuo exponencial (`backoffDelay`, `app/polling.ts`):
  a **biblioteca** (período e lista) mantém o `pollDelay` (3 s de início, até 30 s), mas com
  gravação em andamento lê só `GET /recordings?since=` (maior `updated_at` do cache menos
  `SINCE_MARGIN_MS`, 60 s, com os mesmos `from`/`to`/filtros) e mescla por id no cache com
  `setQueryData` — no período entram também as novas, na lista só as que já estavam; a releitura
  completa fica para o foco, a volta da rede e a cada `FULL_EVERY` (20) leituras incrementais
  (que pega a gravação apagada); a **Saúde do admin** parte de `HEALTH_REFRESH_MS` (15 s) e dobra a
  cada leitura sem mudança até `HEALTH_MAX_REFRESH_MS` (60 s), comparando os dados sem relógio,
  latência e uso da GPU (`backoffWhileUnchanged`), recomeçando ao mudar, ao voltar para a aba
  (que também relê na hora) ou à rede; a **faixa de conexão** tenta `/me` a cada `RETRY_MS` (10 s)
  dobrando a cada falha até `RETRY_MAX_MS` (60 s). O padrão global é `refetchOnWindowFocus: false`; as
  gravações (período, lista, gravação), o estado do resumo e o histórico do chat ligam a releitura
  no foco, para uma gravação do desktop ou do celular aparecer sem recarregar. Formulários
  (Campos, Tipos de agenda, Conta) não são relidos debaixo de quem edita. Mutações gravam no cache o que a resposta
  devolve, sem refazer a leitura.
- **Arquivo `.tsx` exporta só componentes** (regra do react-refresh): hooks, constantes e
  funções puras ficam em `.ts` ao lado. **Nunca com o mesmo nome em caixa diferente**
  (`Pipeline.tsx` e `pipeline.ts`): no Windows o sistema de arquivos não distingue caixa, e o Vite
  resolve `./Pipeline` para `pipeline.ts`; o módulo puro ganha outro nome (`steps.ts`).
- **Peças compartilhadas do DS** em `src/app/`: o `Dialog` (`.dialog-backdrop` num portal, foco no
  primeiro controle, Tab preso, Esc e clique no fundo fecham, rolagem travada, foco devolvido;
  `kicker` põe o cabeçalho com Fechar; o texto de uma confirmação vai em `message`, no
  `.dialog-body`, e formulário, tabela ou alerta vão em `children` com `plain`, fora do esmaecido;
  com um diálogo aberto, a gaveta de ajuda não abre nem fecha por atalho), o
  `ConfirmDialog` (Cancelar primeiro, confirmação em `btn-danger`, ocupado durante a mutação), o
  `MenuButton` (`.menu` com o teclado ARIA de menu: setas, Home/End, Enter/Espaço, Esc, clique
  fora; o item focado leva `data-active`), o `CopyValue` (`.code-block` com Copiar e o aviso no
  `role=status`; `size="lg"` para o código de vínculo) e o `HelpHint` (o `?` em linha com o
  popover e o link para o artigo; Esc fecha só ele).

## Visual e acessibilidade

- A base visual é o Design System do eclume ([web-design-system.md](web-design-system.md)):
  tokens e classes do `eclume.css`, fontes Archivo e IBM Plex Mono servidas pelo build, ícones
  Lucide e tema por `data-theme` no `<html>` ("Do sistema" resolve `prefers-color-scheme`; a
  escolha explícita fica no `localStorage`). Cor nova entra como token no DS. A tela Ambiente
  acrescenta `data-density="compact"` (a escala `--space-3` a `--space-8` apertada no `app.css`) e
  `data-motion="reduce"` (as mesmas regras do `prefers-reduced-motion`), aplicados no boot pelo
  `applyEnvironment()`.
- As telas de acesso usam o `AuthLayout` (`.auth` do DS: campo da marca e formulário alinhado à
  esquerda); o resto fica no `AppShell` (`.shell`, `.sidebar`, `.main`), com a barra superior e o
  menu compacto abaixo de 56rem.
- CSS Modules por componente, só com o que o DS não tem. Sem framework de CSS e sem fonte
  externa.
- Toda ação alcançável por teclado, foco visível, skip link, rótulos em todos os campos,
  `aria-live` em progresso e confirmações. Estado nunca só por cor: o selo tem texto.
- **Vocabulário de estados compartilhado** (`src/lib/vocabulario.js`, módulo ES puro com
  `vocabulario.d.ts`): os nomes em pt-BR dos estados no aparelho, dos estados da gravação no
  servidor ("Na fila" só para a espera pela transcrição; "Cancelada" para a gravação `failed` com
  etapa pulada por `cancelled`; "Aguardando locutores", em tom de aviso, para a etapa `speakers` em
  `waiting`), das sete etapas na ordem de `STEPS` (o estado `waiting` é "aguardando você") e o
  texto de cada código de motivo (`MOTIVOS`). É a fonte única: o desktop e o celular têm cópias byte a byte, conferidas por
  teste em cada cliente, e `vocabulario.test.ts` falha quando o servidor grava um código de motivo
  sem texto. Tela nenhuma escreve esses rótulos à mão.
- **Motivo em texto visível, nunca só no `title`.** Uma etapa pulada ou que falhou, uma linha que
  falhou no Importar ou na fila do desktop mostram o motivo em texto na tela; `title` pode repetir,
  nunca ser o único portador.
- Enum desconhecido na resposta aparece cru, sem quebrar a tela (o contrato só cresce).

## Biblioteca no tempo

A tela inicial (`/`, `src/features/library/`) é um calendário (frame "Library · week", variante A):

- **Três visões no `.seg`**: Semana (`.cal-week`, padrão), Mês (`.cal-month`, até três `.cal-dot`
  por dia e "+N"; o número do dia abre a semana dele) e Lista (`.day-group` com `.rec-row`, da mais
  recente, "Carregar mais"). Abaixo de 56rem, sem `visao` na URL, abre na Lista, e a semana rola
  de lado dentro do próprio contêiner (`min-width: 720px`).
- **Posição por hora e duração** (`calendar.ts`, datas locais do navegador): a semana vai de
  segunda 00:00 à segunda seguinte; cada gravação ganha `--s` (hora de início local) e `--d`
  (duração em horas, 0,1 para nota ou duração nula, cortada na meia-noite). A grade mostra o dia
  inteiro (0–24, com rótulo também em 24:00) e rola por dentro, com a altura que sobra na janela e
  o cabeçalho dos dias fixo. O expediente (`readWorkHours()`, 8–18 ou o da tela Ambiente) tem fundo de superfície e rótulos
  na tinta principal, e a semana abre sempre com o zoom enquadrando ele; o resto do dia fica a um
  pan ou zoom out. Gravações sobrepostas no mesmo dia dividem a coluna
  em faixas (`lanes()`, guloso por início), que o DS não trata.
- **Zoom da semana**: os botões do canto sobre as horas e Ctrl + roda sobre a grade mudam
  `--cal-hour` em passos de 1,25×, mantendo parada a hora sob o cursor (ou no meio, pelos botões).
  O mínimo é o dia inteiro na altura da grade, o máximo 480px por hora. No mês, as semanas dividem
  a altura da tela por igual (mínimo de 96px por célula).
- **Estado em palavra** (`recordingState()`, de `status` e do `pipeline`): falhou (régua de
  perigo), em andamento com a etapa corrente ("Resumindo", "Transcrevendo", "Na fila"...) ou pronta
  (com "Sem resumo" quando a etapa do resumo falhou). Nota de voz tem a régua pontilhada;
  marcadores aparecem como `.marker-count`. O `aria-label` do evento diz tudo:
  "Reunião de equipe, 09:00, 58 min, Resumindo, 3 marcadores".
- **Consulta** (`queries.ts`): o período vai em `GET /recordings` com `from`, `to`,
  `sort=recorded_asc` e `limit=200`, seguindo o cursor até 5 páginas ("Mostrando as primeiras 1000
  gravações deste período"); a Lista usa `sort=recorded_desc` e `limit=50`. As duas releem a cada
  3 s enquanto alguma gravação está em andamento, lendo só o que mudou (`?since=`, ver
  "Estado de servidor com TanStack Query").
- **Painel de filtros** à direita (`.with-filters` e `.filters`, recolhível até 48px): Tipo,
  Precisam de você ("Aguardando locutores", `precisa=locutores` na URL, que vira
  `awaiting=speakers`), Situação, Tags, Pessoas (o `PersonCombobox` em linha), Participantes (empresa, área e tag de
  pessoa, com os valores de `GET /people/facets`; `empresa`, `area` e `tag-pessoa` na URL, que
  viram `person_company`, `person_department` e `person_tag`, e valem para uma mesma pessoa),
  Coleções (com "Gerenciar coleções") e um grupo por campo próprio do usuário (escolha como `.check`, texto e lista como "Qualquer valor",
  aplicado no Enter ou ao sair). Os filtros vão na URL (ver as rotas) e viram os filtros
  repetíveis de `GET /recordings`; `STATUS_GROUPS` mapeia a Situação ao enum de `status` (Pronta =
  `transcribed`, Processando = `uploading`/`queued`/`processing`, Falhou = `failed`). Um grupo com
  tudo marcado não manda o parâmetro, e o último marcado não sai. Abaixo de 56rem, o painel é um
  `Dialog` aberto por "Filtros (N)".
- **Aviso "Precisam de você"** (holetz/eclume#144): com `GET /me/speaker-naming` dizendo
  `waiting_count > 0`, uma faixa `alert-warning` acima da barra conta as gravações que aguardam
  você nomear os locutores; "Ver" liga o filtro na lista. Some com o filtro já ligado.
- **Persistência** (`src/app/storage.ts`, `localStorage` com `try/catch`): o painel lembra se está
  recolhido (`eclume-biblioteca-filtros-recolhidos`) e a biblioteca, a última query string sem o
  `importar` (`eclume-biblioteca-ultima:<user_id>`, por conta, porque guarda ids de pessoa, tag,
  coleção e campo; a chave global antiga sai na primeira leitura). As outras preferências
  (densidade, movimento, colunas, expediente, painel recolhido) são por aparelho. "Limpar filtros"
  tira tudo menos `visao` e `data`.
- **Restauração uma vez só**: quando `/` abre sem parâmetros, a página volta à última biblioteca
  guardada (ou abre na visão da tela Ambiente) por um `replace`, e a flag `restoring` cai assim que
  a URL restaurada chega. Depois disso, marcar e desmarcar filtros, trocar a visão e andar pelas
  datas são só navegação: o `setParams` do `useSearchParams` muda de identidade a cada mudança da
  URL, então uma restauração sem essa trava roda de novo a cada filtro e o desfaz (com a abertura
  "última" chega a alternar com a gravação da guardada, em laço). A flag cai no próprio render, e
  não num efeito, porque o lint (`react-hooks/set-state-in-effect`) proíbe `setState` síncrono em
  efeito. Fora da restauração, a guardada acompanha a URL, e uma URL vazia a **apaga**: tirar o
  último filtro não o ressuscita na próxima visita.
- **Estados**: carregando (grade com `aria-busy` e "Carregando gravações…"), erro com "Tentar de
  novo", "Nada gravado neste período." e, numa conta sem nenhuma gravação (`GET /recordings` com
  `limit=1`), o cartão "Nenhuma gravação ainda", que ensina os caminhos reais: importar, o app
  desktop, o app do celular (`/app-movel`) e o tipo de agenda que dá título e resumo. A faixa
  `alert-info` "Enviando 1 de 3 arquivos · Abrir" acompanha a fila de importação.
- **Primeiros passos** (`FirstSteps`): cartão no topo da biblioteca enquanto há passo pendente, com
  três passos derivados, sem contrato novo: (1) traga a primeira gravação (a conta tem gravação,
  `useHasAnyRecording`, em `library/anyRecording.ts`, módulo próprio para o shell não puxar as consultas da biblioteca ao JS inicial), com importar, app desktop e app do celular; (2) confira os tipos de agenda
  (abrir `/config/agendas` neste navegador grava `eclume-tipos-de-agenda-visto`); (3) ligue um
  locutor a uma pessoa (a conta tem pessoa, `GET /people` com `limit=1`, `useHasAnyPerson`). Cada
  passo feito ganha o check e "(feito)" para leitor de tela; com os três feitos o cartão some
  sozinho, e **Dispensar** grava `eclume-primeiros-passos-dispensado`. As duas chaves são deste
  navegador, como as preferências de Ambiente, e "Restaurar os padrões" as apaga.

## Importar: modal e fila

- **Importar é um modal da biblioteca** (`ImportDialog`, variante A): `/?importar=1` o abre, e a
  rota antiga `/importar` redireciona para lá. O modal (e o conversor que ele puxa) carrega sob
  demanda. Tem a `.dropzone` e a `.table` com Arquivo (nome e tamanho), **Início da gravação**
  (`datetime-local` com a origem embaixo: "Dos metadados do arquivo", "Sem data no arquivo · usando
  a data de modificação, confira" no tom de aviso, ou "Editada por você"), Duração, Situação e
  remover/cancelar. "Enviar N arquivos" fica desabilitado enquanto há leitura ou data vazia.
- **A data vem dos metadados, lidos antes da conversão** (`readRecordedAt`,
  [formato-audio-upload.md](formato-audio-upload.md)). O upload manda `recorded_at` e
  `recorded_at_source` (`file_metadata` sem edição; `user` quando editada ou vinda do fallback) e
  não manda `title`.
- **A fila vive no shell** (`ImportProvider` envolvendo o `ShellFrame` do `AppShell`, `useImportQueue`, `importContext.ts`):
  fechar o modal ou navegar não perde o envio. Os arquivos são convertidos e enviados **um por
  vez**; cancelar aborta e apaga o upload; "Tentar de novo" retoma pelo `uploadId` ou reconverte.
  A fila guarda os itens num ref, a fonte da verdade do laço de envio, e o estado só espelha o ref
  (o laço não espera o React renderizar). Enquanto há conversão ou envio, o `beforeunload` avisa,
  e "Sair" pede confirmação ("O envio em andamento será interrompido.").
  Terminado um envio, a biblioteca é relida (`['recordings']`).

## Página da gravação

`/gravacoes/:id` é centrada no resumo (frames "Recording", "transcript with markers" e "editing the
summary", variantes A), em largura total com o chat numa coluna de 340px (abaixo de 72rem o chat
desce; abaixo de 56rem, os campos também):

- **Cabeçalho** (`RecordingHeader`): "← Biblioteca" volta à URL de onde a pessoa veio
  (`location.state.from`, posto pelos links do calendário, da lista e da busca); o kicker diz
  data, hora e duração ("· data do envio" quando `recorded_at_source` é `upload`); **Exportar** é
  um `MenuButton` (TXT, SRT, MD — desabilitado sem resumo — e DOCX) que baixa pelo cliente da API
  (`parseAs: 'blob'`, nome do `Content-Disposition`) e mostra o `Problem` num alerta; um 401 no
  export encerra a sessão como qualquer outra chamada; **Excluir** pede confirmação, tira a gravação do cache, relê a biblioteca e
  volta com "Gravação excluída.".
- **Pipeline** (`Pipeline.tsx`, rótulos em `steps.ts` pelo vocabulário): as sete etapas no
  `ol.pipeline`, cada uma com o estado em palavra quando não está concluída ("Resumo · pulada"), a
  lista "Motivos das etapas" sob a barra com o motivo de cada etapa pulada, em espera ou que falhou, o progresso do worker com a
  transcrição em andamento e o `RetryTranscription` numa falha. A gravação relê no ritmo de
  `pollWhile` (3 s de início) enquanto está em andamento ou aguardando locutores, e uma etapa de campos, tipo ou resumo que termina relê campos e resumo.
- **Aguardando locutores** (`AwaitingSpeakers.tsx`, holetz/eclume#144): com a etapa `speakers` em
  `waiting`, o `Pipeline` mostra um `alert-warning` (`role="status"`) que leva a `#locutores` e
  oferece **Seguir sem nomear** (`ConfirmDialog`, `POST /recordings/{id}/continue`). Ligar ou
  mesclar locutor no painel muda a transcrição em cache; o aviso percebe a troca dos vínculos e relê
  a gravação, que o servidor já soltou se o último ganhou pessoa. O aviso fica no `Pipeline`, não no
  `children` do `SpeakersDisclosure`: parada à espera, a `RecordingPage` abre o bloco Locutores
  sozinha, e um `hashchange` para `#locutores` o reabre se a pessoa o recolheu.
- **A linha da espera** (holetz/eclume#117): com a gravação `queued`, o `Pipeline` mostra em
  `role="status"` a frase de `fraseDaEspera(job.queue)` do vocabulário compartilhado — posição e
  início estimado ("3ª na fila · começa em cerca de 12 min (estimativa)"), as gravações da própria
  conta antes, a hora em que a janela de minutos libera ou "O processador está fora do ar desde
  14:02; sua gravação está guardada e entra quando ele voltar". Sem `queue` (servidor anterior),
  "Aguardando a vez na fila de transcrição.". A previsão vem sempre rotulada como estimativa; o
  cartão da biblioteca segue "Na fila". Os textos são provisórios até a referência visual da
  holetz/eclume#117 (tarefa 1.1).
- **Reprodução compartilhada** (`PlaybackProvider`, `playback.ts`): um único `<audio>` liga o
  player compacto (tocar, trilha com `range` para teclado, um `.player-tick` por marcador, a
  velocidade 1×–2×), a `.marker-bar` (ficha por marcador, que toca dali, e "Marcado no
  <dispositivo>" quando é um só) e as falas. O `src` é `/recordings/{id}/audio`, que responde 302
  para uma URL assinada de 1 h: no `error` do `<audio>`, o provider troca o `src`
  (`?renovacao=<n>`, para não reaproveitar o 302), volta ao mesmo instante e à velocidade no
  `loadedmetadata` e retoma tocando se tocava, uma vez sozinho (de novo depois de voltar a tocar);
  a segunda falha expõe `error` no contexto e o player mostra "O áudio não carregou" com "Tentar de
  novo", com o tocar desabilitado. Erro antes do primeiro carregamento num navegador cujo
  `canPlayType('audio/ogg; codecs=opus')` é vazio vira o aviso de que ele não toca Ogg Opus.
  **O instante não passa pelo contexto**: fica numa store (`PlaybackClock`, escrita no `timeupdate`
  e no `seek`), lida por `usePlaybackTime()` (o player) ou por `usePlaybackSelect(seletor)`, que só
  renderiza quando o valor primitivo selecionado muda (a fala ativa). O contexto leva duração,
  tocando, velocidade, erro e comandos, e só muda quando um deles muda: a `.marker-bar` e quem só
  comanda não renderizam por tick. **O player fica fixo** (`position: sticky` abaixo de
  `--shell-header`, sobre `--color-bg`, sem a `.marker-bar`): pausar está a um clique em qualquer
  ponto da página, inclusive lendo o resumo (holetz/eclume#143).
- **Locutores** (`SpeakersDisclosure`, `details.disclosure` próprio, fechado, entre a `.marker-bar`
  e a transcrição): recolhido, o resumo mostra cada locutor em linha, na horizontal, no `.speaker`
  da cor dele; aberto, o `SpeakersPanel` (região "Locutores", `id="locutores"`) traz um card por
  locutor numa grade (`repeat(auto-fill, minmax(15rem, 1fr))`, fundo `--color-surface`) com
  renomear, ligar pessoa, sugestões por voz e, abaixo da grade, juntar. O aberto é estado da
  `RecordingPage`, e o `children` do componente é o lugar de um aviso sobre os locutores, antes dos
  cards. Os locutores não aparecem dentro da transcrição nem no painel de campos.
- **Transcrição recolhida** (`TranscriptDisclosure`, `details.disclosure` fechado): o resumo diz
  locutores, falas e marcadores; aberta, tem "Acompanhar o áudio" e as falas no `.segment` do DS, com a `.segment-marker` antes da
  primeira fala que começa no marcador (`placeMarkers`), editar a nota (até 500) e excluir o
  marcador. As falas só renderizam com ela aberta. Com `?t=<ms>`, abre sozinha, posiciona o áudio
  sem tocar e, **uma vez**, traz a lista à janela (`scrollIntoView` com `block: 'nearest'` no
  contêiner, nunca na fala) e centra nela a fala do instante, independente do seguir.
  - **Área de rolagem própria** (holetz/eclume#143): a lista de falas (`role="list"` "Falas") é o
    contêiner que rola, mais baixo que a janela (`max-height: min(28rem, 55vh)`, `overflow-y:
    auto`, `overscroll-behavior: contain`). O `?t=` e o acompanhar rolam só ela, pelo `scrollTop`
    de `scrollTopFor` (`scroll.ts`: `nearest` com folga de 16 px, ou `center`) aplicado com
    `scrollTo`; `scrollIntoView` numa fala é proibido, porque rola todos os ancestrais, a janela
    inclusive, e tirava o player da tela. A lista não precisa de `tabIndex`: os botões das falas
    a tornam alcançável pelo teclado.
  - **Transcrição longa.** Cada fala é um `SegmentRow` memoizado com props estáveis (nome e cor do
    locutor e marcadores por índice saem de mapas em `useMemo` por transcrição; `active` e
    `editing` booleanos; `seek` e `setEditingId` como callbacks), e a fala ativa vem de
    `usePlaybackSelect` com o `findSegmentAt` (busca binária): um tick sem troca renderiza zero
    falas e uma troca renderiza duas. O item da fala tem `content-visibility: auto` com
    `contain-intrinsic-size: auto 5.5rem` no CSS Module: fora da tela não é pintado, mas fica no
    DOM, também dentro da área de rolagem. A virtualização foi descartada: o Ctrl+F do navegador e
    o leitor de tela precisam das falas no DOM.
  - **"Acompanhar o áudio"** (ligado por padrão) rola a lista por dentro a cada troca de fala, com
    `smooth`, esteja ela na janela ou não: a página nunca se mexe, e quem volta à lista a acha na
    fala certa. Desligado, nada rola.
  - **A medida é contrato**: `TranscriptDisclosure.test.tsx` conta renders sobre 3.000 falas (0 por
    tick sem troca, 2 na troca, a `.marker-bar` nenhum), e `TranscriptDisclosure.browser.test.tsx`
    (`npm run test:browser`, no host) mede o commit por `React.Profiler`: mediana de 20
    ticks abaixo de 8 ms sem troca e de 16 ms com troca. `TranscriptDisclosure.test.tsx` também
    prova que o `?t=` e o acompanhar chamam `scrollTo` na lista e nunca `scrollIntoView` numa fala,
    e o E2E prova, com 3.000 falas e o áudio avançando, o `scrollY` parado e o pausar na janela.
- **Documento do resumo** (`SummaryDoc`, `summary.ts`): o `SummaryState` (atual, gerada de
  referência e geração em andamento, relido no ritmo de `pollWhile` com pendência) com a `.doc-bar` (tipo,
  origem e versão; Copiar com título, Editar, Comparar com a gerada, Regenerar, Trocar tipo e
  Excluir resumo; o selo do tipo é o instantâneo do resumo e só vira link, "ajustar o modelo deste
  tipo" para `/config/agendas?tipo=`, se o tipo ainda existe em `GET /agenda-types`) e o Markdown pelo `react-markdown`, sem HTML cru. Sem tipo de agenda, gerar pede
  um ("Escolha um tipo de agenda para gerar o resumo."). Sem agente de resumo (etapa `skipped` com
  `no_provider`), diz "Sem resumo: nenhum agente configurado; fale com quem administra." e troca o
  "Gerar resumo" primário por um "Tentar de novo" secundário; o 422 de `provider_id` vira a mesma
  frase, nunca cru.
  **Regenerar** gera outra versão pelo tipo da gravação (`POST /transcripts/{id}/summaries` sem
  `agenda_type_id`) e sempre confirma antes, porque a nova versão passa a ser a atual e uma edição à
  mão deixa de ser a mostrada, embora fique guardada; fica desabilitado enquanto há geração em
  andamento e, sem tipo, abre o diálogo de trocar o tipo. **Copiar com título** põe na área de
  transferência `text/html` e `text/plain` (`copy-summary.ts`, o mesmo `react-markdown`, carregado
  sob demanda): o título da gravação e os de seção saem em negrito, sem `#`, porque o Teams não
  guarda o estilo de título ao colar; sem `ClipboardItem` cai no texto sem as hashtags dos títulos.
  O `ClipboardItem` nasce ainda no clique, com o conteúdo como promessa de `Blob`, porque o Safari
  recusa uma escrita na área de transferência começada depois de um `await`.
- **Edição** (`SummaryEditor`): o Markdown num `textarea` na tipografia do `.doc`, salvo com
  `base_version` = a versão aberta. O 409 `summary_changed` guarda o rascunho e oferece "Ver a
  versão N" (a comparação do rascunho com a nova) e "Salvar sobre a versão N". "Voltar à gerada"
  pede confirmação. O rascunho sobrevive a recarregar a aba (`summaryDraft.ts`): fica no
  `sessionStorage` em `eclume-resumo-rascunho:<recording_id>`, com a `base_version`, gravado ~500 ms
  depois da última tecla; ao reabrir a edição, volta direto se a base é a versão aberta e com o
  aviso de conflito se a base ficou para trás. Salvar, descartar (pelo Cancelar ou pelo guarda de
  saída) e voltar à gerada apagam o rascunho guardado. Sair da gravação com rascunho pede
  "Descartar a edição?" (o guarda de saída). **Comparar** é um diff por linha no cliente (`summary-diff.ts`, LCS), com
  `<del>`/`<ins>` e o sinal −/+ para quem não enxerga cor.
- **Campos** (`FieldsPanel`, `fields.ts`, componente "Filled fields" variante A): título e tags
  primeiro, depois os campos do usuário, com o selo de origem (Automático tracejado, Editado
  sólido, aceito sem selo), Aceitar, Aceitar tudo e Editar pelo tipo (texto até 300, lista por
  vírgula, escolha com "Nenhum"); o tipo de agenda com Trocar; as coleções (com "Nova coleção…");
  e, quando há, os "Dados anteriores" do `metadata` antigo, só leitura (os locutores ficam no bloco
  deles, acima da transcrição). Cada campo tem **Editar a regra**, que leva
  ao dono da regra: o campo personalizado a `/config/campos?campo=`, o título ao tipo da gravação
  (`/config/agendas?tipo=`) e as tags a `/tags`.
- **Chat "Ajustar o resumo"** (`ChatPanel`, `chat.ts`): o histórico no `role=log`, com uma
  `.msg-note` por leitura do agente ("Leu a transcrição, 00:03:20–00:04:20", "Buscou “orçamento”
  na transcrição · 3 trechos"); enviar recebe o 202 com as duas mensagens, e a resposta é
  consultada no ritmo de `pollWhile` (2 s de início) até `done` ou `failed`. O composer espera com um pedido em aberto (e no
  409 `chat_busy`) e sem resumo atual. Depois do último ajuste que mudou o resumo (`done` com
  `summary_id`), com a gravação num tipo, o painel oferece **Levar este pedido para as instruções do
  tipo**: abre `/config/agendas?tipo=` com o pedido no `state` da navegação
  (`InstructionsRequestState`, em `organize/queries.ts` para o grafo de features seguir sem ciclo), e o `AgendaTypeEditor` o acrescenta ao fim do rascunho das
  instruções do resumo, com um `role=status` explicando, sem salvar; o rascunho sujo fica sob o
  "Descartar alterações?" e o guarda de saída.

## Pessoas, busca e coleções

- **Abrir a gravação num instante** é o link `/gravacoes/:id?t=<ms>`: a página abre a transcrição,
  destaca a fala daquele instante, rola até ela e posiciona o áudio (sem tocar, pela política de
  autoplay). A busca e a página da pessoa geram o link com `recordingAt()`.
- **Busca** (`/busca`, frame "Search"): a barra de termos e uma segunda `.toolbar` com as fichas
  (`FilterChip`: `tag-neutral`, ou `tag-accent` ativa, com "Rótulo: valor" e um popover no estilo do
  `.menu`) de Período (qualquer, últimos 7 ou 30 dias, este ano, intervalo), Pessoa, Tag, Coleção e
  um por campo próprio do usuário; "Limpar" tira tudo menos os termos. Os acertos saem agrupados por
  gravação (`group.ts`): só os consecutivos da mesma transcrição se juntam, para o ranking ficar
  como veio; o total diz "7 trechos em 3 gravações" (com "ou mais" quando há outra página).
- **`highlight` da busca nunca vira `innerHTML`.** `parseHighlight()` separa o texto em pedaços
  marcados e não marcados, desfaz o escape e o React renderiza texto puro dentro de `<mark>`.
- **Datas da busca** são dias locais: `de` vira o início do dia e `ate` o início do dia seguinte
  (`to` é exclusivo no contrato); o período rápido vira só o `from`, na meia-noite local.
- **Ligar locutor a pessoa** usa `PersonCombobox`: combobox ARIA 1.2 com lista em popup (setas,
  Enter, Esc, `aria-activedescendant`), busca no diretório por prefixo e a opção "Cadastrar
  “nome”" quando ninguém tem aquele nome. Sem `onCancel`, o combobox fica em linha (filtros da
  biblioteca e da busca): sem foco automático, lista só com texto e sem cadastro. Cada sugestão por
  voz pendente aparece como "Parece ser <pessoa> — NN%", com Aceitar e Recusar; nunca é aplicada
  sozinha.
- **Pessoas** (`/pessoas`) é a `table.table` do DS com busca em `?q=`, o cadastro em linha na
  primeira linha (nome e empresa, com as empresas em uso num `datalist`; Enter envia, e o erro
  aparece na linha) e as colunas que o usuário escolhe no botão **Colunas** (popover com uma
  `.check` por coluna: empresa, área, cargo, tags, e-mail, telefone, gravações, amostras de voz e
  última gravação). O nome é fixo; o padrão esconde e-mail, telefone, cargo e última gravação, e a
  escolha fica em `eclume-pessoas-colunas` (`features/people/columns.ts`). A **pessoa**
  (`/pessoas/:id`) mostra cargo · área · empresa, as tags de pessoa e os contatos, tem Editar (o
  cadastro inteiro; empresa e área sugerem os valores de `GET /people/facets`) e Excluir em
  `Dialog`, três `.stat` (gravações, tempo de fala, amostras de voz) e as abas Gravações, Falas e Amostras de voz, com a escolhida em `?aba=`.
- **Voz** ([identificacao-por-voz.md](identificacao-por-voz.md)): a aba Amostras de voz lista as
  amostras e tem "Esquecer a voz", com confirmação; não há consentimento por pessoa, que o aceite
  do aviso no cadastro substitui. O admin liga a identificação e ajusta o limiar em Locutores
  (`/admin/locutores`).
- **Campos personalizados** (`/config/campos`) e **Tipos de agenda** (`/config/agendas`) usam o `.split`
  do DS: lista à esquerda (seleção em `?campo=`/`?tipo=`, `novo` para o rascunho) e painel à
  direita. Trocar de item com alterações pede "Descartar alterações?", e sair da rota também (o
  guarda de saída, com o aviso do navegador ao fechar a aba). Campos
  personalizados não lista o título embutido (o título vem do tipo de agenda) e mostra as tags
  como embutido (tipo fixo, sem excluir); o `.switch` "Automático" da lista grava na hora. Em Tipos
  de agenda, o tipo padrão (`fallback`) fica no topo com o `.badge` "Padrão", sem Excluir e sem
  "Como identificar"; todo tipo tem "Como escrever o assunto" (`title_instructions`), e a
  pré-visualização manda o `agenda_type_id` do tipo editado e diz quando ficaria o tipo padrão.
- **Pré-visualização por consulta ao job** (`organize/usePreview.ts`): "Testar numa gravação"
  (`POST /fields/preview`, sem `recording_ids`: as 3 últimas transcritas) e "Pré-visualizar numa
  gravação" (`POST /agenda-types/preview`) devolvem 202 com o job, e a tela consulta
  `GET /previews/{id}` no ritmo de `pollWhile` (2 s de início) até `done` ou `failed`; 404 vira expirada, e um pedido novo
  descarta o anterior. Nada é gravado, e a pré-visualização de tipo some quando o rascunho muda.
- **Coleção convive com tag**: a coleção agrupa gravações; a tag marca assuntos. Ela aparece no
  painel de campos da gravação, no filtro da biblioteca (`colecao`) e numa ficha da busca, e
  `/colecoes` fica em Organizar, como decidido na holetz/eclume#38.
- **Coleções automáticas** (`/colecoes`): o diálogo da coleção tem "Quando incluir" (a regra, com o
  `HelpHint` e um `<details>` "Exemplos de regras", cada um com "Usar", que copia para o campo) e o
  `.switch` "Incluir automaticamente depois da transcrição"; a linha mostra o `.badge`
  "Automática" quando há regra e o interruptor ligado. "Mesclar em…" (com duas coleções ou mais)
  abre um `Dialog` com o `<select>` da coleção que recebe e manda `POST /collections/{id}/merge`.
- **Vazios que ensinam o caminho real**, no tom do vazio de Tags: Coleções diz que as gravações
  entram pela página da gravação ou sozinhas pela regra em "Quando incluir"; Pessoas, que as pessoas
  nascem ao ligar um locutor na transcrição ou se cadastram na linha de cadastro; Campos
  personalizados dá um exemplo de campo com a regra ("Cliente", "A empresa cliente citada na
  reunião; vazio se nenhuma for citada").
- **Tags** (`/tags`, em Organizar depois de Coleções): o cartão de configuração grava na hora o
  `.switch` do automático, o modo (`.seg`: "Só as tags cadastradas" ou "O agente pode criar tags")
  e o limite de tags novas por gravação, e a regra geral com Salvar (`PATCH /me/tag-assignment`); a
  lista mostra a descrição, a contagem, "Ver gravações" (`/?tag=`) e o `.badge` "Criada pelo
  agente", com Nova tag, Editar (409 `tag_exists` sugere mesclar), "Mesclar em…" e Excluir em
  `Dialog`. "Campos personalizados" lista só os campos do usuário: o título vem dos tipos de agenda
  e as tags, desta tela.
- **Processamento automático** (`/config/automacao`, `automation/AutomationPage.tsx`, pasta própria para não criar ciclo entre `people` e `organize`, chave de ajuda
  `automacao`, primeiro item de Regras): a visão geral, na ordem do pipeline de
  [processamento-automatico.md](processamento-automatico.md), do que acontece sozinho depois de
  cada gravação, numa `<ol class="list">` de `.list-row`: pré-processamento e transcrição (da
  plataforma, sem link), locutores pela voz (`/me/voice-assignment`, "Voz: liga sozinho a partir
  de 75%"), marcação dos locutores (`/me/speaker-naming`, a única linha com a chave na própria
  tela: o `Switch` "Exigir a marcação dos locutores", e o estado "Não exigida", "Exigida" ou
  "Exigida · N gravações esperando você"), tipo de agenda (`/agenda-types`), campos personalizados (`/fields`, só os do usuário
  com `auto_fill`), tags (`/me/tag-assignment`, "Tags: só as cadastradas (N)"), coleções com
  regra (`/collections` com `auto_assign`) e resumo (tipos com `summary_instructions`). Cada etapa
  mostra o estado e um link "Configurar" (rotulado pela tela de destino); a página só lê, e as
  chaves continuam no `TagAssignmentCard`, no `AutoAssignCard` e na regra da coleção. A falha de
  uma consulta aparece só na etapa dela. Campos, Tags, Pessoas e Coleções apontam para ela no
  texto de abertura, e Campos personalizados e Tipos de agenda usam o kicker "Regras".

## Minhas configurações

- **Conta** (`/config/conta`, o primeiro item da engrenagem): o nome e o e-mail, o painel "Trocar a
  senha" (atual, nova e repetição; a repetição diferente e a senha curta não enviam, e a senha
  atual errada aparece no campo; a `.check` "Encerrar também aparelhos e tokens", marcada por
  padrão, manda `revoke_tokens`) e a zona de perigo "Excluir a conta", com o `.alert-error` do que
  é apagado e um `Dialog` que só habilita "Excluir minha conta" com a senha e a `.check` "Entendo
  que tudo será apagado para sempre". Excluída, o app limpa o cache e volta a `/entrar` com o aviso
  no `state`, que a tela de entrada mostra. Entre os dados e a senha, o painel **Privacidade e
  dados** lista, gerado de `GET /privacy` (`app/privacy.ts`, `usePrivacy`, sem `staleTime`
  infinito), onde ficam o áudio e a transcrição e o destino de cada finalidade ("Neste servidor",
  "Na rede local", "Fora do servidor: <quem>", "Desligado: nada é enviado"), e, de
  `/me/voice-assignment`, quantas pessoas têm impressão de voz e quantas amostras a conta guarda.
  Com a voz ligada na plataforma, a chave "Guardar amostras de voz desta conta"; desligar pede
  confirmação (`ConfirmDialog`, "Apagar e deixar de guardar") antes do `PATCH keep_samples: false`.
- **Ambiente** (`/config/ambiente`, `features/environment/`, chave de ajuda `ambiente`) guarda as
  preferências deste navegador no `localStorage` (`app/preferences.ts`), sem conta nem servidor:
  tema (`theme.ts`), densidade (confortável ou compacta), movimento (seguir o sistema ou reduzir),
  expediente (início e fim em horas cheias, padrão 8–18, com o fim sempre depois do início), a
  visão em que a biblioteca abre sem parâmetros (última usada, semana, mês ou lista) e a lista de
  atalhos de teclado, e o aviso do navegador (abaixo). "Restaurar os padrões" apaga tudo e volta o
  tema ao do sistema. Cada valor padrão apaga a própria chave em vez de gravá-la.
- **Observador de desfechos** (`app/processingWatch.ts`, holetz/eclume#118, ritmo em
  holetz/eclume#153): montado no `AppShell` (só com sessão), lê a cada 30 s (`WATCH_MS`)
  `GET /recordings?since=` (todas as páginas) — **só com a aba visível e numa aba por vez**: a aba
  visível pede o lock `eclume-processing-watch` (Web Locks, `WATCH_LOCK`) e o segura até ocultar ou
  fechar, quando ele passa para a próxima aba visível; sem `navigator.locks`, cada aba visível lê a
  sua. Ao reaparecer a aba lê na hora e a marca d'água recupera o que terminou enquanto ela esteve
  oculta (o aviso chega ao voltar, não durante). Aplica a
  regra do desfecho e a marca d'água do desktop
  ([desktop-deteccao-e-sync.md](desktop-deteccao-e-sync.md#aviso-do-fim-do-processamento)), com
  os mesmos casos de teste: resumo pronto, resumo que falhou, pronta sem resumo (motivo pelo
  `motivo()` do vocabulário), transcrição que falhou e, desde a 2.22.0, "Precisa de você" (etapa
  `speakers` em `waiting`, instante = `finished_at` da espera); cancelar e `summary_deleted` não avisam. A
  marca vive na memória da aba e começa na montagem: atualizar ou reabrir o navegador não dispara
  aviso antigo. Com a aba oculta, cada desfecho soma no título ("(2) Biblioteca · eclume",
  `setTitleCount`), zerado no `visibilitychange` de volta. Erro de rede ou sessão só espera a
  próxima volta.
- **Aviso do navegador, opcional**: a notificação do sistema (`new Notification(título, { body,
  tag: id })`; o `tag` impede que várias abas empilhem o mesmo aviso; o clique foca a aba e abre
  `/gravacoes/<id>`) sai só com a chave `eclume-aviso-navegador` ligada **e** a permissão dada
  (`notifyOutcomesOn()`). A permissão só é pedida num gesto — a chave "Avisar no navegador…" em
  Ambiente ou "Avisar quando ficar pronta" na linha enviada do Importar (`enableNotifyOutcomes()`),
  nunca ao carregar; negada, a chave fica desligada e a tela diz onde liberar; sem a API (http),
  a chave fica desabilitada e a oferta some. Sem Web Push nem service worker: com todas as abas
  fechadas, não há aviso (quem quer, usa o desktop).

- **Grupos de escopo** (`tokens/scopes.ts`) são a escolha principal de um token: Buscar e ler
  gravações (`recordings:read`, `transcripts:read`), Ler e editar resumos (`summaries:*`), Editar
  campos e tags (`recordings:write`) e Excluir gravações (`recordings:delete`). Os escopos soltos
  ficam em "Escopos individuais" (com a combinação do lumea). A tabela mostra o resumo curto
  (`ler, resumos, campos`, "+N" pelos soltos) e marca os tokens `kind: device` com "Aparelho ·
  <plataforma>". Validade: 30 dias, 90 dias ou nunca. O segredo aparece uma vez, no
  `CopyValue`.
- **Conexão MCP** (`/config/mcp`) copia o `mcp_url` do descritor (`GET /server`, `staleTime:
  Infinity`) e cria o token do assistente com o `TokenForm`: "Claude Desktop", os três primeiros
  grupos, sem "Excluir gravações" e 90 dias; criado, mostra o segredo e o comando
  `claude mcp add --transport http eclume <mcp_url> --header "Authorization: Bearer <segredo>"`.
- **Código de vínculo** (`connect/pairing.ts`): cada página gera o seu (App desktop por botão, App
  móvel ao abrir), porque um código novo anula o anterior. A contagem regressiva ancora em
  `expires_at` menos o header `Date` da resposta, medida por `performance.now()`, e não depende do
  relógio do computador. O estado é consultado no ritmo de `pollWhile` (3 s de início) enquanto `pending` e a contagem não
  zerou; `used` atualiza as listas de tokens e mostra "Pareado: <aparelho>". O leitor de tela só
  ouve "Falta 1 minuto" e "Código vencido".
- **QR gerado no navegador** (`connect/qr.ts`, `QrCode.tsx`): a matriz do pacote `qrcode`
  (correção M, carregado só com o QR) vira um `<svg>` próprio, com um `<path>` por linha, zona de
  silêncio de 4 módulos e preto sobre branco nos dois temas. O conteúdo é o `pair_url` do
  contrato. `/parear` é a página pública onde cai quem lê o QR com a câmera comum: explica que o
  código é do app e não chama a API.
- **Instaladores** (`web/src/features/desktop/installers.ts`): o App desktop lê `/downloads/instaladores.json`
  (mesma origem, fora do `/api`), valida `versao` e `instaladores[]`
  ([desktop-distribuicao.md](desktop-distribuicao.md)) e mostra o `recomendado` de cada sistema,
  com o sistema atual primeiro; sem manifesto ou com ele inválido, os cartões dizem que os
  instaladores ainda não foram publicados.
- **Aparelhos vinculados** (`connect/DevicesList.tsx`) vêm de `GET /tokens?kind=device`, filtrados
  pela plataforma da página; Desvincular revoga a credencial (`DELETE /tokens/{id}`).

## Upload: `src/upload/multipart.ts`

`runUpload(file, options)` segue o contrato:

1. `POST /uploads` com `sha256` (da conversão), `size_bytes`, `content_type`
   `audio/ogg; codecs=opus`, `source: upload` e, do import, `recorded_at` e
   `recorded_at_source` (sem `title`). Um 200 `deduplicated` encerra com a gravação
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
  rota, com a mesma árvore `routes` num `createMemoryRouter` (o `useBlocker` só funciona dentro de
  um data router). O motor de upload roda no ambiente `node` (o `Blob` do jsdom não serve de corpo para o
  `fetch` do Node).
- **Sem depender do tempo de carga nem do relógio real.** Cada página sob demanda de `routes.tsx`
  tem `preload()` no `handle` da rota, e `preloadRoute(...caminhos)` (`src/test/render.tsx`)
  carrega os chunks das rotas que o arquivo monta: todo arquivo de teste que monta rota lazy o
  chama no `beforeAll`, onde vale o `hookTimeout`, e não no tempo do primeiro `findBy`. Teste que
  depende de data fixa o relógio só onde importa (`vi.useFakeTimers({ toFake: ['Date',
  'performance'] })` com `vi.setSystemTime`, como a validade do App móvel), com os temporizadores
  reais para o React Query e o Testing Library. A suíte passa três vezes seguidas na estação e no
  host.
- **Fuso fixo**: os unitários rodam em `America/Sao_Paulo` (`process.env.TZ` no `vite.config.ts`)
  e o Playwright também (`timezoneId`), o fuso das fixtures; a biblioteca posiciona pela hora local.
- **E2E** (`npm run test:e2e`, Playwright): o `webServer` sobe o Vite dev com o proxy apontando
  para o mock. Os cenários percorrem a biblioteca na semana de 21/09/2026 (o primeiro exemplo de
  `GET /recordings`), no mês e na lista, com o filtro conferido na requisição (o mock não filtra);
  o modal Importar com o `audio.m4a` de `npm run fixtures` (data dos metadados, conversão real e
  upload); a gravação (pipeline, marcadores, transcrição, edição, chat, exportar e excluir); e a
  busca com a ficha de campo, a gravação no segundo do trecho, pessoas, coleções e PAT; e
  `e2e/organizar-config.spec.ts` percorre Campos, Tipos de agenda, Conexão MCP, Tokens, App
  desktop, App móvel, a central de ajuda e a gaveta (o mock só tem o exemplo "usado" do estado do
  código de vínculo e um `expires_at` fixo: o teste reescreve os dois quando precisa do código
  pendente). O painel admin tem o seu `e2e/admin.spec.ts`: entra por `/admin/entrar`, percorre
  as sete telas, salva em cada uma e confere os redirecionamentos. O Prism não emite cookies nem
  guarda estado, então o teste põe os cookies de sessão na resposta do login (o de admin com
  `Path=/api/v1/admin`), responde o `PATCH /admin/settings` com o exemplo do `GET` (o mock gera
  valores sem sentido, que estragariam o cache), pede o upload com `Prefer: code=201` e encaminha o `PUT` de parte (URL
  absoluta das fixtures em `127.0.0.1:4010`) com credencial e CORS, e responde a consulta da
  mensagem do chat com o id pedido. `ECLUME_MOCK_URL` aponta para outra porta quando a 4010 está
  ocupada (no host compartilhado, um mock próprio: `ECLUME_MOCK_PORT=4037 docker compose -p
  eclume-mock-<spec> -f deploy/docker-compose.mock.yml up -d`, com `E2E_PORT` próprio); `E2E_SCREENSHOTS=1` salva telas claro e escuro em
  `test-results/screens/`; `E2E_CHANNEL=chrome` usa o Google Chrome instalado
  (`msedge` na estação Windows, que não tem Chrome). O helper `navTo()`
  usa a barra lateral ou, para configurações e ajuda, os menus do cabeçalho. `e2e/visual.spec.ts`,
  `e2e/visual-organizar.spec.ts` e `e2e/admin-visual.spec.ts` são a verificação visual contra o DS
  ([web-design-system.md](web-design-system.md)); com `ECLUME_DS_DIR`, salvam também os quadros
  de `examples/*.html` para a comparação lado a lado.
- **Três motores.** O E2E roda tudo no Chromium e, no WebKit e no Firefox do Playwright, só o
  smoke (`@smoke` no título, com uma nova tentativa): cadastro, login, biblioteca, gravação com
  copiar o resumo e o player (o relatório anota o `canPlayType` de Ogg Opus de cada motor) e um
  import pequeno com um WAV gerado no teste, sem codec proprietário. Os testes de navegador
  (`npm run test:browser`: a conversão, a data dos metadados e a transcrição longa) rodam no
  Google Chrome, no Firefox e no WebKit; a conversão segue o caminho de cada motor (WebCodecs
  quando decodifica a faixa e codifica Opus, a reserva ffmpeg.wasm quando não), e o que depende só
  do WebCodecs é pulado com o motivo (o WebKit trava decodificando Vorbis).
- A CI roda os unitários, o build e o orçamento no job `web` e o E2E, junto dos testes de
  navegador, no job `web-browser`.
- **E2E contra o backend real** (`npm run test:e2e:real`, `playwright.real.config.ts`,
  `e2e-real/`): nada simulado — login com os cookies do servidor, import com conversão no
  navegador e upload pelas URLs de parte assinadas, transcrição pelo worker e o resumo automático
  do `claude -p`. Roda no host GPU por `bash deploy/e2e-real.sh` (da estação:
  `remote-run . 'bash deploy/e2e-real.sh'`), que sobe um stack efêmero próprio
  (`deploy/docker-compose.e2e.yml`, projeto `eclume-e2e`, Caddy em `127.0.0.1:18443`, dados em
  tmpfs, worker na engine CPU sem GPU), cria o admin descartável pelo `eclume-server admin create`
  e o usuário pelo cadastro (`POST /auth/signup`), roda o cenário e
  sai sempre com `down -v` e as imagens `:e2e` apagadas. Nunca toca a produção. Leva ~1 min além
  do build; fica fora da CI (exige o daemon, o Chrome e o login do Claude do host).
