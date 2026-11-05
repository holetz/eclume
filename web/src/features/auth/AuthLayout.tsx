import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Brand } from '../../app/Brand'

/**
 * The Design System's `.auth`: the brand field beside the left-aligned form. The
 * `admin` variant (`.auth-admin`) paints the brand field in ink, for the panel login.
 */
export function AuthLayout({ children, variant = 'user' }: { children: ReactNode; variant?: 'user' | 'admin' }) {
  const { t } = useTranslation('auth')
  return (
    <main className={variant === 'admin' ? 'auth auth-admin' : 'auth'}>
      <section className="auth-brand">
        <Brand />
        <h1>{t(`layout.${variant}.title`)}</h1>
        <span className="auth-tagline">{t(`layout.${variant}.tagline`)}</span>
      </section>
      <section className="auth-form">{children}</section>
    </main>
  )
}
