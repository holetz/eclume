import { useTranslation } from 'react-i18next'
import { externalDestinations, PURPOSE_LABEL, usePrivacy, type DataDestination } from '../../app/privacy'
import { activeLocale } from '../../i18n'

interface ExternalDataNoticeProps {
  /** The purposes the screen configures. */
  purposes: DataDestination['purpose'][]
  /** Changes when the configuration changes, to reread the destinations. */
  revision?: string | number
}

/** Warns that a purpose sends data outside the server, and that users see it in Conta. */
export function ExternalDataNotice({ purposes, revision }: ExternalDataNoticeProps) {
  const { t } = useTranslation('admin')
  const outside = externalDestinations(usePrivacy(revision).data).filter((d) => purposes.includes(d.purpose))
  if (outside.length === 0) return null
  const list = outside
    .map((d) =>
      t('external.item', {
        purpose: PURPOSE_LABEL[d.purpose].toLocaleLowerCase(activeLocale()),
        processor: d.processor ?? t('external.service'),
      }),
    )
    .join(', ')
  return (
    <div className="alert alert-warning" role="note" aria-label={t('external.label')}>
      <p>{t('external.text', { list })}</p>
    </div>
  )
}
