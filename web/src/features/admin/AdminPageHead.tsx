import type { ReactNode } from 'react'
import { PageHead } from '../../app/PageHead'
import { ADMIN_KICKER, useAdminTitle } from './sections'

/**
 * The panel's `PageHead`, with the "Painel de administração" kicker. This parent's effect runs after
 * the `PageHead`'s `usePageTitle` and puts the panel's tab title in its place.
 */
export function AdminPageHead({ title, actions }: { title: string; actions?: ReactNode }) {
  useAdminTitle(title)
  return <PageHead kicker={ADMIN_KICKER} title={title} actions={actions} />
}
