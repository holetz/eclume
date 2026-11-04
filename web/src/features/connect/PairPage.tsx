import { Link, useSearchParams } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from '../auth/AuthLayout'
import styles from './Connect.module.css'

/** "K7Q4MX" becomes "K7Q-4MX", as the code screen shows it. */
function formatCode(code: string): string {
  const clean = code.replace(/[^0-9a-z]/gi, '').toUpperCase()
  return clean.length === 6 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean
}

/**
 * Where someone lands after reading the QR with the regular camera, without the app: it explains what
 * to do. Public and with no API call; the code is only valid inside the app.
 */
export function PairPage() {
  const { t } = useTranslation('connect')
  usePageTitle(t('pair.title'))
  const [params] = useSearchParams()
  const code = params.get('codigo')

  return (
    <AuthLayout>
      <div className={styles.pair}>
        <h2>{t('pair.title')}</h2>
        <p>{t('pair.text')}</p>
        {code && (
          <p>
            <Trans
              t={t}
              i18nKey="pair.code"
              values={{ code: formatCode(code) }}
              components={{ code: <strong className="mono" /> }}
            />
          </p>
        )}
        <Link to="/entrar">{t('pair.login')}</Link>
      </div>
    </AuthLayout>
  )
}
