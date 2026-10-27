// The draft of the hand-edited summary survives reloading the tab: it stays in `sessionStorage` per
// recording, with the version it was written on. Reading and writing never break the screen (pattern of
// `app/storage.ts`); with no storage, the draft only lasts while the edit is open.

export interface SummaryDraft {
  base_version: number
  content_md: string
}

const key = (recordingId: string) => `eclume-resumo-rascunho:${recordingId}`

export function readSummaryDraft(recordingId: string): SummaryDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key(recordingId))
    if (!raw) return null
    const draft = JSON.parse(raw) as Partial<SummaryDraft>
    if (typeof draft.base_version !== 'number' || typeof draft.content_md !== 'string') return null
    return { base_version: draft.base_version, content_md: draft.content_md }
  } catch {
    return null
  }
}

/** Saves the draft; `null` deletes it. */
export function writeSummaryDraft(recordingId: string, draft: SummaryDraft | null): void {
  try {
    if (draft === null) window.sessionStorage.removeItem(key(recordingId))
    else window.sessionStorage.setItem(key(recordingId), JSON.stringify(draft))
  } catch {
    // With no storage, the draft does not survive the reload.
  }
}
