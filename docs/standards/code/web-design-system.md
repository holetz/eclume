---
type: standard
title: Design System do eclume no web
description: O web do eclume usa o Design System do eclume (o repositório eclume-design) como base visual única — eclume.css copiado fiel do styles.css, app.css só com o que o DS não tem, fontes Archivo e IBM Plex Mono servidas pelo build, ícones Lucide com ponta quadrada e tema escuro por data-theme — e este é o jeito de sincronizar, o mapa dos tokens antigos e as classes de produto.
resource: web/src/styles/**, web/src/main.tsx, web/src/app/theme.ts, web/src/app/Brand.tsx, web/public/favicon.svg, web/index.html, web/src/**/*.module.css
tags: [code, web, design-system, css, tema, acessibilidade]
timestamp: 2026-09-27
audience: both
authority: current
source: holetz/eclume#36
maintainer: holetz
---

# Design System do eclume no web

O **Design System do eclume** é o repositório `eclume-design` (espelho local em
`C:\Projetos\eclume-design`): `styles.css` com tokens e classes, `foundations/`, `components/`,
`examples/` (as telas do mapa v6) e `templates/`. Ele é escrito em inglês; o produto fica em
pt-BR, com as rotas de [frontend-web.md](frontend-web.md). O web não inventa visual: toma cor,
fonte, espaçamento, raio e sombra dos tokens do DS e monta as telas com as classes dele.

## Camadas de CSS

`web/src/styles/global.css` é só o ponto de entrada, importado pelo `main.tsx` **antes** do
`App`. O `eclume.css` entra na cascade layer `ds` (`@import './eclume.css' layer(ds)`), e o resto
(`app.css` e os CSS Modules) fica sem camada, então vence o DS com qualquer especificidade e em
qualquer ordem de chunk. A ordem do bundle não basta: o Vite põe o CSS de um chunk compartilhado
(o do `RequireSession`, com a moldura do shell) **antes** do CSS da entrada, e o menu compacto do
shell deixava de valer no build de produção:

| Arquivo | O que tem | Quem edita |
|---|---|---|
| `fonts.css` | `@fontsource/archivo` 400, 500, 600, 700 e 800 e `@fontsource/ibm-plex-mono` 400 e 500 | quem muda os pesos usados |
| `eclume.css` | cópia fiel do `styles.css` do DS, menos o `@import` do Google Fonts | ninguém: só o sync |
| `app.css` | a camada de produto, só o que o DS não define | as specs do web |

- **`eclume.css` não se edita.** Ajuste de produto vai em `app.css` ou no CSS Module da tela. O
  cabeçalho registra a origem e a data do sync. A camada mobile do DS (`.phone`, `.m-*`) vem junto,
  inerte: a cópia fiel vale mais que a poda.
- **Sincronizar com o `eclume-design`** é copiar o `styles.css` de novo e tirar a mesma linha:

  ```bash
  { printf '/* Cópia fiel de eclume-design/styles.css (sync <data UTC>), sem o @import do Google Fonts:\n   as fontes vêm de fonts.css. Não edite: ajuste de produto vai em app.css. */\n'; \
    sed '/fonts.googleapis.com/d' <eclume-design>/styles.css; } > web/src/styles/eclume.css
  ```

  Depois, `npm --prefix web run build` e os screenshots da verificação visual (abaixo) mostram o
  que mudou. Classe nova do DS fica disponível sem mais nada; classe renomeada quebra a tela que a
  usava, e o E2E pega.
- **Sem CDN.** O servidor é auto-hospedado: o Vite copia os `.woff2` do `@fontsource` para
  `dist/assets` com hash e o Caddy os serve da mesma origem. O `@fontsource` declara as famílias
  `"Archivo"` e `"IBM Plex Mono"`, os mesmos nomes de `--font-heading`, `--font-body` e
  `--font-mono`; por isso o pacote variável (`"Archivo Variable"`) não serve. O peso 600 entra
  porque o DS o usa em `.kicker`, `.badge`, `.nav-group-title` e outras 11 regras.

## Classes de produto (`app.css`)

- `:root{color-scheme:light}` (o escuro do DS já declara o seu).
- `.main{max-width:none}`: o conteúdo usa a largura toda ao lado da barra, sem o
  `--content-width` do DS; texto corrido mantém a própria medida (`68ch`). Telas `.bleed` tiram
  também o respiro do `.main`.
- `.field` em grid, `.field-hint` (texto de ajuda do campo, 12px, `--color-text-muted`, com 4px
  acima dentro de `.field`) e `.field-label` (o rótulo de 12px do DS para `<legend>` e rótulos
  que não são `<label>` filho de `.field`). No DS, `.hint` é o botão `?` de 18px.
- `.input[aria-invalid='true']` com a borda em `--color-danger`.
- `.visually-hidden` e `.skip-link`, nos tokens do DS.
- `svg.lucide{stroke-linecap:square;stroke-linejoin:miter}`.
- `.page-head-actions` (as ações do `.page-head`), `.help-section` (kicker sobre a lista na gaveta
  de ajuda) e o ajuste das linhas da `.help-drawer` sem a `.help-search`.
- `.auth-tagline` e `.auth-note` (linha do campo da marca e rodapé do formulário de acesso) e a
  `.auth` em uma coluna abaixo de 56rem.
- O `prefers-reduced-motion` global.

## Classes antigas e tokens antigos

As classes globais do web antes do DS foram trocadas assim, e não voltam:

| Antes | Agora |
|---|---|
| `btn` sem variante | `btn btn-secondary` (no DS, `.btn` puro é transparente e sem borda) |
| `muted` | `text-muted` |
| `hint` | `field-hint` |
| `select`, `textarea` | `input` no próprio `<select>`/`<textarea>` |
| `label` (em `<legend>`) | `field-label` |
| `badge-neutral` | `badge` (o neutro do DS é o padrão) |

Os tokens de `tokens.css`, que deixou de existir, seguem este mapa ao escrever CSS novo:

| Antigo | No DS |
|---|---|
| `--font-sans` | `--font-body` |
| `--text-xs/-sm/-md/-lg/-xl` | `12px`/`14px`/`15px`/`20px`/`42px`: o DS usa escala fixa em px |
| `--leading` | nada (o `body` tem `1.55`) |
| `--space-5`/`-6`/`-7` | `--space-6`/`--space-8`/`calc(var(--space-8) * 1.5)` |
| `--radius-*`, `--radius` | nada: canto zero; só o ponto de gravação é redondo |
| `--color-surface-2` | `color-mix(in srgb, var(--color-text) 7%, transparent)` |
| `--color-border`, `--color-border-strong` | `--color-divider` |
| `--color-accent-hover`, `--color-accent-contrast` | `--color-accent-600`, `--color-bg` |
| `--color-accent-soft`, `--color-{danger,success,warning}-soft` | `color-mix(in srgb, var(--color-…) 10%, transparent)` |
| `--color-accent` como texto pequeno | `--color-accent-ink` |
| `--color-danger-hover`, `--color-focus`, `--shadow` | `--color-danger`, `--color-accent`, `--shadow-sm` |

`--color-surface` mantém o nome, mas é o linho mais escuro, sem borda. Nas telas ainda não
redesenhadas, a base do DS (`h1` a `h3` de 42/32/25px, `p` com margem) é contida no CSS Module da
página com especificidade de elemento — `:where(.page) h2{font-size:20px;margin:0}`,
`:where(.page) h3{font-size:17px}` e `:where(.page) p{margin:0}` — para as classes do módulo
continuarem vencendo.

## Tema

O DS só tem o escuro sob `:root[data-theme='dark']`. `web/src/app/theme.ts` grava sempre o
atributo no `<html>`: a escolha explícita (`light`/`dark`, lembrada em `eclume-tema`) ou, em "Do
sistema", o resultado de `matchMedia('(prefers-color-scheme: dark)')` (sem `matchMedia`, claro).
O `main.tsx` aplica a preferência antes do `render` e liga `watchSystemTheme()`, que acompanha a
troca do sistema enquanto a preferência for "Do sistema". No shell, a escolha é o `.seg` "Tema"
(Sistema, Claro, Escuro). Cor nova entra como token no DS, não no web.

## Marca e ícones

- `Brand.tsx` desenha a lockup `.brand`: as cinco barras em SVG inline (preenchidas pelo CSS) e
  `eclume` em Archivo 800. Com `to`, é link.
- `web/public/favicon.svg` é o `assets/app-icon.svg` do DS; o `index.html` declara o ícone e o
  `theme-color` claro (`#f7f5f2`) e escuro (`#1e1c19`).
- Ícones vêm de `lucide-react` por import nomeado, com `size={16}` e `aria-hidden`; o traço 2 é o
  padrão do Lucide e a ponta quadrada vem do `app.css`.

## Verificação visual

`web/e2e/visual.spec.ts` afirma o estilo computado (fundo `rgb(247, 245, 242)` no claro e
`rgb(30, 28, 25)` no escuro, campo da marca `rgb(111, 90, 68)`, Archivo 800 carregada, canto zero
no `.btn-primary`, nenhuma requisição fora da origem e `?` abrindo a gaveta de ajuda) e roda no
E2E de sempre. Com `E2E_SCREENSHOTS=1`, salva as telas em claro e escuro, a 1440×900 e 390×844,
em `web/test-results/screens/app-*.png`; com `ECLUME_DS_DIR=<eclume-design>`, salva também os
quadros de `examples/access.html` como `ds-*.png`, para a comparação lado a lado. Não há diff
de pixels: a comparação é revisada.
