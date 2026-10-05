/** Uma faixa vertical na tela: o topo e a altura, como em `getBoundingClientRect()`. */
export interface Band {
  top: number
  height: number
}

/** A folga entre a fala e a borda do contêiner quando a rolagem a traz para dentro. */
export const SCROLL_GAP = 16

/**
 * O `scrollTop` que põe o item à vista dentro do contêiner que rola, sem rolar a página.
 * `nearest` só rola quando o item está fora (devolve `null` se já está inteiro à vista) e o encosta na
 * borda mais próxima, com a folga; `center` sempre centra o item. Nunca devolve valor negativo.
 */
export function scrollTopFor(
  view: Band & { scrollTop: number },
  item: Band,
  block: 'nearest' | 'center',
): number | null {
  // Onde o item começa no conteúdo do contêiner, independente da rolagem atual.
  const offset = item.top - view.top + view.scrollTop
  if (block === 'center') return Math.max(0, Math.round(offset - (view.height - item.height) / 2))
  if (item.top < view.top) return Math.max(0, Math.round(offset - SCROLL_GAP))
  if (item.top + item.height > view.top + view.height) {
    return Math.max(0, Math.round(offset + item.height - view.height + SCROLL_GAP))
  }
  return null
}

/** Rola o contêiner até o item, só por dentro dele: a janela e os outros ancestrais ficam onde estão. */
export function scrollWithin(
  container: HTMLElement,
  item: Element,
  block: 'nearest' | 'center',
  behavior: ScrollBehavior = 'auto',
): void {
  const view = container.getBoundingClientRect()
  const band = item.getBoundingClientRect()
  const top = scrollTopFor({ top: view.top, height: view.height, scrollTop: container.scrollTop }, band, block)
  if (top !== null) container.scrollTo({ top, behavior })
}
