import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../app/App'
import { estadoBase, gravacaoLocal, ponteFalsa, type PonteFalsa } from '../ponte/falsa'
import { PonteContexto } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'

function abrir(estado: EstadoApp, preparar?: (ponte: PonteFalsa) => void) {
  const ponte = ponteFalsa(estado)
  preparar?.(ponte)
  render(
    <PonteContexto.Provider value={ponte}>
      <App />
    </PonteContexto.Provider>,
  )
  return ponte
}

describe('Início', () => {
  beforeEach(() => {
    window.location.hash = '/'
  })

  it('na rede do eclume, sincroniza agora e lista o celular', async () => {
    const ponte = abrir(estadoBase(), (p) => {
      p.lista = [
        gravacaoLocal(),
        gravacaoLocal({ id: 'g2', titulo: null, marcadores: 0, selo: 'aguardando', duracao_ms: 22 * 60_000 }),
      ]
    })
    expect(await screen.findByText('Na rede do eclume')).toBeInTheDocument()
    expect(await screen.findByText('Reunião semanal')).toBeInTheDocument()
    expect(screen.getByText('Sem título')).toBeInTheDocument()
    expect(screen.getByText(/54 min · 3 marcadores$/)).toBeInTheDocument()
    expect(screen.getByText('Sincronizada')).toHaveClass('badge-success')
    expect(screen.getByText('Aguardando')).toBeInTheDocument()
    expect(screen.getByText('Tudo sincronizado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sincronizar agora' }))
    expect(ponte.sincronizarAgora).toHaveBeenCalled()
  })

  it('fora da rede, mostra quantas aguardam e que sincroniza no Wi-Fi do servidor', async () => {
    abrir(estadoBase({ rede: { estado: 'away' }, pendentes: 2 }))
    expect(await screen.findByText('Fora da rede do eclume')).toBeInTheDocument()
    expect(screen.getByText('2 aguardando')).toBeInTheDocument()
    expect(screen.getByText('Sincroniza no Wi‑Fi do servidor')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sincronizar agora' })).not.toBeInTheDocument()
  })

  it('sincronizando, mostra o andamento', async () => {
    abrir(estadoBase({ rede: { estado: 'syncing', i: 1, n: 2, pct: 64, bytes_s: 18_000_000 }, pendentes: 2 }))
    expect(await screen.findByText('Sincronizando 1 de 2')).toBeInTheDocument()
    expect(screen.getByText('64 % · 18 MB/s')).toBeInTheDocument()
    expect(screen.getByLabelText('Andamento do envio')).toHaveAttribute('value', '64')
  })

  it('grava depois de pedir o microfone', async () => {
    const ponte = abrir(estadoBase())
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(ponte.permissoes).toHaveBeenCalled()
    expect(ponte.gravar).toHaveBeenCalled()
  })

  it('sem o microfone, não grava, explica e abre as configurações do app', async () => {
    const ponte = abrir(estadoBase(), (p) => {
      p.permissoes = async () => ({ microfone: false, notificacoes: true })
    })
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem o microfone')
    expect(ponte.gravar).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir configurações do app' }))
    expect(ponte.abrirConfiguracoesDoApp).toHaveBeenCalled()
  })

  it('com as notificações bloqueadas, mostra a faixa com o atalho', async () => {
    const ponte = abrir(estadoBase(), (p) => {
      p.aparelho = async () => ({ notificacoes: false, isencaoDeBateria: 'concedida' })
    })
    expect(await screen.findByText('Notificações bloqueadas')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir configurações do app' }))
    expect(ponte.abrirConfiguracoesDoApp).toHaveBeenCalled()
  })

  it('explica a bateria antes do primeiro Gravar e pede a isenção', async () => {
    const ponte = abrir(estadoBase(), (p) => {
      p.aparelho = async () => ({ notificacoes: true, isencaoDeBateria: 'pedir' })
    })
    await waitFor(() => expect(ponte.aparelho).toBeDefined())
    await userEvent.click(await screen.findByRole('button', { name: /Gravar/ }))
    expect(await screen.findByRole('alertdialog', { name: 'Gravar com a tela bloqueada' })).toBeInTheDocument()
    expect(ponte.gravar).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    expect(ponte.pedirIsencaoDeBateria).toHaveBeenCalled()
    await waitFor(() => expect(ponte.gravar).toHaveBeenCalled())
  })

  it('com pouco espaço, avisa e exclui as sincronizadas', async () => {
    const ponte = abrir(
      estadoBase({
        avisos: {
          armazenamento: { restante: 'cerca de 40 min', sincronizadas_bytes: 1_100_000_000 },
          bateria: null,
        },
      }),
    )
    expect(await screen.findByText('Armazenamento quase cheio')).toBeInTheDocument()
    expect(screen.getByText('Cerca de 40 min de gravação.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir sincronizadas · 1,1 GB' }))
    await waitFor(() => expect(ponte.excluirSincronizadas).toHaveBeenCalled())
  })

  it('abre as configurações e o detalhe', async () => {
    abrir(estadoBase(), (p) => {
      p.lista = [gravacaoLocal()]
    })
    await userEvent.click(await screen.findByText('Reunião semanal'))
    expect(window.location.hash).toBe('#/gravacao/g1')
  })
})
