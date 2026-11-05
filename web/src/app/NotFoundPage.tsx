import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { PageHead } from './PageHead'

export function NotFoundPage() {
  const { t } = useTranslation('shell')
  return (
    <section>
      <PageHead title={t('notFound.title')} />
      <p className="text-muted">
        {t('notFound.text')} <Link to="/">{t('notFound.back')}</Link>.
      </p>
    </section>
  )
}
