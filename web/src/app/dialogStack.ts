// Open dialogs, the topmost last: only it responds to Esc, and the help drawer neither opens
// nor closes by shortcut while there is one.
export const openDialogs: HTMLElement[] = []

export function hasOpenDialog(): boolean {
  return openDialogs.length > 0
}
