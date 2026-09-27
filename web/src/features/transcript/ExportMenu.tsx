import { ChevronDown, Download } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../../api/problem'
import { MenuButton } from '../../app/MenuButton'
import { downloadExport, type ExportFormat } from './exports'

interface ExportMenuProps {
  recordingId: string
  /** Há resumo atual: sem ele, o MD fica desabilitado. */
  hasSummary: boolean
  /** A falha do export (o problem da API), para o cabeçalho mostrar; `null` ao tentar de novo. */
  onError: (message: string | null) => void
}

/** O menu Exportar do cabeçalho: transcrição (TXT, SRT), resumo (MD) e os dois juntos (DOCX). */
export function ExportMenu({ recordingId, hasSummary, onError }: ExportMenuProps) {
  const [busy, setBusy] = useState(false)

  async function run(format: ExportFormat) {
    onError(null)
    setBusy(true)
    try {
      await downloadExport(recordingId, format)
    } catch (caught) {
      onError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MenuButton
      label="Exportar"
      items={[
        { key: 'txt', label: 'Transcrição', kbd: 'TXT', onSelect: () => void run('txt') },
        { key: 'srt', label: 'Transcrição com tempos', kbd: 'SRT', onSelect: () => void run('srt') },
        { key: 'md', label: 'Resumo', kbd: 'MD', disabled: !hasSummary, onSelect: () => void run('md') },
        'separator',
        { key: 'docx', label: 'Transcrição e resumo', kbd: 'DOCX', onSelect: () => void run('docx') },
      ]}
    >
      <Download size={16} aria-hidden />
      {busy ? 'Exportando…' : 'Exportar'}
      <ChevronDown size={16} aria-hidden />
    </MenuButton>
  )
}
