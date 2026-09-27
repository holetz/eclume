import type { ReactNode } from 'react'
import { Brand } from '../../app/Brand'

const COPY = {
  user: {
    title: 'Cada palavra, guardada em casa.',
    tagline: 'Transcrição auto-hospedada para as suas próprias gravações.',
  },
  admin: {
    title: 'Painel de administração',
    tagline: 'Separado das contas de usuário. Só configurações da plataforma.',
  },
} as const

/**
 * A `.auth` do Design System: o campo da marca ao lado do formulário alinhado à esquerda. A
 * variante `admin` (`.auth-admin`) pinta o campo da marca em tinta, para o login do painel.
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
