// Reader for the help articles' header: only the subset they use, with no dependency.
//   ---
//   key: value
//   list: [a, b, c]
//   ---
//   Markdown body

export type FrontmatterValue = string | string[]

interface Frontmatter {
  data: Record<string, FrontmatterValue>
  body: string
}

const LINE = /^([a-z][a-z0-9_-]*):\s*(.*)$/

/** Splits header and body; throws with the file name when the header is invalid. */
export function parseFrontmatter(raw: string, file: string): Frontmatter {
  const text = raw.replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) throw new Error(`${file}: o artigo precisa começar com o cabeçalho entre "---".`)
  const end = text.indexOf('\n---\n', 3)
  if (end < 0) throw new Error(`${file}: o cabeçalho não fecha com "---".`)

  const data: Record<string, FrontmatterValue> = {}
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim()) continue
    const match = LINE.exec(line)
    if (!match) throw new Error(`${file}: linha inválida no cabeçalho: "${line}".`)
    const [, key, value] = match
    if (key in data) throw new Error(`${file}: a chave "${key}" aparece duas vezes.`)
    data[key] = parseValue(value.trim(), file, key)
  }
  return { data, body: text.slice(end + 5).trim() }
}

function parseValue(value: string, file: string, key: string): FrontmatterValue {
  if (!value.startsWith('[')) return value
  if (!value.endsWith(']')) throw new Error(`${file}: a lista de "${key}" não fecha com "]".`)
  const inner = value.slice(1, -1).trim()
  return inner ? inner.split(',').map((item) => item.trim()) : []
}
