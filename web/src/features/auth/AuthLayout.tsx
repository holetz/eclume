import type { ReactNode } from 'react'
import { Brand } from '../../app/Brand'

/** A `.auth` do Design System: o campo da marca ao lado do formulário alinhado à esquerda. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth">
      <section className="auth-brand">
        <Brand />
        <h1>Cada palavra, guardada em casa.</h1>
        <span className="auth-tagline">Transcrição auto-hospedada para as suas próprias gravações.</span>
      </section>
      <section className="auth-form">{children}</section>
    </main>
  )
}
