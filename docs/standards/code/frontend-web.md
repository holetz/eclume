---
type: standard
title: Estrutura do app web
description: O app web do eclume (web/) fala com a API por um cliente gerado do contrato, na mesma origem e com sessão por cookie e CSRF double-submit; o painel de administração é um app à parte, com login, sessão e moldura próprios; organiza-se em shell com navegação agrupada e gaveta de ajuda, features (biblioteca no tempo com o modal Importar, gravação centrada no resumo, pessoas, busca, coleções, organizar, minhas configurações, central de ajuda, admin) e um motor de upload sem React; e é testado com vitest sobre as fixtures do contrato e com um E2E Playwright contra o mock Prism.
resource: web/src/**, web/e2e/**, web/playwright.config.ts, web/vite.config.ts, web/package.json
tags: [code, web, react, api, upload, testes]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#10, holetz/eclume#12, holetz/eclume#15, holetz/eclume#26, holetz/eclume#32, holetz/eclume#36, holetz/eclume#37, holetz/eclume#38, holetz/eclume#39
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
- A sessão do usuário é o cookie `eclume_session`, aberto por `POST /auth/login`. A do painel
  admin é outra, `eclume_admin_session` (só viaja para `/api/v1/admin`), aberta por
  `POST /admin/auth/login`. O `csrfMiddleware` copia para `X-CSRF-Token`, em todo método
  mutável, o cookie da área: `eclume_admin_csrf` quando a URL começa por `/api/v1/admin/`,
  `eclume_csrf` nos demais casos (`isAdminUrl`).
- Estado da sessão do usuário = `useMe()` (`GET /me`; 401 vira `null`). O `unauthorizedMiddleware`
  zera essa sessão no cache a cada 401 fora do login e **fora de `/api/v1/admin/`** (o 401 do
  painel é da sessão de admin), e a guarda `RequireSession` leva a `/entrar?volta=<rota>`; `volta`
  só aceita caminho interno.

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

- **Rotas em pt-BR** (`/entrar`, `/cadastro`, `/parear`, `/gravacoes/:id`, `/pessoas`,
  `/pessoas/:id`, `/busca`, `/colecoes`, `/config/campos`, `/config/agendas`, `/config/mcp`,
  `/tokens`, `/app-desktop`, `/app-movel`, `/ajuda`, `/ajuda/:slug`, `/admin/entrar`, `/admin/*`),
  nenhuma começando por `/mcp` (o endereço do servidor MCP); `/importar` redireciona para
  `/?importar=1` (o modal). Os parâmetros também são pt-BR:
  - biblioteca (`/`): `visao=semana|mes|lista`, `data=AAAA-MM-DD` (qualquer dia do período),
    `tipo=reuniao|nota`, `situacao=pronta|processando|falhou`, `tag`, `pessoa`, `colecao`,
    `campo=<field_id>:<valor>` (todos repetíveis) e `importar=1`;
  - gravação: `t=<ms>`;
  - busca: `q`, `pessoa`, `periodo=7d|30d|ano`, `de`, `ate`, `tag`, `colecao` e `campo`
    (repetível);
  - pessoa: `aba=gravacoes|falas|amostras`; Campos e regras: `campo`; Tipos de agenda: `tipo`.
  A biblioteca mostra só as gravações do usuário: não há filtro Minhas/Compartilhadas.
- **Rotas sob demanda.** `routes.tsx` carrega por `React.lazy` + `Suspense` toda área além da
  biblioteca e do login, cada uma no seu chunk; o bundle inicial caiu de ~477 KB para ~280 KB
  (89 KB gzip). O chunk do WebCodecs (Mediabunny, ~560 KB) só carrega na conversão do import, e
  o aviso de chunk grande do Vite que ainda aparece é dele.
- **Retentar a transcrição.** Numa gravação `failed`, o dono vê "Tentar de novo"
  (`RetryTranscription`, `POST .../retranscribe`), com a falha passageira (`error.retryable`) dita
  como tal; a Saúde do admin tem o mesmo botão por falha recente, pela retentativa do admin.
- **Navegação agrupada numa lista só** (`src/app/nav.ts`): cada item tem `group`, `section`
  (`main` ou `more`), `enabled` e, opcional, `matches` (prefixos que também acendem o item: a
  Biblioteca fica marcada em `/gravacoes/`), e `navGroups()` devolve as duas seções. A principal
  tem Gravações (Biblioteca, Busca; importar é o modal da biblioteca), Organizar (Pessoas,
  Coleções, Campos e regras, Tipos de agenda); a recolhível **Configurações e ajuda** (um
  `<details class="nav-more">`) tem Minhas configurações (Conexão MCP, Tokens de acesso, App
  desktop, App móvel) e Ajuda (Central de ajuda). Ela abre sozinha quando a rota atual é dela e,
  fora isso, guarda a escolha enquanto a página vive. Uma área nova entra desligada, com a rota do
  mapa de telas v6, e ligá-la é mudar `enabled` e registrar a rota. Há um só `<nav aria-label="Principal">`;
  cada grupo é um `role="group"` rotulado pelo título. Não há item "Painel admin": a conta de
  usuário não tem papel, e o painel se abre pelo endereço `/admin/entrar`, com conta própria.
- **Cabeçalho de página** é o `PageHead` (`.page-head` do DS: kicker opcional, `h1`, ações e, no
  shell, o botão Ajuda); ele também dá o título da aba. Rota desconhecida mostra
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
    fixa e menu compacto abaixo de 56rem): marca, selo "Admin", o grupo "Plataforma" e, no
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
  - **A Saúde relê a cada 15 s** (`HEALTH_REFRESH_MS`, alinhado ao heartbeat do worker), só com a
    aba visível (`refetchIntervalInBackground: false`), e mantém os últimos dados num erro.
  - **Nenhuma tela do painel mostra conteúdo de usuário**: nem título de gravação, nem nome de
    arquivo, nem link para `/gravacoes`. Usuários mostra nome, e-mail, cadastro, contagem de
    gravações e estado; as falhas da Saúde mostram etapa e código.

  As regras do server estão em [server-admin.md](server-admin.md).
- **Rotas públicas:** `/entrar`, `/cadastro`, `/parear` e `/admin/entrar`. Criar conta (`SignupPage`) lê
  de `GET /auth/signup` se o cadastro está aberto e o aviso em vigor, pede nome, e-mail, senha de
  12+ (`MIN_PASSWORD`, o `minLength` do contrato) e o aceite obrigatório do aviso, e envia a
  `notice_version` aceita; a resposta abre a sessão, como o login. `email_taken` vira "Já existe
  uma conta com este e-mail."; cadastro fechado (`open: false` ou `signup_closed`) mostra o aviso
  no lugar do formulário.
- **Aceite do aviso em vigor:** com `notice_required: true` em `/me`, o `RequireSession` mostra o
  `NoticePage` (na `.auth`) no lugar do shell, até `POST /me/notice` com a versão lida de
  `GET /auth/signup`.
- **Estado de servidor com TanStack Query.** O polling é declarativo (`refetchInterval` de 3 s
  só enquanto há job ou resumo `queued`/`running`). Mutações gravam no cache o que a resposta
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
  escolha explícita fica no `localStorage`). Cor nova entra como token no DS.
- As telas de acesso usam o `AuthLayout` (`.auth` do DS: campo da marca e formulário alinhado à
  esquerda); o resto fica no `AppShell` (`.shell`, `.sidebar`, `.main`), com a barra superior e o
  menu compacto abaixo de 56rem.
- CSS Modules por componente, só com o que o DS não tem. Sem framework de CSS e sem fonte
  externa.
- Toda ação alcançável por teclado, foco visível, skip link, rótulos em todos os campos,
  `aria-live` em progresso e confirmações. Estado nunca só por cor: o selo tem texto.
- Enum desconhecido na resposta aparece cru, sem quebrar a tela (o contrato só cresce).

## Biblioteca no tempo

A tela inicial (`/`, `src/features/library/`) é um calendário (frame "Library · week", variante A):

- **Três visões no `.seg`**: Semana (`.cal-week`, padrão), Mês (`.cal-month`, até três `.cal-dot`
  por dia e "+N"; o número do dia abre a semana dele) e Lista (`.day-group` com `.rec-row`, da mais
  recente, "Carregar mais"). Abaixo de 56rem, sem `visao` na URL, abre na Lista, e a semana rola
  de lado dentro do próprio contêiner (`min-width: 720px`).
- **Posição por hora e duração** (`calendar.ts`, datas locais do navegador): a semana vai de
  segunda 00:00 à segunda seguinte; cada gravação ganha `--s` (hora de início local) e `--d`
  (duração em horas, 0,1 para nota ou duração nula, cortada na meia-noite). A faixa de horas é
  8–18, estendida para caber tudo, com `--cal-hour: 54px`. Gravações sobrepostas no mesmo dia
  dividem a coluna em faixas (`lanes()`, guloso por início), que o DS não trata.
- **Estado em palavra** (`recordingState()`, de `status` e do `pipeline`): falhou (régua de
  perigo), em andamento com a etapa corrente ("Resumindo", "Transcrevendo", "Na fila"...) ou pronta
  (com "Sem resumo" quando a etapa do resumo falhou). Nota por voz tem a régua pontilhada;
  marcadores aparecem como `.marker-count`. O `aria-label` do evento diz tudo:
  "Reunião de equipe, 09:00, 58 min, Resumindo, 3 marcadores".
- **Consulta** (`queries.ts`): o período vai em `GET /recordings` com `from`, `to`,
  `sort=recorded_asc` e `limit=200`, seguindo o cursor até 5 páginas ("Mostrando as primeiras 1000
  gravações deste período"); a Lista usa `sort=recorded_desc` e `limit=50`. As duas releem a cada
  3 s enquanto alguma gravação está em andamento.
- **Painel de filtros** à direita (`.with-filters` e `.filters`, recolhível até 48px): Tipo,
  Situação, Tags, Pessoas (o `PersonCombobox` em linha), Coleções (com "Gerenciar coleções") e um
  grupo por campo próprio do usuário (escolha como `.check`, texto e lista como "Qualquer valor",
  aplicado no Enter ou ao sair). Os filtros vão na URL (ver as rotas) e viram os filtros
  repetíveis de `GET /recordings`; `STATUS_GROUPS` mapeia a Situação ao enum de `status` (Pronta =
  `transcribed`, Processando = `uploading`/`queued`/`processing`, Falhou = `failed`). Um grupo com
  tudo marcado não manda o parâmetro, e o último marcado não sai. Abaixo de 56rem, o painel é um
  `Dialog` aberto por "Filtros (N)".
- **Persistência** (`src/app/storage.ts`, `localStorage` com `try/catch`): o painel lembra se está
  recolhido (`eclume-biblioteca-filtros-recolhidos`) e a biblioteca, a última query string sem o
  `importar` (`eclume-biblioteca-ultima`), que volta por `replace` quando `/` abre sem parâmetros.
  "Limpar filtros" tira tudo menos `visao` e `data`.
- **Estados**: carregando (grade com `aria-busy` e "Carregando gravações…"), erro com "Tentar de
  novo", "Nada gravado neste período." e, numa conta sem nenhuma gravação (`GET /recordings` com
  `limit=1`), o cartão "Nenhuma gravação ainda". A faixa `alert-info` "Enviando 1 de 3 arquivos ·
  Abrir" acompanha a fila de importação.

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
- **A fila vive no shell** (`ImportProvider` no `AppShell`, `useImportQueue`, `importContext.ts`):
  fechar o modal ou navegar não perde o envio. Os arquivos são convertidos e enviados **um por
  vez**; cancelar aborta e apaga o upload; "Tentar de novo" retoma pelo `uploadId` ou reconverte.
  A fila guarda os itens num ref, a fonte da verdade do laço de envio, e o estado só espelha o ref
  (o laço não espera o React renderizar). Enquanto há conversão ou envio, o `beforeunload` avisa.
  Terminado um envio, a biblioteca é relida (`['recordings']`).

## Página da gravação

`/gravacoes/:id` é centrada no resumo (frames "Recording", "transcript with markers" e "editing the
summary", variantes A), em largura total com o chat numa coluna de 340px (abaixo de 72rem o chat
desce; abaixo de 56rem, os campos também):

- **Cabeçalho** (`RecordingHeader`): "← Biblioteca" volta à URL de onde a pessoa veio
  (`location.state.from`, posto pelos links do calendário, da lista e da busca); o kicker diz
  data, hora e duração ("· data do envio" quando `recorded_at_source` é `upload`); **Exportar** é
  um `MenuButton` (TXT, SRT, MD — desabilitado sem resumo — e DOCX) que baixa por `fetch` e mostra o
  `Problem` num alerta; **Excluir** pede confirmação, tira a gravação do cache, relê a biblioteca e
  volta com "Gravação excluída.".
- **Pipeline** (`Pipeline.tsx`, rótulos em `steps.ts`): as seis etapas no `ol.pipeline`, o motivo
  de uma etapa pulada ou que falhou em texto acessível e em `title`, o progresso do worker com a
  transcrição em andamento e o `RetryTranscription` numa falha. A gravação relê a cada 3 s enquanto
  está em andamento, e uma etapa de campos, tipo ou resumo que termina relê campos e resumo.
- **Reprodução compartilhada** (`PlaybackProvider`, `playback.ts`): um único `<audio>` liga o
  player compacto (tocar, trilha com `range` para teclado, um `.player-tick` por marcador, a
  velocidade 1×–2×), a `.marker-bar` (ficha por marcador, que toca dali, e "Marcado no
  <dispositivo>" quando é um só) e as falas.
- **Transcrição recolhida** (`TranscriptDisclosure`, `details.disclosure` fechado): o resumo diz
  locutores, falas e marcadores; aberta, tem o bloco Locutores (renomear, ligar pessoa, sugestões,
  juntar), "Acompanhar o áudio" e as falas no `.segment` do DS, com a `.segment-marker` antes da
  primeira fala que começa no marcador (`placeMarkers`), editar a nota (até 500) e excluir o
  marcador. As falas só renderizam com ela aberta. Com `?t=<ms>`, abre sozinha, posiciona o áudio
  sem tocar e rola até a fala.
- **Documento do resumo** (`SummaryDoc`, `summary.ts`): o `SummaryState` (atual, gerada de
  referência e geração em andamento, relido a cada 3 s com pendência) com a `.doc-bar` (tipo,
  origem e versão; Copiar com título, Editar, Comparar com a gerada, Trocar tipo e Excluir resumo)
  e o Markdown pelo `react-markdown`, sem HTML cru. Sem tipo de agenda, gerar pede um ("Escolha um
  tipo de agenda para gerar o resumo.").
- **Edição** (`SummaryEditor`): o Markdown num `textarea` na tipografia do `.doc`, salvo com
  `base_version` = a versão aberta. O 409 `summary_changed` guarda o rascunho e oferece "Ver a
  versão N" (a comparação do rascunho com a nova) e "Salvar sobre a versão N". "Voltar à gerada"
  pede confirmação. **Comparar** é um diff por linha no cliente (`summary-diff.ts`, LCS), com
  `<del>`/`<ins>` e o sinal −/+ para quem não enxerga cor.
- **Campos** (`FieldsPanel`, `fields.ts`, componente "Filled fields" variante A): título e tags
  primeiro, depois os campos do usuário, com o selo de origem (Automático tracejado, Editado
  sólido, aceito sem selo), Aceitar, Aceitar tudo e Editar pelo tipo (texto até 300, lista por
  vírgula, escolha com "Nenhum"); o tipo de agenda com Trocar; as coleções (com "Nova coleção…");
  os locutores com "Corrigir locutores", que abre a transcrição e foca o bloco; e, quando há, os
  "Dados anteriores" do `metadata` antigo, só leitura.
- **Chat "Ajustar o resumo"** (`ChatPanel`, `chat.ts`): o histórico no `role=log`, com uma
  `.msg-note` por leitura do agente ("Leu a transcrição, 00:03:20–00:04:20", "Buscou “orçamento”
  na transcrição · 3 trechos"); enviar recebe o 202 com as duas mensagens, e a resposta é
  consultada a cada 2 s até `done` ou `failed`. O composer espera com um pedido em aberto (e no
  409 `chat_busy`) e sem resumo atual.

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
  primeira linha (nome e e-mail, Enter envia, e-mail repetido aparece na linha) e as colunas nome,
  e-mail, gravações e amostras de voz. A **pessoa** (`/pessoas/:id`) tem Editar e Excluir em
  `Dialog`, três `.stat` (gravações, tempo de fala, amostras de voz) e as abas Gravações, Falas e Amostras de voz, com a escolhida em `?aba=`.
- **Voz** ([identificacao-por-voz.md](identificacao-por-voz.md)): a aba Amostras de voz lista as
  amostras e tem "Esquecer a voz", com confirmação; não há consentimento por pessoa, que o aceite
  do aviso no cadastro substitui. O admin liga a identificação e ajusta o limiar em Locutores
  (`/admin/locutores`).
- **Campos e regras** (`/config/campos`) e **Tipos de agenda** (`/config/agendas`) usam o `.split`
  do DS: lista à esquerda (seleção em `?campo=`/`?tipo=`, `novo` para o rascunho) e painel à
  direita. Trocar de item com alterações pede "Descartar alterações?"; sair da rota só avisa pelo
  `beforeunload`, porque o app usa `BrowserRouter` e o `useBlocker` exige data router. Título e
  tags são embutidos (tipo fixo, sem excluir); o `.switch` "Automático" da lista grava na hora.
- **Pré-visualização por consulta ao job** (`organize/usePreview.ts`): "Testar numa gravação"
  (`POST /fields/preview`, sem `recording_ids`: as 3 últimas transcritas) e "Pré-visualizar numa
  gravação" (`POST /agenda-types/preview`) devolvem 202 com o job, e a tela consulta
  `GET /previews/{id}` a cada 1,5 s até `done` ou `failed`; 404 vira expirada, e um pedido novo
  descarta o anterior. Nada é gravado, e a pré-visualização de tipo some quando o rascunho muda.
- **Coleção convive com tag**: a coleção agrupa gravações; a tag marca assuntos. Ela aparece no
  painel de campos da gravação, no filtro da biblioteca (`colecao`) e numa ficha da busca, e
  `/colecoes` fica em Organizar, como decidido na holetz/eclume#38.

## Minhas configurações

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
  relógio do computador. O estado é consultado a cada 3 s enquanto `pending` e a contagem não
  zerou; `used` atualiza as listas de tokens e mostra "Pareado: <aparelho>". O leitor de tela só
  ouve "Falta 1 minuto" e "Código vencido".
- **QR gerado no navegador** (`connect/qr.ts`, `QrCode.tsx`): a matriz do pacote `qrcode`
  (correção M, carregado só com o QR) vira um `<svg>` próprio, com um `<path>` por linha, zona de
  silêncio de 4 módulos e preto sobre branco nos dois temas. O conteúdo é o `pair_url` do
  contrato. `/parear` é a página pública onde cai quem lê o QR com a câmera comum: explica que o
  código é do app e não chama a API.
- **Instaladores** (`desktop/installers.ts`): o App desktop lê `/downloads/instaladores.json`
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
  rota. O motor de upload roda no ambiente `node` (o `Blob` do jsdom não serve de corpo para o
  `fetch` do Node).
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
  abre "Configurações e ajuda" quando o link está recolhido. `e2e/visual.spec.ts`,
  `e2e/visual-organizar.spec.ts` e `e2e/admin-visual.spec.ts` são a verificação visual contra o DS
  ([web-design-system.md](web-design-system.md)); com `ECLUME_DS_DIR`, salvam também os quadros
  de `examples/*.html` para a comparação lado a lado.
- A CI roda os unitários no job `web` e o E2E, junto dos testes de navegador da conversão, no
  job `web-browser`.
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
