import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { CopyValue } from './CopyValue'
import { Dialog } from './Dialog'
import { HelpHint } from './HelpHint'

describe('CopyValue', () => {
  it('copia o valor e anuncia', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    render(<CopyValue value="https://eclume.local/mcp" />)
    expect(screen.getByText('https://eclume.local/mcp')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith('https://eclume.local/mcp')
    expect(screen.getByRole('status')).toHaveTextContent('Copiado')
  })

  it('avisa quando a área de transferência recusa', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('negado'))
    render(<CopyValue value="K7Q-4MX" size="lg" />)
    expect(screen.getByText('K7Q-4MX').parentElement).toHaveClass('code-block', 'code-block-lg')
    await user.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(screen.getByRole('status')).toHaveTextContent('Não foi possível copiar')
  })
})

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Excluir
      </button>
      {open && (
        <Dialog
          title="Excluir pessoa?"
          message="As transcrições ficam."
          onClose={() => setOpen(false)}
          actions={
            <button type="button" onClick={() => setOpen(false)}>
              Cancelar
            </button>
          }
        />
      )}
    </>
  )
}

describe('Dialog', () => {
  it('abre como modal com título, corpo e ações, e devolve o foco ao fechar', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    const opener = screen.getByRole('button', { name: 'Excluir' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Excluir pessoa?' })
    expect(dialog).toHaveAttribute('open')
    expect(dialog).toHaveClass('dialog')
    expect(dialog.querySelector('.dialog-body')).toHaveTextContent('As transcrições ficam.')
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('Esc (o evento cancel do navegador) fecha pelo onClose', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

function renderHint() {
  render(
    <MemoryRouter>
      <p>
        Pessoas
        <HelpHint subject="as sugestões por voz" title="Sugestões por voz" article="sugestoes-por-voz">
          Uma sugestão nunca liga sozinha.
        </HelpHint>
      </p>
      <Link to="/outra">Outra página</Link>
    </MemoryRouter>,
  )
  return screen.getByRole('button', { name: 'Sobre as sugestões por voz' })
}

describe('HelpHint', () => {
  it('abre o popover com o texto e o link para o artigo', async () => {
    const user = userEvent.setup()
    const hint = renderHint()
    expect(hint).toHaveAttribute('aria-expanded', 'false')
    await user.click(hint)
    expect(hint).toHaveAttribute('aria-expanded', 'true')
    const popover = screen.getByRole('dialog', { name: 'Sugestões por voz' })
    expect(popover).toHaveTextContent('Uma sugestão nunca liga sozinha.')
    expect(screen.getByRole('link', { name: 'Ler o artigo →' })).toHaveAttribute('href', '/ajuda/sugestoes-por-voz')
  })

  it('fecha com Esc e devolve o foco ao ?', async () => {
    const user = userEvent.setup()
    const hint = renderHint()
    await user.click(hint)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(hint).toHaveFocus()
  })

  it('fecha com clique fora e ao navegar', async () => {
    const user = userEvent.setup()
    const hint = renderHint()
    await user.click(hint)
    await user.click(screen.getByText('Pessoas'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(hint)
    await user.click(screen.getByRole('link', { name: 'Outra página' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
