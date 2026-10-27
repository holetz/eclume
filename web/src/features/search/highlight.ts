// The search `highlight` arrives with the text escaped and the terms between <mark> and </mark>, and no
// other HTML (contract). Here it becomes plain-text pieces, rendered by React without innerHTML.
interface HighlightPart {
  text: string
  marked: boolean
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
}

function unescape(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|#x27|#39);/g, (entity) => ENTITIES[entity])
}

export function parseHighlight(value: string): HighlightPart[] {
  const parts: HighlightPart[] = []
  let marked = false
  for (const piece of value.split(/(<mark>|<\/mark>)/)) {
    if (piece === '<mark>') marked = true
    else if (piece === '</mark>') marked = false
    else if (piece) parts.push({ text: unescape(piece), marked })
  }
  return parts
}
