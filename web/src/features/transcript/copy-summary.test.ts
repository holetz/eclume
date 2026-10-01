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

describe('cópia do resumo para o Teams', () => {
  it('põe o título da gravação e os títulos de seção em negrito, sem cabeçalhos', async () => {
    const { html } = await summaryClipboard('Alinhamento do programa', MARKDOWN)
    expect(html.startsWith('<p><strong>Alinhamento do programa</strong></p>')).toBe(true)
    expect(html).toContain('<p><strong>Ata da reunião</strong></p>')
    expect(html).toContain('<p><strong>Decisões</strong></p>')
    expect(html).toContain('<p><strong>Próximos passos</strong></p>')
    expect(html).not.toMatch(/<h[1-6]/)
    // O `#` de dentro de um bloco de código é conteúdo, não título.
    expect(html.replace(/<pre>[\s\S]*<\/pre>/, '')).not.toContain('#')
  })

  it('mantém listas, ênfase e links formatados', async () => {
    const { html } = await summaryClipboard('Título', MARKDOWN)
    expect(html).toContain('<li>Três <strong>turmas</strong> de 12 gestores</li>')
    expect(html).toContain('<a href="https://exemplo.com/plano" target="_blank" rel="noopener noreferrer">o plano</a>')
    expect(html).toContain('<em>ênfase</em>')
  })

  it('no texto puro tira as hashtags dos títulos e deixa o código como está', async () => {
    const { text } = await summaryClipboard('Alinhamento do programa', MARKDOWN)
    expect(text.startsWith('Alinhamento do programa\n\nAta da reunião\n\nDecisões\n')).toBe(true)
    expect(text).not.toMatch(/^#{1,6} (Ata|Decisões|Próximos)/m)
    expect(text).toContain('# comentário dentro do código')
    expect(text).toContain('- Três **turmas** de 12 gestores')
  })

  it('trata o título como texto, nunca como Markdown ou HTML', async () => {
    const { html, text } = await summaryClipboard('Reunião *A* <b>1:1</b>', 'Corpo')
    expect(html.startsWith('<p><strong>Reunião *A* &lt;b&gt;1:1&lt;/b&gt;</strong></p>')).toBe(true)
    expect(text.startsWith('Reunião *A* <b>1:1</b>\n\nCorpo')).toBe(true)
  })

  it('não deixa HTML cru do Markdown chegar à cópia', async () => {
    const { html } = await summaryClipboard('Título', 'Antes\n\n<script>alert(1)</script>\n\nDepois')
    expect(html).not.toContain('<script')
    expect(html).toContain('Depois')
  })
})
