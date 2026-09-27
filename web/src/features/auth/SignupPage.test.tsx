import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const request = fixtures.signupRequest()

async function fillSignup(password = request.password) {
  await userEvent.type(await screen.findByLabelText('Nome'), request.name)
  await userEvent.type(screen.getByLabelText('E-mail'), request.email)
  await userEvent.type(screen.getByLabelText('Senha'), password)
}

describe('criar conta', () => {
  it('exige o aceite, cria a conta com a versão do aviso e entra na biblioteca', async () => {
    let signedUp = false
    const http = mockFetch({
      'GET /api/v1/me': () => (signedUp ? fixtures.me() : problem('unauthorized', 401)),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
      'POST /api/v1/auth/signup': () => {
        signedUp = true
        return empty(204)
      },
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
    })
    renderApp('/cadastro')
    expect(await screen.findByRole('heading', { level: 2, name: 'Criar sua conta' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('auth')
    expect(screen.getByText('Pelo menos 12 caracteres.')).toBeInTheDocument()
    await fillSignup()
    const submit = screen.getByRole('button', { name: 'Criar conta' })
    expect(submit).toBeDisabled()
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Sou responsável por pedir o consentimento das pessoas que gravo.' }),
    )
    expect(submit).toBeEnabled()
    await userEvent.click(submit)
    expect(await screen.findByRole('list', { name: 'Gravações' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/auth/signup')[0].json()).toEqual(request)
  })

  it('senha curta não deixa enviar', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
    })
    renderApp('/cadastro')
    await fillSignup('curta')
    await userEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Criar conta' })).toBeDisabled()
  })

  it('e-mail já cadastrado mostra a mensagem sem sair da tela', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
      'POST /api/v1/auth/signup': () => problem('email_taken', 409),
    })
    renderApp('/cadastro')
    await fillSignup()
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma conta com este e-mail.')
    expect(screen.getByRole('heading', { name: 'Criar sua conta' })).toBeInTheDocument()
  })

  it('cadastro fechado não mostra o formulário', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => ({ ...fixtures.signupInfo(), open: false }),
    })
    renderApp('/cadastro')
    expect(await screen.findByRole('alert')).toHaveTextContent('O cadastro está fechado neste servidor.')
    expect(screen.queryByLabelText('Senha')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/entrar')
  })

  it('com sessão, vai para a biblioteca', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
    })
    renderApp('/cadastro')
    expect(await screen.findByRole('list', { name: 'Gravações' })).toBeInTheDocument()
  })
})

describe('aceite do aviso em vigor', () => {
  it('com notice_required, pede o aceite antes do shell e libera depois', async () => {
    let accepted = false
    const http = mockFetch({
      'GET /api/v1/me': () => ({ ...fixtures.me(), notice_required: !accepted }),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
      'POST /api/v1/me/notice': () => {
        accepted = true
        return empty(204)
      },
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
    })
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Antes de continuar' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Aceitar e continuar' })
    expect(submit).toBeDisabled()
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Sou responsável por pedir o consentimento das pessoas que gravo.' }),
    )
    await userEvent.click(submit)
    expect(await screen.findByRole('navigation', { name: 'Principal' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/me/notice')[0].json()).toEqual({ notice_version: '1' })
  })
})
