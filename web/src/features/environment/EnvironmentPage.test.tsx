import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.unstubAllGlobals()
  for (const name of ['data-theme', 'data-density', 'data-motion']) document.documentElement.removeAttribute(name)
})

async function openEnvironment() {
  mockFetch({ 'GET /api/v1/me': () => fixtures.me() })
  renderApp('/config/ambiente')
  expect(await screen.findByRole('heading', { level: 1, name: 'Ambiente' })).toBeInTheDocument()
}

describe('tela Ambiente', () => {
  it('troca tema, densidade e movimento, aplica na hora e guarda neste navegador', async () => {
    await openEnvironment()
    const user = userEvent.setup()

    await user.click(within(screen.getByRole('radiogroup', { name: 'Tema' })).getByRole('radio', { name: 'Escuro' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('eclume-tema')).toBe('dark')

    await user.click(within(screen.getByRole('radiogroup', { name: 'Densidade' })).getByRole('radio', { name: 'Compacta' }))
    expect(document.documentElement).toHaveAttribute('data-density', 'compact')
    expect(localStorage.getItem('eclume-densidade')).toBe('compact')

    await user.click(within(screen.getByRole('radiogroup', { name: 'Movimento' })).getByRole('radio', { name: 'Reduzir' }))
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce')
  })

  it('ajusta o expediente sem deixar o fim antes do início', async () => {
    await openEnvironment()
    const user = userEvent.setup()
    const start = screen.getByRole('combobox', { name: 'Início' })
    const end = screen.getByRole('combobox', { name: 'Fim' })
    expect(start).toHaveValue('8')
    expect(end).toHaveValue('18')

    await user.selectOptions(start, '19')
    expect(end).toHaveValue('20')
    expect(localStorage.getItem('eclume-expediente')).toBe('19-20')

    await user.selectOptions(end, '7')
    expect(start).toHaveValue('6')
    expect(localStorage.getItem('eclume-expediente')).toBe('6-7')
  })

  it('escolhe a visão de abertura da biblioteca e restaura os padrões', async () => {
    await openEnvironment()
    const user = userEvent.setup()
    const opening = screen.getByRole('radiogroup', { name: 'Abrir a biblioteca em' })
    await user.click(within(opening).getByRole('radio', { name: 'Mês' }))
    expect(localStorage.getItem('eclume-biblioteca-abertura')).toBe('mes')
    await user.click(within(screen.getByRole('radiogroup', { name: 'Densidade' })).getByRole('radio', { name: 'Compacta' }))

    await user.click(screen.getByRole('button', { name: 'Restaurar os padrões' }))
    expect(screen.getByRole('status')).toHaveTextContent('Tudo voltou ao padrão.')
    expect(within(opening).getByRole('radio', { name: 'Última usada' })).toBeChecked()
    expect(localStorage.getItem('eclume-biblioteca-abertura')).toBeNull()
    expect(document.documentElement).not.toHaveAttribute('data-density')
  })

  it('lista os atalhos de teclado', async () => {
    await openEnvironment()
    expect(screen.getByText('Abre a ajuda da página em que você está')).toBeInTheDocument()
    expect(screen.getByText('Aproxima ou afasta as horas na semana da biblioteca')).toBeInTheDocument()
  })
})
