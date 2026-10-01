// O rascunho do resumo editado à mão sobrevive a recarregar a aba: fica no `sessionStorage` por
// gravação, com a versão sobre a qual foi escrito. Ler e gravar nunca quebram a tela (padrão de
// `app/storage.ts`); sem armazenamento, o rascunho vale só enquanto a edição está aberta.

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

/** Grava o rascunho; `null` apaga. */
export function writeSummaryDraft(recordingId: string, draft: SummaryDraft | null): void {
  try {
    if (draft === null) window.sessionStorage.removeItem(key(recordingId))
    else window.sessionStorage.setItem(key(recordingId), JSON.stringify(draft))
  } catch {
    // Sem armazenamento, o rascunho não sobrevive à recarga.
  }
}
