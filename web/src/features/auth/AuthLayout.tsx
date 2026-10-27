import type { ReactNode } from 'react'
import { Brand } from '../../app/Brand'

const COPY = {
  user: {
    title: 'Cada palavra, guardada no seu servidor.',
    tagline: 'Transcrição auto-hospedada para as suas próprias gravações.',
  },
  admin: {
    title: 'Painel de administração',
    tagline: 'Separado das contas de usuário. Só configurações da plataforma.',
  },
} as const

/**
 * The Design System's `.auth`: the brand field beside the left-aligned form. The
 * `admin` variant (`.auth-admin`) paints the brand field in ink, for the panel login.
 */
export function AuthLayout({ children, variant = 'user' }: { children: ReactNode; variant?: 'user' | 'admin' }) {
  const copy = COPY[variant]
  return (
    <main className={variant === 'admin' ? 'auth auth-admin' : 'auth'}>
      <section className="auth-brand">
        <Brand />
        <h1>{copy.title}</h1>
        <span className="auth-tagline">{copy.tagline}</span>
      </section>
      <section className="auth-form">{children}</section>
    </main>
  )
}
