import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './Dialog'
import { MenuButton } from './MenuButton'
import { readStored, writeStored } from './storage'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
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
  it('leva o foco ao primeiro controle, prende o Tab, trava a rolagem e devolve o foco ao fechar com Esc', async () => {
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

  it('fecha no clique no fundo e no Fechar, e quem monta pode recusar', async () => {
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
})

describe('ConfirmDialog', () => {
  it('foca Cancelar, confirma com o botão de perigo e espera a mutação', async () => {
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

  it('abre pelo teclado, navega com setas, Home e End, e escolhe com Enter', async () => {
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

  it('não escolhe item desabilitado, fecha com Esc e com clique fora', async () => {
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
  it('lê, grava e apaga, e tolera o localStorage que lança', () => {
    writeStored('k', 'v')
    expect(readStored('k')).toBe('v')
    writeStored('k', null)
    expect(readStored('k')).toBeNull()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado')
    })
    expect(readStored('k')).toBeNull()
    expect(() => writeStored('k', 'v')).not.toThrow()
  })
})
