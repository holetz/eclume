// A cópia do resumo para colar em outro app (o Teams): o HTML sai do mesmo `react-markdown` da tela,
// com os títulos em negrito, porque o Teams não guarda o estilo de título ao colar; o texto puro é o
// Markdown sem as hashtags dos títulos, para quem não aceita HTML.
import { createElement, Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'

const boldTitle = ({ children }: { children?: ReactNode }) => createElement('p', null, createElement('strong', null, children))

const TITLES: Components = { h1: boldTitle, h2: boldTitle, h3: boldTitle, h4: boldTitle, h5: boldTitle, h6: boldTitle }

/** O Markdown sem o prefixo `#` das linhas de título; o que está em bloco de código fica como está. */
function withoutTitleMarks(markdown: string): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      return fenced ? line : line.replace(/^ {0,3}#{1,6}[ \t]+/, '')
    })
    .join('\n')
}

export async function summaryClipboard(title: string, markdown: string): Promise<{ html: string; text: string }> {
  // Só a cópia usa o renderizador de servidor; fora do bundle inicial.
  const { renderToStaticMarkup } = await import('react-dom/server')
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      boldTitle({ children: title }),
      createElement(ReactMarkdown, { components: TITLES }, markdown),
    ),
  )
  return { html, text: `${title}\n\n${withoutTitleMarks(markdown)}` }
}
