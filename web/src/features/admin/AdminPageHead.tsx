import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHead } from '../../app/PageHead'
import { useAdminTitle } from './sections'

/**
 * The panel's `PageHead`, with the "Painel de administração" kicker. This parent's effect runs after
 * the `PageHead`'s `usePageTitle` and puts the panel's tab title in its place.
 */
export function AdminPageHead({ title, actions }: { title: string; actions?: ReactNode }) {
  const { t } = useTranslation('admin')
  useAdminTitle(title)
  return <PageHead kicker={t('kicker')} title={title} actions={actions} />
}
