---
type: standard
title: Marca do eclume
description: A identidade visual do eclume — linho e nogueira do ecossistema Jane, Archivo com IBM Plex Mono, raio zero, fios de 2px e terracota só para gravação e falha — com os papéis dos tokens, o vocabulário de componentes e os compromissos projetados no DESIGN.md.
resource: .design/**
tags: [design, brand, tokens]
timestamp: 2026-10-01
audience: both
authority: current
source: design-system/styles.css (gerado nas cópias pelo design-system/sincronizar.py), docs/standards/code/web-design-system.md e holetz/eclume#130
maintainer: holetz
---

# Marca do eclume

Os títulos de seção ficam em inglês porque o `cq design build` os projeta pelo nome nas seções do
`DESIGN.md`; o texto é pt-BR. Os valores exatos vivem só em `/.design/tokens.json`, que espelha o
`design-system/styles.css`, a fonte versionada do Design System; o web, o desktop e o celular
consomem as cópias geradas dela ([web-design-system.md](../code/web-design-system.md)).

## Overview

**Norte: "o arquivo de trabalho de uma instituição".** O eclume é uma ferramenta que se usa por
horas para ler, revisar e reencontrar reuniões. A interface parece papel de linho bem organizado:
tinta escura, fios retos de 2px separando a estrutura, nenhuma curva, e a cor gasta só no que
significa algo.

- **Sóbrio:** a hierarquia vem do peso do Archivo 800 e do espaço, não de ornamento.
- **Estrutural:** fios de 2px desenham a moldura (cabeçalho de página, barra lateral, divisores);
  sombras só separam camadas que flutuam.
- **Honesto no estado:** a terracota aparece quando algo grava ou falha, e em nenhum outro lugar.

## Colors

O fundo de linho (`background`) e a superfície um tom abaixo (`surface`) carregam a leitura; a
tinta (`on-surface`) é quase preta e quente, e o texto secundário (`text-muted`) é o linho 700.

- **Nogueira (`primary`)** é o único acento de ação: botão primário, link, foco e item de
  navegação ativo. `accent-ink` é a nogueira escura para kickers.
- **Terracota (`recording`)** é semântica, não decorativa: gravação em curso e falha. Nunca vira
  um segundo acento de variedade.
- `success`, `warning` e `danger` são estados; `highlight` é o realce de busca e seleção.
- Os locutores têm seis cores próprias em OKLCH (`--speaker-1` a `--speaker-6` no CSS), de mesma
  luminosidade, que não competem com a nogueira.
- **Tema escuro** (`data-theme="dark"`): os tokens `dark-*` trocam fundo, superfície, tinta,
  nogueira clara e terracota clara. O `DESIGN.md` não tem modos; o CSS é quem aplica a troca.

**Regra do acento único.** Um bloco tem no máximo um acento; a terracota só entra quando o estado
de gravação ou falha estiver presente.

## Typography

Archivo é a voz única: 800 com tracking levemente negativo nos títulos (h1 42px, h2 32px, h3
25px), 400 a 15px com entrelinha 1,55 no texto corrido e nas transcrições, 800 a 14px nos botões.
Kickers e badges usam 11px, peso 600, caixa alta e tracking largo. IBM Plex Mono 500 com números
tabulares marca tempos, durações e contadores. As fontes vêm do build (`@fontsource`), sem CDN.

## Layout

Grade de espaçamento em 4px (4, 8, 12, 16, 24, 32). O shell tem barra lateral de 240px e o conteúdo
usa a largura toda ao lado dela (o `--content-width` de 1040px do DS não vale no web); texto corrido
fica em 68ch; a página abre com `.page-head`, título e ações sobre um fio de 2px. A densidade é
de ferramenta: listas e tabelas compactas, com o respiro reservado para a leitura da transcrição.

## Elevation & Depth

A estrutura é plana e desenhada por fios. Sombras (`sm`, `md`, `lg`) só para o que flutua: menus,
popovers, diálogos e a gaveta de ajuda. No escuro, a sombra vira um contorno de 1px mais a queda.

## Shapes

Raio zero em tudo: botões, campos, cartões, tags, badges e diálogos. O badge marca o estado com um
quadrado de 6px, não com um ponto. Ícones Lucide com ponta e junção retas
(`stroke-linecap: square`).

## Components

O vocabulário vem do `design-system/styles.css`: `.btn` com `btn-primary` e `btn-secondary` (o `.btn` puro é
transparente), `.input` em campos, `select` e `textarea`, `.card`, `.badge` e `.tag`, `.nav` e
`.sidebar`, `.page-head`, `.kicker`, `.hr`. O web acrescenta só o que o DS não tem, em `app.css`.

A marca de verdade é a do web (`web/src/app/Brand.tsx` e `web/public/favicon.svg`). O lockup em
`/.design/assets/lockup.svg` é o genérico do pacote e fica só até a marca do eclume ser exportada
para lá.

## Do's and Don'ts

### Do

- **Do** montar telas com as classes do `design-system/` e ajustar produto em `app.css` ou no CSS
  Module da tela.
- **Do** usar fios de 2px para estrutura e manter o raio zero.
- **Do** reservar a terracota para gravação e falha.

### Don't

- **Don't** editar `web/src/styles/eclume.css`: ele é cópia fiel e só muda pelo sync.
- **Don't** arredondar cantos, usar pílulas ou introduzir um segundo acento de cor.
- **Don't** carregar fontes ou ícones de CDN: o servidor é auto-hospedado.
