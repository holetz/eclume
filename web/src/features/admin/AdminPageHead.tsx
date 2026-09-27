import type { ReactNode } from 'react'
import { PageHead } from '../../app/PageHead'
import { ADMIN_KICKER, useAdminTitle } from './sections'

/**
 * O `PageHead` do painel, com o kicker "Painel de administração". O efeito deste pai roda depois
 * do `usePageTitle` do `PageHead` e põe o título da aba do painel no lugar.
 */
export function AdminPageHead({ title, actions }: { title: string; actions?: ReactNode }) {
  useAdminTitle(title)
  return <PageHead kicker={ADMIN_KICKER} title={title} actions={actions} />
}
