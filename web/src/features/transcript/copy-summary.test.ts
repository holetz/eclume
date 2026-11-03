import { describe, expect, it } from 'vitest'
import { summaryClipboard } from './copy-summary'

const MARKDOWN = [
  '# Ata da reunião',
  '',
  '## Decisões',
  '',
  '- Três **turmas** de 12 gestores',
  '- Ver [o plano](https://exemplo.com/plano)',
  '',
  '### Próximos passos',
  '',
  'Texto com *ênfase*.',
  '',
  '```',
  '# comentário dentro do código',
  '```',
  '',
].join('\n')

describe('summary copy for Teams', () => {
  it('puts the recording title and the section headings in bold, without headers', async () => {
    const { html } = await summaryClipboard('Alinhamento do programa', MARKDOWN)
    expect(html.startsWith('<p><strong>Alinhamento do programa</strong></p>')).toBe(true)
    expect(html).toContain('<p><strong>Ata da reunião</strong></p>')
    expect(html).toContain('<p><strong>Decisões</strong></p>')
    expect(html).toContain('<p><strong>Próximos passos</strong></p>')
    expect(html).not.toMatch(/<h[1-6]/)
    // The `#` inside a code block is content, not a heading.
    expect(html.replace(/<pre>[\s\S]*<\/pre>/, '')).not.toContain('#')
  })

  it('keeps lists, emphasis and links formatted', async () => {
    const { html } = await summaryClipboard('Título', MARKDOWN)
    expect(html).toContain('<li>Três <strong>turmas</strong> de 12 gestores</li>')
    expect(html).toContain('<a href="https://exemplo.com/plano" target="_blank" rel="noopener noreferrer">o plano</a>')
    expect(html).toContain('<em>ênfase</em>')
  })

  it('in plain text removes the heading hashes and leaves the code as it is', async () => {
    const { text } = await summaryClipboard('Alinhamento do programa', MARKDOWN)
    expect(text.startsWith('Alinhamento do programa\n\nAta da reunião\n\nDecisões\n')).toBe(true)
    expect(text).not.toMatch(/^#{1,6} (Ata|Decisões|Próximos)/m)
    expect(text).toContain('# comentário dentro do código')
    expect(text).toContain('- Três **turmas** de 12 gestores')
  })

  it('treats the title as text, never as Markdown or HTML', async () => {
    const { html, text } = await summaryClipboard('Reunião *A* <b>1:1</b>', 'Corpo')
    expect(html.startsWith('<p><strong>Reunião *A* &lt;b&gt;1:1&lt;/b&gt;</strong></p>')).toBe(true)
    expect(text.startsWith('Reunião *A* <b>1:1</b>\n\nCorpo')).toBe(true)
  })

  it('does not let raw HTML from the Markdown reach the copy', async () => {
    const { html } = await summaryClipboard('Título', 'Antes\n\n<script>alert(1)</script>\n\nDepois')
    expect(html).not.toContain('<script')
    expect(html).toContain('Depois')
  })
})
