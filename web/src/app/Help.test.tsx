import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { articlesForPage, helpCatalog } from '../features/help/catalog'
import { Dialog } from './Dialog'
import { useHelpTopic } from './help'
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

function Article() {
  return <h1>Artigo aberto</h1>
}

function renderPage() {
  render(
    <MemoryRouter>
      <HelpProvider>
        <Routes>
          <Route index element={<Page />} />
          <Route path="/ajuda/:slug" element={<Article />} />
        </Routes>
      </HelpProvider>
    </MemoryRouter>,
  )
}

const drawer = () => screen.queryByRole('dialog', { name: 'Ajuda' })

describe('help drawer', () => {
  it('opens with ? outside editable fields and shows the shortcuts, with the search /', async () => {
    renderPage()
    expect(drawer()).not.toBeInTheDocument()
    await userEvent.keyboard('?')
    expect(drawer()).toBeInTheDocument()
    expect(await within(drawer()!).findByText('Buscar na ajuda')).toBeInTheDocument()
    expect(within(drawer()!).getByText('Abrir a ajuda')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fechar a ajuda' })).toHaveFocus()
  })

  it('does not open with ? inside a field', async () => {
    renderPage()
    await userEvent.type(screen.getByLabelText('Nome'), 'quem?')
    expect(drawer()).not.toBeInTheDocument()
    expect(screen.getByLabelText('Nome')).toHaveValue('quem?')
  })

  it('closes with Esc and returns focus to whoever opened it', async () => {
    renderPage()
    const button = screen.getByRole('button', { name: 'Ajuda' })
    await userEvent.click(button)
    expect(drawer()).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(drawer()).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('shows the page articles from the catalog and navigates keeping the drawer open', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Ajuda' }))
    const help = drawer()!
    expect(await within(help).findByText('Nesta página · Pessoas')).toBeInTheDocument()
    const links = within(help).getByRole('list', { name: 'Artigos sobre Pessoas' })
    const expected = articlesForPage(helpCatalog('pt-BR'), 'pessoas').map((article) => article.title)
    expect(within(links).getAllByRole('link').map((link) => link.textContent)).toEqual(expected)
    expect(expected).toContain('Como funcionam as sugestões por voz')

    await userEvent.click(within(links).getByRole('link', { name: 'Como funcionam as sugestões por voz' }))
    expect(screen.getByRole('heading', { name: 'Artigo aberto' })).toBeInTheDocument()
    expect(drawer()).toBeInTheDocument()
  })

  it('searches in the drawer, with / focusing the search, and swaps the list for the results', async () => {
    renderPage()
    await userEvent.keyboard('?')
    const search = await within(drawer()!).findByRole('searchbox', { name: 'Buscar na ajuda' })
    await userEvent.keyboard('/')
    expect(search).toHaveFocus()
    await userEvent.type(search, 'token')
    const results = within(drawer()!).getByRole('list', { name: 'Resultados da busca na ajuda' })
    const found = within(results).getAllByRole('link')
    expect(found.length).toBeGreaterThan(0)
    expect(found.length).toBeLessThanOrEqual(6)
    expect(within(results).getByRole('link', { name: 'Crie um token de acesso' })).toBeInTheDocument()
    expect(within(drawer()!).queryByText('Nesta página · Pessoas')).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'girafa')
    expect(within(drawer()!).getByText('Nada encontrado. Tente outras palavras.')).toBeInTheDocument()
  })

  it('without a HelpProvider, PageHead has no Help button', () => {
    render(<PageHead title="Pessoas" />)
    expect(screen.queryByRole('button', { name: 'Ajuda' })).not.toBeInTheDocument()
  })
})

describe('help drawer with a dialog open', () => {
  it('? does not open the drawer beneath the modal, and Esc closes only the dialog', async () => {
    const user = userEvent.setup()
    let closed = 0
    render(
      <MemoryRouter>
        <HelpProvider>
          <Dialog title="Novo token" onClose={() => closed++}>
            <button type="button">Criar</button>
          </Dialog>
        </HelpProvider>
      </MemoryRouter>,
    )
    await user.keyboard('?')
    expect(drawer()).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(closed).toBe(1)
  })
})
