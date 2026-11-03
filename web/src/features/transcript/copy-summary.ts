// The summary copy to paste into another app (Teams): the HTML comes out of the same `react-markdown` as the screen,
// with the headings in bold, because Teams does not keep the heading style on paste; the plain text is the
// Markdown without the heading hashes, for whoever does not accept HTML.
import { createElement, Fragment, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import { safeMarkdown } from '../../app/markdown'

const boldTitle = ({ children }: { children?: ReactNode }) => createElement('p', null, createElement('strong', null, children))

const TITLES = safeMarkdown({ h1: boldTitle, h2: boldTitle, h3: boldTitle, h4: boldTitle, h5: boldTitle, h6: boldTitle })

/** The Markdown without the `#` prefix of the heading lines; whatever is in a code block stays as it is. */
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
  // Only the copy uses the server renderer; outside the initial bundle.
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
