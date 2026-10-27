import type { Element, ElementContent, Root } from 'hast'
import Markdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import { headingId } from './catalog'

function textOf(node: ElementContent | Root): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map((child) => textOf(child as ElementContent)).join('')
  return ''
}

const isElement = (node: ElementContent | undefined, tag: string): node is Element =>
  node?.type === 'element' && node.tagName === tag

/**
 * Adjustments to the article body on the HTML tree: `id` on the `##` (for the table of contents) and
 * the blockquote that starts with `**Título**` becomes the DS `.alert.alert-info`, with the title in
 * `.alert-title`.
 */
function helpArticle() {
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      parent.children.forEach((node, index) => {
        if (node.type !== 'element') return
        if (node.tagName === 'h2') node.properties.id = headingId(textOf(node))
        if (node.tagName === 'blockquote') {
          const blocks = node.children.filter((child) => child.type === 'element')
          const [first] = blocks
          const strong = isElement(first, 'p') ? first.children[0] : undefined
          if (isElement(first, 'p') && isElement(strong, 'strong')) {
            first.children.shift()
            const next = first.children[0]
            if (next?.type === 'text') next.value = next.value.replace(/^\s+/, '')
            if (first.children.length === 0) blocks.shift()
            parent.children[index] = {
              type: 'element',
              tagName: 'div',
              properties: { className: ['alert', 'alert-info'], role: 'note' },
              children: [
                { type: 'element', tagName: 'span', properties: { className: ['alert-title'] }, children: strong.children },
                ...blocks,
              ],
            }
            return
          }
        }
        visit(node)
      })
    }
    visit(tree)
  }
}

const components: Components = {
  a({ href = '', children }) {
    // App routes become SPA navigation; files served beside the app (/downloads/, .html pages such
    // as the API reference) and external addresses stay ordinary links.
    const file = href.startsWith('/downloads/') || /\.html(?:[?#]|$)/.test(href)
    if (href.startsWith('/') && !file) return <Link to={href}>{children}</Link>
    if (href.startsWith('/')) return <a href={href}>{children}</a>
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
}

/**
 * The Markdown body of a help article, in the DS `.doc`; `bare` shows only the Markdown (the answer to
 * a frequently asked question). Raw HTML in the Markdown is not rendered.
 */
export function ArticleBody({ markdown, bare }: { markdown: string; bare?: boolean }) {
  const body = (
    <Markdown rehypePlugins={[helpArticle]} components={components}>
      {markdown}
    </Markdown>
  )
  return bare ? body : <article className="doc">{body}</article>
}
