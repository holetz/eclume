import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ME_KEY } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from './AuthLayout'
import { useSignupInfo } from './signup'

/**
 * Aceite do aviso em vigor (`notice_required` em `/me`): a conta que ainda não aceitou a versão
 * atual só chega ao app depois de `POST /me/notice`.
 */
export function NoticePage({ onLogout, loggingOut }: { onLogout: () => void; loggingOut: boolean }) {
  usePageTitle('Aceite do aviso')
  const info = useSignupInfo()
  const queryClient = useQueryClient()
  const [accepted, setAccepted] = useState(false)
  const accept = useMutation({
    mutationFn: (version: string) => unwrap(api.POST('/api/v1/me/notice', { body: { notice_version: version } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  })
  const notice = info.data?.notice

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (accepted && notice) accept.mutate(notice.version)
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        <div>
          <h2>Antes de continuar</h2>
          <p className="text-muted">O aviso do eclume mudou. Para usar a sua conta, aceite a versão em vigor.</p>
        </div>
        {info.isPending && <p role="status">Carregando o aviso…</p>}
        {info.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(info.error)}
          </p>
        )}
        {notice && (
          <div className="panel">
            <label className="check">
              <input type="checkbox" required checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span className="box" />
              <span>{notice.text}</span>
            </label>
          </div>
        )}
        {accept.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(accept.error)}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={!accepted || !notice || accept.isPending}>
          {accept.isPending ? 'Registrando…' : 'Aceitar e continuar'}
        </button>
        <button type="button" className="btn btn-secondary btn-block" onClick={onLogout} disabled={loggingOut}>
          {loggingOut ? 'Saindo…' : 'Sair'}
        </button>
      </form>
    </AuthLayout>
  )
}
