---
type: standard
title: Central de ajuda do web
description: A ajuda do web do eclume mora no próprio build — artigos Markdown com cabeçalho em web/src/features/help/articles, seis tópicos, chaves de página que ligam cada tela aos artigos dela, busca local sem acento, gaveta por página e dicas em linha — escrita em pt-BR para o produto por usuário, com termos do produto antigo recusados por teste e a regra de revisar os artigos de uma tela quando ela muda.
resource: web/src/features/help/**, web/src/app/help.ts, web/src/app/HelpDrawer.tsx, web/src/app/HelpHint.tsx
tags: [code, web, ajuda, documentacao, acessibilidade]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#38
maintainer: holetz
---

# Central de ajuda do web

A ajuda do usuário é parte do build do web: sem servidor, sem CDN e sem banco. O conteúdo são
arquivos Markdown versionados junto das telas que eles explicam, e cada tela declara quais
artigos são dela. A estrutura do app está em [frontend-web.md](frontend-web.md); o visual
(`.help-drawer`, `.topic-grid`, `.hint`, `.popover`) vem do DS ([web-design-system.md](web-design-system.md)).

## Onde os artigos vivem

- Um arquivo por artigo em `web/src/features/help/articles/<slug>.md`; o slug é o nome do
  arquivo e o endereço é `/ajuda/<slug>`.
- As perguntas frequentes ficam em `web/src/features/help/perguntas.md`, uma por `##`.
- `catalog.ts` lê tudo por `import.meta.glob('./articles/*.md', { query: '?raw', eager: true })`.
  Só a central (`/ajuda`, `/ajuda/:slug`) e o corpo da gaveta importam o catálogo, e os dois são
  chunks sob demanda: os artigos não entram no bundle inicial.

## O cabeçalho

```md
---
titulo: Como funcionam as sugestões por voz
topico: transcricao
paginas: [pessoas, pessoa, gravacao]
relacionados: [ligar-locutor-a-pessoa, esquecer-a-voz]
termos: [impressão de voz, biometria, LGPD, limiar]
ordem: 2
atualizado: 2026-09-27
---
```

- `frontmatter.ts` lê só `chave: valor` e `chave: [a, b]`, sem dependência, e lança com o nome do
  arquivo quando o cabeçalho está inválido.
- `topico` é um dos seis: `comecar` (Primeiros passos), `processamento` (Processamento e falhas),
  `transcricao` (Transcrição e locutores), `resumos` (Resumos e chat), `organizar` (Campos, regras
  e tipos de agenda) e `conectar` (Assistentes, tokens e aparelhos). `ordem` ordena dentro do
  tópico.
- `paginas` são **chaves de página** (`pages.ts`): `biblioteca`, `gravacao`, `busca`, `pessoas`,
  `pessoa`, `colecoes`, `campos`, `agendas`, `mcp`, `tokens`, `app-desktop`, `app-movel` e
  `ajuda`. Chave nova entra em `HELP_PAGES`, com o rótulo do "Nesta página · <rótulo>".
- `termos` são sinônimos que a busca pesa, mas que o texto não precisa repetir.
- O corpo usa `##` para as seções (viram o índice "Nesta página" do artigo), links internos
  começando por `/` e um `> **Título**` no começo de uma citação para virar `.alert alert-info`.
  HTML cru não é renderizado.

## Busca, gaveta e dica

- **Busca local** (`search.ts`): NFD, sem acento, minúsculas e sem pontuação; termos de 2+
  caracteres, todos precisam casar por prefixo de palavra. Peso por termo: título 5, `termos` 4,
  títulos `##` 3, corpo 1; empate pela ordem do tópico. O trecho devolvido tem até 160
  caracteres em volta da primeira ocorrência e a tela marca o termo com `<mark>`.
- **Gaveta por página**: cada tela chama `useHelpTopic(<chave>)`; o `?` (ou o botão Ajuda do
  `PageHead`) abre a gaveta, cujo corpo carrega sob demanda com a busca (até 6 resultados), os
  artigos da chave ("Nesta página · <rótulo>") e os atalhos. Clicar num link navega e mantém a
  gaveta aberta.
- **Dica em linha** (`HelpHint`): o `.hint` "?" com `aria-label="Sobre <assunto>"` que abre um
  `.popover` com o texto curto e "Ler o artigo →". Entra onde a regra não é óbvia na tela (por
  exemplo "Como identificar" em Campos personalizados e "Excluir gravações" em Conexão MCP), nunca como
  enfeite.

## Redação

- pt-BR, segunda pessoa ("você"), frases curtas e o nome dos botões como a tela os mostra.
- O produto é **por usuário**: cada conta vê só o que é dela, sem compartilhamento entre contas; o
  aceite do aviso no cadastro deixa com a pessoa o dever de pedir o consentimento de quem grava;
  não há transcrição ao vivo; quem administra o servidor cuida da configuração e da saúde, sem ver
  conteúdo.
- Termos do produto antigo são recusados pelo `catalog.test.ts`: organização, tenant, convite,
  termo de consentimento, consentimento de voz, "ao vivo", "compartilhado com" e template. O mesmo
  teste exige cabeçalho válido, links internos para rotas que existem, `relacionados` que existem,
  três ou mais artigos por tópico e pelo menos um artigo por chave de página.

## Revisão por tela

Quem muda uma tela revisa, no mesmo PR, os artigos cujo `paginas` tem a chave dela (`grep -l
'<chave>' web/src/features/help/articles/*.md`) e atualiza o `atualizado` dos que mudaram. Tela
nova ganha chave, `useHelpTopic` e ao menos um artigo.
