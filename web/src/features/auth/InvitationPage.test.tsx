import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const TOKEN = 'ecli_Zk3qW8rT5yU1iO7pA2sDxxxxxxxxxxx'

describe('aceite de convite', () => {
  it('cria a conta e entra na biblioteca', async () => {
    let session = false
    const http = mockFetch({
      'GET /api/v1/me': () => (session ? fixtures.me() : problem('unauthorized', 401)),
      'POST /api/v1/auth/invitations/:token/accept': () => {
        session = true
        return empty(204)
      },
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
    })
    renderApp(`/convite/${TOKEN}`)
    await userEvent.type(await screen.findByLabelText('Nome'), 'Beatriz Nunes')
    await userEvent.type(screen.getByLabelText('Senha'), 'senha-muito-boa')
    await userEvent.type(screen.getByLabelText('Confirme a senha'), 'senha-muito-bo')
    expect(screen.getByText('As senhas não conferem.')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Criar conta e entrar' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Confirme a senha'), 'a')
    await userEvent.click(submit)

    expect(await screen.findByRole('heading', { name: 'Biblioteca' })).toBeInTheDocument()
    const request = http.requests('POST /api/v1/auth/invitations/:token/accept')[0]
    expect(new URL(request.url).pathname).toBe(`/api/v1/auth/invitations/${TOKEN}/accept`)
    expect(await request.json()).toEqual({ name: 'Beatriz Nunes', password: 'senha-muito-boa' })
  })

  it('explica o convite inválido ou expirado', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/invitations/:token/accept': () => problem('not_found', 404),
    })
    renderApp(`/convite/${TOKEN}`)
    await userEvent.type(await screen.findByLabelText('Nome'), 'Beatriz')
    await userEvent.type(screen.getByLabelText('Senha'), 'senha-muito-boa')
    await userEvent.type(screen.getByLabelText('Confirme a senha'), 'senha-muito-boa')
    await userEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('inválido, expirou ou já foi usado')
  })
})
