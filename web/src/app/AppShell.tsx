import { lazy, Suspense, useId, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { CircleHelp, LogOut, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styles from './AppShell.module.css'
import { Brand } from './Brand'
import { ConnectionBanner } from './ConnectionBanner'
import { useImportContext } from '../features/import/importContext'
import { ImportProvider } from '../features/import/ImportProvider'
import { useHasAnyRecording } from '../features/library/anyRecording'
import { useHelp } from './help'
import { HelpProvider } from './HelpProvider'
import { MenuButton, type MenuEntry } from './MenuButton'
import {
  featuredItem,
  groupLabel,
  isItemActive,
  itemLabel,
  navGroups,
  partLabel,
  type FeaturedItem,
  type NavGroupEntry,
} from './nav'
import { useProcessingWatch } from './processingWatch'
import { ShellFrame } from './ShellFrame'

// The confirmation to log out during an upload is rare: it loads on demand, outside the initial JS.
const ConfirmDialog = lazy(() => import('./ConfirmDialog').then((module) => ({ default: module.ConfirmDialog })))

export interface ShellUser {
  name: string
  email: string
}

interface AppShellProps {
  user: ShellUser
  onLogout: () => void
  loggingOut?: boolean
}

function NavGroups({ groups }: { groups: NavGroupEntry[] }) {
  useTranslation('shell')
  const baseId = useId()
  const { pathname } = useLocation()
  return groups.map(({ group, items }, index) => (
    <div key={group} className="nav-group" role="group" aria-labelledby={`${baseId}-${index}`}>
      <span className="nav-group-title" id={`${baseId}-${index}`}>
        {groupLabel(group)}
      </span>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="nav-link"
          aria-current={isItemActive(item, pathname) ? 'page' : undefined}
        >
          {itemLabel(item)}
        </Link>
      ))}
    </div>
  ))
}

/**
 * The featured item (Agent): the DS primary action at the top of the sidebar, with its icon.
 * While the account has no recording there is little to ask: it stays in the same place, as secondary.
 */
function FeaturedLink({ item }: { item: FeaturedItem }) {
  useTranslation('shell')
  const { pathname } = useLocation()
  const anyRecording = useHasAnyRecording()
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      className={`btn ${anyRecording.data === false ? 'btn-secondary' : 'btn-primary'} ${styles.featured}`}
      aria-current={isItemActive(item, pathname) ? 'page' : undefined}
    >
      <Icon size={16} aria-hidden="true" />
      {itemLabel(item)}
    </Link>
  )
}

/**
 * The account in the header: name and e-mail, and the help, settings and log-out buttons. Help and
 * settings open menus with the items of the nav's `header` section; choosing an item navigates without
 * touching the sidebar. Logging out with a file converting or uploading asks for confirmation, because
 * the upload stops.
 */
function Account({ user, onLogout, loggingOut }: AppShellProps) {
  const { t } = useTranslation('shell')
  const help = useHelp()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { header } = navGroups()
  const { sending } = useImportContext()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const itemsOf = (group: NavGroupEntry['group']): MenuEntry[] =>
    (header.find((entry) => entry.group === group)?.items ?? []).flatMap((item, index, list) => {
      const entry: MenuEntry = {
        key: item.to,
        label: isItemActive(item, pathname) ? <strong>{itemLabel(item)}</strong> : itemLabel(item),
        onSelect: () => navigate(item.to),
      }
      // Each part of the gear menu opens with its own label.
      return item.part && item.part !== list[index - 1]?.part ? [{ heading: partLabel(item.part) }, entry] : [entry]
    })
  const helpItems: MenuEntry[] = [
    { key: 'pagina', label: t('account.helpThisPage'), kbd: '?', onSelect: () => help?.openHelp() },
    ...itemsOf('help'),
  ]

  return (
    <div className={styles.account}>
      <div className={styles.user}>
        <strong>{user.name}</strong>
        <span className="text-muted">{user.email}</span>
      </div>
      <div className={styles.actions}>
        <MenuButton className="btn btn-secondary btn-icon" buttonLabel={t('account.help')} label={groupLabel('help')} items={helpItems}>
          <CircleHelp size={16} aria-hidden="true" />
        </MenuButton>
        <MenuButton
          className="btn btn-secondary btn-icon"
          buttonLabel={t('account.settings')}
          label={groupLabel('settings')}
          items={itemsOf('settings')}
        >
          <Settings size={16} aria-hidden="true" />
        </MenuButton>
        <span className={styles.bar} aria-hidden="true" />
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          aria-label={loggingOut ? t('account.loggingOut') : t('account.logout')}
          title={t('account.logout')}
          onClick={() => (sending ? setConfirmLogout(true) : onLogout())}
          disabled={loggingOut}
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
      {confirmLogout && (
        <Suspense fallback={null}>
          <ConfirmDialog
            title={t('account.logoutDuringUpload')}
            confirmLabel={t('account.logout')}
            onCancel={() => setConfirmLogout(false)}
            onConfirm={() => {
              setConfirmLogout(false)
              onLogout()
            }}
          >
            <p>{t('account.uploadInterrupted')}</p>
          </ConfirmDialog>
        </Suspense>
      )}
    </div>
  )
}

export function AppShell({ user, onLogout, loggingOut = false }: AppShellProps) {
  const { t } = useTranslation('shell')
  const { main } = navGroups()
  const featured = featuredItem()
  useProcessingWatch()

  return (
    <HelpProvider>
      <ImportProvider>
        <ShellFrame
          brand={<Brand to="/" />}
          account={<Account user={user} onLogout={onLogout} loggingOut={loggingOut} />}
          sidebar={
            <nav aria-label={t('nav.primary')} className={styles.nav}>
              {featured && <FeaturedLink item={featured} />}
              <NavGroups groups={main} />
            </nav>
          }
        >
          <ConnectionBanner />
          <Outlet />
        </ShellFrame>
      </ImportProvider>
    </HelpProvider>
  )
}
