import { ChevronDown, Download } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { MenuButton } from '../../app/MenuButton'
import { downloadExport, type ExportFormat } from './exports'

interface ExportMenuProps {
  recordingId: string
  /** There is a current summary: without it, MD is disabled. */
  hasSummary: boolean
  /** The export failure (the API problem), for the header to show; `null` when trying again. */
  onError: (message: string | null) => void
}

/** The header's Exportar menu: transcript (TXT, SRT), summary (MD) and both together (DOCX). */
export function ExportMenu({ recordingId, hasSummary, onError }: ExportMenuProps) {
  const { t } = useTranslation('transcript')
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
      label={t('export.label')}
      items={[
        { key: 'txt', label: t('export.txt'), kbd: 'TXT', onSelect: () => void run('txt') },
        { key: 'srt', label: t('export.srt'), kbd: 'SRT', onSelect: () => void run('srt') },
        { key: 'md', label: t('export.md'), kbd: 'MD', disabled: !hasSummary, onSelect: () => void run('md') },
        'separator',
        { key: 'docx', label: t('export.docx'), kbd: 'DOCX', onSelect: () => void run('docx') },
      ]}
    >
      <Download size={16} aria-hidden />
      {busy ? t('export.busy') : t('export.label')}
      <ChevronDown size={16} aria-hidden />
    </MenuButton>
  )
}
