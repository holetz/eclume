// O `highlight` da busca chega com o texto escapado e os termos entre <mark> e </mark>, e nenhum
// outro HTML (contrato). Aqui vira pedaços de texto puro, renderizados pelo React sem innerHTML.
export interface HighlightPart {
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
