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
 * Ajustes do corpo do artigo sobre a árvore HTML: `id` nos `##` (para o índice) e o blockquote que
 * começa com `**Título**` vira o `.alert.alert-info` do DS, com o título em `.alert-title`.
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
    // Rotas do app viram navegação do SPA; arquivos servidos ao lado do app (/downloads/, páginas
    // .html como a referência da API) e endereços externos, links comuns.
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
 * O corpo Markdown de um artigo de ajuda, no `.doc` do DS; `bare` mostra só o Markdown (a resposta
 * de uma pergunta frequente). HTML cru no Markdown não é renderizado.
 */
export function ArticleBody({ markdown, bare }: { markdown: string; bare?: boolean }) {
  const body = (
    <Markdown rehypePlugins={[helpArticle]} components={components}>
      {markdown}
    </Markdown>
  )
  return bare ? body : <article className="doc">{body}</article>
}
