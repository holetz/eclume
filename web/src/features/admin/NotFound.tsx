import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { AdminPageHead } from './AdminPageHead'
import { ADMIN_HOME_PATH } from './adminSession'

/** A nonexistent route inside the panel: stays in the admin frame. */
export function NotFound() {
  const { t } = useTranslation('admin')
  return (
    <>
      <AdminPageHead title={t('notFound.title')} />
      <p>
        <Link to={ADMIN_HOME_PATH}>{t('notFound.home')}</Link>
      </p>
    </>
  )
}
