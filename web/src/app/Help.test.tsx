import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { HELP_TOPICS, useHelpTopic } from './help'
import { HelpProvider } from './HelpProvider'
import { PageHead } from './PageHead'

function Page() {
  useHelpTopic('pessoas')
  return (
    <>
      <PageHead title="Pessoas" />
      <label>
        Nome
        <input />
      </label>
    </>
  )
}

function renderPage() {
  render(
    <MemoryRouter>
      <HelpProvider>
        <Page />
      </HelpProvider>
    </MemoryRouter>,
  )
}

const drawer = () => screen.queryByRole('dialog', { name: 'Ajuda' })

afterEach(() => {
  delete HELP_TOPICS.pessoas
})

describe('gaveta de ajuda', () => {
  it('abre com ? fora de campos editáveis e mostra os atalhos', async () => {
    renderPage()
    expect(drawer()).not.toBeInTheDocument()
    await userEvent.keyboard('?')
    expect(drawer()).toBeInTheDocument()
    expect(within(drawer()!).getByText('Abrir a ajuda')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fechar a ajuda' })).toHaveFocus()
  })

  it('não abre com ? dentro de um campo', async () => {
    renderPage()
    await userEvent.type(screen.getByLabelText('Nome'), 'quem?')
    expect(drawer()).not.toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toHaveValue('quem?')
  })

  it('fecha com Esc e devolve o foco a quem abriu', async () => {
    renderPage()
    const button = screen.getByRole('button', { name: 'Ajuda' })
    await userEvent.click(button)
    expect(drawer()).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(drawer()).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('o botão Ajuda do PageHead abre a gaveta com os links da página', async () => {
    HELP_TOPICS.pessoas = { title: 'Pessoas', links: [{ label: 'Ligar um locutor a uma pessoa', to: '/ajuda/locutor' }] }
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Ajuda' }))
    const help = drawer()!
    expect(within(help).getByText('Nesta página · Pessoas')).toBeInTheDocument()
    expect(within(help).getByRole('link', { name: 'Ligar um locutor a uma pessoa' })).toHaveAttribute(
      'href',
      '/ajuda/locutor',
    )
    await userEvent.click(within(help).getByRole('button', { name: 'Fechar a ajuda' }))
    expect(drawer()).not.toBeInTheDocument()
  })

  it('sem HelpProvider, o PageHead não tem botão Ajuda', () => {
    render(<PageHead title="Pessoas" />)
    expect(screen.queryByRole('button', { name: 'Ajuda' })).not.toBeInTheDocument()
  })
})
