import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/redefinir-senha'))

afterEach(() => vi.unstubAllGlobals())

const SECRET = 'Vt3q8nZ0bKx2Lr7mQe4yHs9wPa1cDf6gJu5oTi8kNv0'
const NEW_PASSWORD = 'uma-senha-nova-bem-longa'
const INVALID = 'Este link venceu ou já foi usado. Peça outro a quem administra o servidor.'

async function fill(password = NEW_PASSWORD, confirm = password) {
  await userEvent.type(await screen.findByLabelText('Nova senha'), password)
  await userEvent.type(screen.getByLabelText('Repita a nova senha'), confirm)
}

describe('reset password', () => {
  it('reads the secret from the fragment, shows the e-mail, resets and returns to the sign-in with the notice', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/password-reset/check': () => fixtures.passwordResetInfo(),
      'POST /api/v1/auth/password-reset': () => empty(204),
    })
    renderApp(`/redefinir-senha#${SECRET}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'Redefinir a senha' })).toBeInTheDocument()
    expect(screen.getByText(fixtures.passwordResetInfo().email)).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/auth/password-reset/check')[0].json()).toEqual({ token: SECRET })

    const submit = screen.getByRole('button', { name: 'Redefinir a senha' })
    await fill(NEW_PASSWORD, `${NEW_PASSWORD}x`)
    expect(screen.getByText('As senhas não conferem.')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Repita a nova senha'))
    await userEvent.type(screen.getByLabelText('Repita a nova senha'), NEW_PASSWORD)
    expect(submit).toBeEnabled()
    await userEvent.click(submit)

    expect(await screen.findByRole('heading', { level: 2, name: 'Entrar' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Senha redefinida. Entre com a nova.')
    expect(await http.requests('POST /api/v1/auth/password-reset')[0].json()).toEqual({
      token: SECRET,
      new_password: NEW_PASSWORD,
    })
  })

  it('a short password does not allow submitting', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/password-reset/check': () => fixtures.passwordResetInfo(),
    })
    renderApp(`/redefinir-senha#${SECRET}`)
    await fill('curta')
    expect(screen.getByRole('button', { name: 'Redefinir a senha' })).toBeDisabled()
  })

  it('an expired or used link shows the message without the form', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/password-reset/check': () => problem('invalid_reset_link', 401),
    })
    renderApp(`/redefinir-senha#${SECRET}`)
    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument()
  })

  it('without a secret in the address it does not query the server', async () => {
    const http = mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    renderApp('/redefinir-senha')
    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)
    expect(http.requests('POST /api/v1/auth/password-reset/check')).toHaveLength(0)
  })

  it('a link that expires between checking and resetting warns on the same screen', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/password-reset/check': () => fixtures.passwordResetInfo(),
      'POST /api/v1/auth/password-reset': () => problem('invalid_reset_link', 401),
    })
    renderApp(`/redefinir-senha#${SECRET}`)
    await fill()
    await userEvent.click(screen.getByRole('button', { name: 'Redefinir a senha' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)
  })
})
