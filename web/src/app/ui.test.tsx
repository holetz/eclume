import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'
import { CopyValue } from './CopyValue'
import { Dialog } from './Dialog'
import { HelpHint } from './HelpHint'
import { MenuButton } from './MenuButton'
import { readStored, writeStored } from './storage'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('CopyValue', () => {
  it('copies the value and announces it', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    render(<CopyValue value="https://eclume.local/mcp" />)
    expect(screen.getByText('https://eclume.local/mcp')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(writeText).toHaveBeenCalledWith('https://eclume.local/mcp')
    expect(screen.getByRole('status')).toHaveTextContent('Copiado')
  })

  it('warns when the clipboard refuses', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('negado'))
    render(<CopyValue value="K7Q-4MX" size="lg" />)
    expect(screen.getByText('K7Q-4MX').parentElement).toHaveClass('code-block', 'code-block-lg')
    await user.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(screen.getByRole('status')).toHaveTextContent('Não foi possível copiar')
  })
})

function DialogHarness({ refuse = false }: { refuse?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      {open && (
        <Dialog
          title="Importar arquivos"
          kicker="Biblioteca"
          onClose={() => {
            if (!refuse) setOpen(false)
          }}
          actions={<button type="button">Enviar</button>}
        >
          <input aria-label="Nome" />
        </Dialog>
      )}
    </>
  )
}

describe('Dialog', () => {
  it('moves focus to the first control, traps Tab, locks scrolling and returns focus on closing with Esc', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    const opener = screen.getByRole('button', { name: 'Abrir' })
    await user.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Importar arquivos' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.parentElement).toHaveClass('dialog-backdrop')
    expect(screen.getByText('Biblioteca')).toHaveClass('kicker')
    expect(screen.getByRole('textbox', { name: 'Nome' })).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    await user.tab()
    expect(screen.getByRole('button', { name: 'Enviar' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Fechar' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Enviar' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('closes on a backdrop click and on Fechar, and the mounting code can refuse', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<DialogHarness />)
    await user.click(screen.getByRole('button', { name: 'Abrir' }))
    await user.click(screen.getByRole('dialog').parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Abrir' }))
    await user.click(screen.getByRole('button', { name: 'Fechar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()

    render(<DialogHarness refuse />)
    await user.click(screen.getByRole('button', { name: 'Abrir' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('dialog').parentElement!)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('puts the message in .dialog-body and, with plain, the content outside it', () => {
    render(
      <Dialog title="Excluir pessoa?" message="As transcrições ficam." onClose={() => {}} plain>
        <p role="alert">Falhou.</p>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Excluir pessoa?' })
    expect(dialog.querySelector('.dialog-body')).toHaveTextContent('As transcrições ficam.')
    expect(screen.getByRole('alert').closest('.dialog-body')).toBeNull()
  })
})

describe('ConfirmDialog', () => {
  it('focuses Cancelar, confirms with the danger button and waits for the mutation', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <ConfirmDialog title="Excluir a gravação?" confirmLabel="Excluir" onConfirm={onConfirm} onCancel={onCancel}>
        Não dá para desfazer.
      </ConfirmDialog>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Excluir a gravação?' })
    expect(dialog).toHaveTextContent('Não dá para desfazer.')
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Excluir' })).toHaveClass('btn-danger')

    rerender(
      <ConfirmDialog title="Excluir a gravação?" confirmLabel="Excluir" onConfirm={onConfirm} onCancel={onCancel} busy>
        Não dá para desfazer.
      </ConfirmDialog>,
    )
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('MenuButton', () => {
  function renderMenu() {
    const picked: string[] = []
    render(
      <>
        <MenuButton
          items={[
            { key: 'txt', label: 'Transcrição', kbd: 'TXT', onSelect: () => picked.push('txt') },
            { key: 'md', label: 'Resumo', kbd: 'MD', disabled: true, onSelect: () => picked.push('md') },
            'separator',
            { key: 'docx', label: 'Transcrição e resumo', kbd: 'DOCX', onSelect: () => picked.push('docx') },
          ]}
        >
          Exportar
        </MenuButton>
        <p>fora</p>
      </>,
    )
    return picked
  }

  it('opens from the keyboard, navigates with arrows, Home and End, and picks with Enter', async () => {
    const user = userEvent.setup()
    const picked = renderMenu()
    const button = screen.getByRole('button', { name: 'Exportar' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    button.focus()
    await user.keyboard('{ArrowDown}')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveFocus()
    expect(items[0]).toHaveAttribute('data-active')
    expect(items[0]).toHaveTextContent('TXT')
    expect(screen.getByRole('separator')).toHaveClass('menu-sep')

    await user.keyboard('{ArrowUp}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(items[2]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(picked).toEqual(['docx'])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('does not pick a disabled item, closes with Esc and with an outside click', async () => {
    const user = userEvent.setup()
    const picked = renderMenu()
    const button = screen.getByRole('button', { name: 'Exportar' })
    await user.click(button)
    const disabled = screen.getByRole('menuitem', { name: /Resumo/ })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    await user.click(disabled)
    expect(picked).toEqual([])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(button).toHaveFocus()

    await user.click(button)
    await user.click(screen.getByText('fora'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('storage', () => {
  it('reads, writes and removes, and tolerates a localStorage that throws', () => {
    writeStored('k', 'v')
    expect(readStored('k')).toBe('v')
    writeStored('k', null)
    expect(readStored('k')).toBeNull()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStored('k')).toBeNull()
    expect(() => writeStored('k', 'v')).not.toThrow()
  })
})

function renderHint() {
  render(
    <MemoryRouter>
      <p>
        Pessoas
        <HelpHint subject="as sugestões por voz" title="Sugestões por voz" article="voice-suggestions">
          Uma sugestão nunca liga sozinha.
        </HelpHint>
      </p>
      <Link to="/outra">Outra página</Link>
    </MemoryRouter>,
  )
  return screen.getByRole('button', { name: 'Sobre as sugestões por voz' })
}

describe('HelpHint', () => {
  it('opens the popover with the text and the link to the article', async () => {
    const user = userEvent.setup()
    const hint = renderHint()
    expect(hint).toHaveAttribute('aria-expanded', 'false')
    await user.click(hint)
    expect(hint).toHaveAttribute('aria-expanded', 'true')
    const popover = screen.getByRole('dialog', { name: 'Sugestões por voz' })
    expect(popover).toHaveTextContent('Uma sugestão nunca liga sozinha.')
    expect(screen.getByRole('link', { name: 'Ler o artigo →' })).toHaveAttribute('href', '/ajuda/voice-suggestions')
  })

  it('closes with Esc and returns focus to the ?', async () => {
    const user = userEvent.setup()
    const hint = renderHint()
    await user.click(hint)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(hint).toHaveFocus()
  })

  it('closes with an outside click and on navigation', async () => {
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
