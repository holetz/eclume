// Markdown gerado por LLM (resumo, cópia para colar, chat da base, pré-visualização do tipo de agenda)
// nunca carrega imagem: `![alt](url)` vira um link de texto, para que um resumo não faça o navegador
// buscar uma URL de fora (rastreio, vazamento pelo Referer). Links abrem em outra aba sem `opener` nem
// `Referer`. A ajuda, de conteúdo próprio, não passa por aqui.
import type { Components } from 'react-markdown'

export const SAFE_MARKDOWN: Components = {
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    ) : (
      <>{alt}</>
    ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

/** `SAFE_MARKDOWN` com os `components` próprios de uma tela (que não trocam `img` nem `a`). */
export function safeMarkdown(own: Components = {}): Components {
  return { ...own, ...SAFE_MARKDOWN }
}
