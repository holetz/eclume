// LLM-generated Markdown (summary, copy for pasting, knowledge base chat, agenda type preview) never
// loads an image: `![alt](url)` becomes a text link, so that a summary does not make the browser fetch
// an outside URL (tracking, leaking through the Referer). Links open in another tab with neither `opener`
// nor `Referer`. Help, with its own content, does not go through here.
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

/** `SAFE_MARKDOWN` with a screen's own `components` (which replace neither `img` nor `a`). */
export function safeMarkdown(own: Components = {}): Components {
  return { ...own, ...SAFE_MARKDOWN }
}
