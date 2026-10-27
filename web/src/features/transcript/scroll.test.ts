import { describe, expect, it, vi } from 'vitest'
import { SCROLL_GAP, scrollTopFor, scrollWithin } from './scroll'

// A 400 px container that starts at y=100 of the window, already scrolled 1,000 px.
const view = { top: 100, height: 400, scrollTop: 1000 }

describe('scrollTopFor', () => {
  it('does not scroll with the whole segment in view (nearest)', () => {
    expect(scrollTopFor(view, { top: 200, height: 80 }, 'nearest')).toBeNull()
  })

  it('segment below the container: rests it at the bottom, with the gap', () => {
    // The segment starts 600 px down the window: 500 px below the container's top, 1,500 px into the content.
    expect(scrollTopFor(view, { top: 600, height: 80 }, 'nearest')).toBe(1500 + 80 - 400 + SCROLL_GAP)
  })

  it('segment above the container: rests it at the top, with the gap', () => {
    expect(scrollTopFor(view, { top: 40, height: 80 }, 'nearest')).toBe(940 - SCROLL_GAP)
  })

  it('center centers the segment, even when already in view', () => {
    expect(scrollTopFor(view, { top: 200, height: 80 }, 'center')).toBe(1100 - 160)
  })

  it('never returns a negative scroll', () => {
    expect(scrollTopFor({ top: 0, height: 400, scrollTop: 0 }, { top: 10, height: 20 }, 'center')).toBe(0)
    expect(scrollTopFor({ top: 100, height: 400, scrollTop: 0 }, { top: 90, height: 20 }, 'nearest')).toBe(0)
  })
})

describe('scrollWithin', () => {
  it('scrolls the container through scrollTo and calls scrollIntoView on nothing', () => {
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
