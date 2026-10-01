import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/cadastro'))

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
      'GET /api/v1/privacy': () => fixtures.privacyInfo(),
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
    expect(
      await screen.findByText(/os resumos e o chat são feitos fora dele, por Anthropic/),
    ).toBeInTheDocument()
    await fillSignup()
    const submit = screen.getByRole('button', { name: 'Criar conta' })
    await userEvent.click(submit)
    const checkbox = screen.getByRole('checkbox', {
      name: 'Sou responsável por pedir o consentimento das pessoas que gravo.',
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Para criar a conta, falta o aceite do aviso.')
    expect(checkbox).toHaveFocus()
    expect(http.requests('POST /api/v1/auth/signup')).toHaveLength(0)
    await userEvent.click(checkbox)
    await userEvent.click(submit)
    expect(await screen.findByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/auth/signup')[0].json()).toEqual(request)
  })

  it('senha curta não envia: diz o que falta e foca a senha', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
    })
    renderApp('/cadastro')
    await fillSignup('curta')
    await userEvent.click(screen.getByRole('checkbox'))
    const submit = screen.getByRole('button', { name: 'Criar conta' })
    expect(submit).toBeEnabled()
    await userEvent.click(submit)
    expect(screen.getByRole('alert')).toHaveTextContent('Para criar a conta, falta a senha com 12 caracteres.')
    expect(screen.getByLabelText('Senha')).toHaveFocus()
    expect(submit).toHaveAccessibleDescription('Para criar a conta, falta a senha com 12 caracteres.')
    expect(http.requests('POST /api/v1/auth/signup')).toHaveLength(0)
  })

  it('formulário vazio lista tudo o que falta, foca o nome e atualiza a lista ao preencher', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
    })
    renderApp('/cadastro')
    await userEvent.click(await screen.findByRole('button', { name: 'Criar conta' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Para criar a conta, falta o nome, o e-mail, a senha com 12 caracteres e o aceite do aviso.',
    )
    expect(screen.getByLabelText('Nome')).toHaveFocus()
    await userEvent.type(screen.getByLabelText('Nome'), request.name)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Para criar a conta, falta o e-mail, a senha com 12 caracteres e o aceite do aviso.',
    )
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
    expect(await screen.findByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
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

  it('sem destino externo, não mostra a linha do destino', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'GET /api/v1/auth/signup': () => fixtures.signupInfo(),
      'GET /api/v1/privacy': () => ({
        destinations: fixtures.privacyInfo().destinations.map((d) => ({ ...d, location: 'server', processor: null })),
      }),
    })
    renderApp('/cadastro')
    await fillSignup()
    expect(screen.queryByText(/são feitos fora dele/)).not.toBeInTheDocument()
  })
})
