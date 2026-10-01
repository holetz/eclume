import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/conta'))

afterEach(() => vi.unstubAllGlobals())

const NEW = 'uma-senha-nova-bem-longa'

describe('conta', () => {
  it('mostra a conta e troca a senha, conferindo a repetição', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'POST /api/v1/me/password': () => empty(),
    })
    renderApp('/config/conta')
    expect(await screen.findByRole('heading', { level: 1, name: 'Conta' })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText(fixtures.me().user.email)).toBeInTheDocument()

    const form = screen.getByRole('form', { name: 'Trocar a senha' })
    const submit = within(form).getByRole('button', { name: 'Trocar a senha' })
    await userEvent.type(within(form).getByLabelText('Senha atual'), 'senha-de-teste')
    await userEvent.type(within(form).getByLabelText('Nova senha'), NEW)
    await userEvent.type(within(form).getByLabelText('Repita a nova senha'), `${NEW}x`)
    expect(within(form).getByText('As duas senhas não são iguais.')).toBeInTheDocument()
    expect(submit).toBeDisabled()
    await userEvent.type(within(form).getByLabelText('Repita a nova senha'), '{Backspace}')
    await userEvent.click(submit)
    expect(await within(form).findByRole('status')).toHaveTextContent('Senha trocada.')
    expect(await http.requests('POST /api/v1/me/password')[0].json()).toEqual({
      current_password: 'senha-de-teste',
      new_password: NEW,
      revoke_tokens: true,
    })
    expect(within(form).getByRole('status')).toHaveTextContent('os aparelhos ligados e os tokens')
    expect(within(form).getByLabelText('Senha atual')).toHaveValue('')
  })

  it('troca a senha mantendo aparelhos e tokens quando a caixa é desmarcada', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'POST /api/v1/me/password': () => empty(),
    })
    renderApp('/config/conta')
    const form = await screen.findByRole('form', { name: 'Trocar a senha' })
    const revoke = within(form).getByRole('checkbox', { name: 'Encerrar também aparelhos e tokens' })
    expect(revoke).toBeChecked()
    await userEvent.click(revoke)
    await userEvent.type(within(form).getByLabelText('Senha atual'), 'senha-de-teste')
    await userEvent.type(within(form).getByLabelText('Nova senha'), NEW)
    await userEvent.type(within(form).getByLabelText('Repita a nova senha'), NEW)
    await userEvent.click(within(form).getByRole('button', { name: 'Trocar a senha' }))
    expect(await within(form).findByRole('status')).toHaveTextContent('As outras sessões abertas')
    expect(await http.requests('POST /api/v1/me/password')[0].json()).toMatchObject({ revoke_tokens: false })
  })

  it('mostra a senha atual errada no campo', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'POST /api/v1/me/password': () =>
        problem('validation_failed', 422, { errors: [{ field: 'current_password', message: 'senha atual incorreta' }] }),
    })
    renderApp('/config/conta')
    const form = await screen.findByRole('form', { name: 'Trocar a senha' })
    await userEvent.type(within(form).getByLabelText('Senha atual'), 'errada')
    await userEvent.type(within(form).getByLabelText('Nova senha'), NEW)
    await userEvent.type(within(form).getByLabelText('Repita a nova senha'), NEW)
    await userEvent.click(within(form).getByRole('button', { name: 'Trocar a senha' }))
    await waitFor(() => expect(within(form).getByLabelText('Senha atual')).toHaveAttribute('aria-invalid', 'true'))
    expect(within(form).getByLabelText('Senha atual')).toHaveAccessibleDescription('A senha atual não confere.')
  })

  it('exclui a conta só com a senha e a confirmação marcada, e volta à entrada com o aviso', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => (http.requests('POST /api/v1/me/delete').length ? problem('unauthorized', 401) : fixtures.me()),
      'POST /api/v1/me/delete': async (request) => {
        const { password } = (await request.json()) as { password: string }
        return password === 'senha-de-teste'
          ? empty()
          : problem('validation_failed', 422, { errors: [{ field: 'password', message: 'senha incorreta' }] })
      },
    })
    renderApp('/config/conta')
    expect(await screen.findByText(/Não há como desfazer/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir minha conta' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir a conta?' })
    const confirm = within(dialog).getByRole('button', { name: 'Excluir minha conta' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Sua senha'), 'errada')
    expect(confirm).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Entendo que tudo será apagado para sempre' }))
    await userEvent.click(confirm)
    expect(await within(dialog).findByText('A senha não confere.')).toBeInTheDocument()

    await userEvent.clear(within(dialog).getByLabelText('Sua senha'))
    await userEvent.type(within(dialog).getByLabelText('Sua senha'), 'senha-de-teste')
    await userEvent.click(confirm)
    expect(await screen.findByText('Sua conta foi excluída, com todos os dados dela.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(http.requests('POST /api/v1/me/delete')).toHaveLength(2)
  })
})
