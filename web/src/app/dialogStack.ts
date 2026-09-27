// Diálogos abertos, o de cima por último: só ele responde ao Esc, e a gaveta de ajuda não abre
// nem fecha por atalho enquanto houver um.
export const openDialogs: HTMLElement[] = []

export function hasOpenDialog(): boolean {
  return openDialogs.length > 0
}
