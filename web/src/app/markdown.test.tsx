import { render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { SAFE_MARKDOWN, safeMarkdown } from './markdown'

function html(markdown: string, components = SAFE_MARKDOWN): HTMLElement {
  return render(<ReactMarkdown components={components}>{markdown}</ReactMarkdown>).container
}

describe('safe Markdown', () => {
  it('replaces the image with a text link, loading nothing', () => {
    const root = html('Veja ![o gráfico](https://fora.example/pixel.png) aqui.')
    expect(root.querySelector('img')).toBeNull()
    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://fora.example/pixel.png')
    expect(link?.textContent).toBe('o gráfico')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('an image without alt text shows the URL', () => {
    expect(html('![](https://fora.example/a.png)').querySelector('a')?.textContent).toBe('https://fora.example/a.png')
  })

  it('a link opens in another tab with neither opener nor referer', () => {
    const link = html('[o site](https://exemplo.com.br)').querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('keeps the screen components, but does not let them replace img', () => {
    const root = html('# Título\n\n![x](https://fora.example/x.png)', safeMarkdown({ h1: ({ children }) => <h2>{children}</h2>, img: () => <img alt="" /> }))
    expect(root.querySelector('h2')?.textContent).toBe('Título')
    expect(root.querySelector('img')).toBeNull()
  })
})
