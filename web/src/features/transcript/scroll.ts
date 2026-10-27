/** A vertical band on screen: the top and the height, as in `getBoundingClientRect()`. */
export interface Band {
  top: number
  height: number
}

/** The gap between the segment and the container's edge when scrolling brings it inside. */
export const SCROLL_GAP = 16

/**
 * The `scrollTop` that brings the item into view inside the scrolling container, without scrolling the page.
 * `nearest` only scrolls when the item is outside (returns `null` if it is already fully in view) and rests it against the
 * nearest edge, with the gap; `center` always centers the item. Never returns a negative value.
 */
export function scrollTopFor(
  view: Band & { scrollTop: number },
  item: Band,
  block: 'nearest' | 'center',
): number | null {
  // Where the item starts in the container's content, regardless of the current scroll.
  const offset = item.top - view.top + view.scrollTop
  if (block === 'center') return Math.max(0, Math.round(offset - (view.height - item.height) / 2))
  if (item.top < view.top) return Math.max(0, Math.round(offset - SCROLL_GAP))
  if (item.top + item.height > view.top + view.height) {
    return Math.max(0, Math.round(offset + item.height - view.height + SCROLL_GAP))
  }
  return null
}

/** Scrolls the container to the item, only inside it: the window and the other ancestors stay where they are. */
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
