import { render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { SAFE_MARKDOWN, safeMarkdown } from './markdown'

function html(markdown: string, components = SAFE_MARKDOWN): HTMLElement {
  return render(<ReactMarkdown components={components}>{markdown}</ReactMarkdown>).container
}

describe('Markdown seguro', () => {
  it('troca a imagem por um link de texto, sem carregar nada', () => {
    const root = html('Veja ![o gráfico](https://fora.example/pixel.png) aqui.')
    expect(root.querySelector('img')).toBeNull()
    const link = root.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://fora.example/pixel.png')
    expect(link?.textContent).toBe('o gráfico')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('imagem sem texto alternativo mostra a URL', () => {
    expect(html('![](https://fora.example/a.png)').querySelector('a')?.textContent).toBe('https://fora.example/a.png')
  })

  it('link abre em outra aba sem opener nem referer', () => {
    const link = html('[o site](https://exemplo.com.br)').querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('mantém os components da tela, mas não deixa trocar img', () => {
    const root = html('# Título\n\n![x](https://fora.example/x.png)', safeMarkdown({ h1: ({ children }) => <h2>{children}</h2>, img: () => <img alt="" /> }))
    expect(root.querySelector('h2')?.textContent).toBe('Título')
    expect(root.querySelector('img')).toBeNull()
  })
})
