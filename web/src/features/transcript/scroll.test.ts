import { describe, expect, it, vi } from 'vitest'
import { SCROLL_GAP, scrollTopFor, scrollWithin } from './scroll'

// Um contêiner de 400 px que começa em y=100 da janela, já rolado 1.000 px.
const view = { top: 100, height: 400, scrollTop: 1000 }

describe('scrollTopFor', () => {
  it('não rola com a fala inteira à vista (nearest)', () => {
    expect(scrollTopFor(view, { top: 200, height: 80 }, 'nearest')).toBeNull()
  })

  it('fala abaixo do contêiner: encosta embaixo, com a folga', () => {
    // A fala começa a 600 px da janela: 500 px abaixo do topo do contêiner, 1.500 px no conteúdo.
    expect(scrollTopFor(view, { top: 600, height: 80 }, 'nearest')).toBe(1500 + 80 - 400 + SCROLL_GAP)
  })

  it('fala acima do contêiner: encosta em cima, com a folga', () => {
    expect(scrollTopFor(view, { top: 40, height: 80 }, 'nearest')).toBe(940 - SCROLL_GAP)
  })

  it('center centra a fala, mesmo já à vista', () => {
    expect(scrollTopFor(view, { top: 200, height: 80 }, 'center')).toBe(1100 - 160)
  })

  it('nunca devolve rolagem negativa', () => {
    expect(scrollTopFor({ top: 0, height: 400, scrollTop: 0 }, { top: 10, height: 20 }, 'center')).toBe(0)
    expect(scrollTopFor({ top: 100, height: 400, scrollTop: 0 }, { top: 90, height: 20 }, 'nearest')).toBe(0)
  })
})

describe('scrollWithin', () => {
  it('rola o contêiner por scrollTo e não chama scrollIntoView em ninguém', () => {
    const container = document.createElement('div')
    const item = document.createElement('div')
    container.append(item)
    container.getBoundingClientRect = () => ({ top: 0, height: 300 }) as DOMRect
    item.getBoundingClientRect = () => ({ top: 900, height: 60 }) as DOMRect
    const scrollTo = vi.fn()
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo
    const intoView = vi.mocked(Element.prototype.scrollIntoView)
    intoView.mockClear()

    scrollWithin(container, item, 'nearest', 'smooth')

    expect(scrollTo).toHaveBeenCalledWith({ top: 900 + 60 - 300 + SCROLL_GAP, behavior: 'smooth' })
    expect(intoView).not.toHaveBeenCalled()
  })
})
