import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/conta'))

afterEach(() => vi.unstubAllGlobals())

const NEW = 'uma-senha-nova-bem-longa'

const base = {
  'GET /api/v1/me': () => fixtures.me(),
  'GET /api/v1/privacy': () => fixtures.privacyInfo(),
  'GET /api/v1/me/voice-assignment': () => fixtures.voiceAssignment(),
  'GET /api/v1/me/transcription': () => fixtures.transcriptionPreference(),
  'GET /api/v1/me/audio-retention': () => fixtures.audioRetention(),
}

describe('account', () => {
  it('chooses the transcription language, with the server default named', async () => {
    const http = mockFetch({
      ...base,
      'PATCH /api/v1/me/transcription': () => ({ language: null, platform_default: 'pt' }),
    })
    renderApp('/config/conta')
    const select = await screen.findByLabelText('Idioma das gravações')
    expect(select).toHaveValue('en')
    expect(within(select).getByRole('option', { name: 'Padrão do servidor: Português' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /^Automático/ })).not.toBeInTheDocument()
    await userEvent.selectOptions(select, 'Padrão do servidor: Português')
    await waitFor(() => expect(http.requests('PATCH /api/v1/me/transcription')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/me/transcription')[0].json()).toEqual({ language: null })
    await waitFor(() => expect(select).toHaveValue(''))
  })

  it('sets the audio retention, showing the ceiling and the irreversibility warning', async () => {
    const http = mockFetch({
      ...base,
      'GET /api/v1/me/audio-retention': () => ({ days: null, max_days: 90, effective_days: null }),
      'PATCH /api/v1/me/audio-retention': () => ({ days: 45, max_days: 90, effective_days: 45 }),
    })
    renderApp('/config/conta')
    const form = await screen.findByRole('form', { name: 'Retenção do áudio' })
    expect(within(form).getByText(/irreversível/)).toBeInTheDocument()
    expect(within(form).getByText(/até 14 dias/)).toBeInTheDocument()
    expect(within(form).getByText('O administrador limitou a retenção a 90 dias.')).toBeInTheDocument()
    expect(within(form).getByRole('switch')).not.toBeChecked()
    expect(within(form).getByRole('button', { name: 'Salvar' })).toBeDisabled()

    await userEvent.click(within(form).getByRole('switch'))
    const days = within(form).getByLabelText('Dias até apagar o áudio')
    await userEvent.clear(days)
    await userEvent.type(days, '45')
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar' }))
    expect(await within(form).findByRole('status')).toHaveTextContent('Retenção salva.')
    expect(await http.requests('PATCH /api/v1/me/audio-retention')[0].json()).toEqual({ days: 45 })
  })

  it('turns retention off by sending null days', async () => {
    const http = mockFetch({
      ...base,
      'PATCH /api/v1/me/audio-retention': () => ({ days: null, max_days: 90, effective_days: null }),
    })
    renderApp('/config/conta')
    const form = await screen.findByRole('form', { name: 'Retenção do áudio' })
    const toggle = within(form).getByRole('switch')
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    await userEvent.click(within(form).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/me/audio-retention')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/me/audio-retention')[0].json()).toEqual({ days: null })
  })

  it('shows the account and changes the password, checking the repetition', async () => {
    const http = mockFetch({
      ...base,
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

  it('changes the password keeping devices and tokens when the box is unchecked', async () => {
    const http = mockFetch({
      ...base,
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

  it('shows the wrong current password on the field', async () => {
    mockFetch({
      ...base,
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

  it('deletes the account only with the password and the confirmation checked, and returns to the sign-in with the notice', async () => {
    const http = mockFetch({
      ...base,
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

  it('shows where each piece of data goes and how much voice the account keeps', async () => {
    mockFetch(base)
    renderApp('/config/conta')
    const section = await screen.findByRole('region', { name: 'Privacidade e dados' })
    expect(await within(section).findByText('Resumos')).toBeInTheDocument()
    const value = (term: string) => within(section).getByText(term).nextElementSibling
    expect(value('Áudio e transcrição')).toHaveTextContent('Guardados neste servidor')
    expect(value('Transcrição do áudio')).toHaveTextContent('Neste servidor')
    expect(value('Resumos')).toHaveTextContent('Fora do servidor: Anthropic')
    expect(value('Campos')).toHaveTextContent('Na rede local')
    expect(value('Detecção do tipo de agenda')).toHaveTextContent('Desligado')
    expect(within(section).getByText(/3 pessoas com impressão de voz, 7 amostras/)).toBeInTheDocument()
    expect(within(section).getByRole('switch', { name: 'Guardar amostras de voz desta conta' })).toBeChecked()
  })

  it('stopping keeping samples asks for confirmation before deleting', async () => {
    const http = mockFetch({
      ...base,
      'PATCH /api/v1/me/voice-assignment': () => ({
        ...fixtures.voiceAssignment(),
        keep_samples: false,
        sample_count: 0,
        voiceprint_people: 0,
      }),
    })
    renderApp('/config/conta')
    const keep = await screen.findByRole('switch', { name: 'Guardar amostras de voz desta conta' })
    await userEvent.click(keep)
    const dialog = await screen.findByRole('dialog', { name: 'Deixar de guardar amostras de voz?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(http.requests('PATCH /api/v1/me/voice-assignment')).toHaveLength(0)
    expect(keep).toBeChecked()

    await userEvent.click(keep)
    const again = await screen.findByRole('dialog', { name: 'Deixar de guardar amostras de voz?' })
    await userEvent.click(within(again).getByRole('button', { name: 'Apagar e deixar de guardar' }))
    await waitFor(() => expect(keep).not.toBeChecked())
    expect(await http.requests('PATCH /api/v1/me/voice-assignment')[0].json()).toEqual({ keep_samples: false })
    expect(screen.getByText(/0 pessoas com impressão de voz, 0 amostras/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('without voice identification on the platform, shows the counts without the switch', async () => {
    mockFetch({
      ...base,
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), platform_enabled: false }),
    })
    renderApp('/config/conta')
    expect(await screen.findByText(/pessoas com impressão de voz/)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Guardar amostras de voz desta conta' })).not.toBeInTheDocument()
  })
})
