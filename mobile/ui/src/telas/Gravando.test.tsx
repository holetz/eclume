import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../app/App'
import { estadoBase, marcador, ponteFalsa } from '../ponte/falsa'
import { PonteContexto } from '../ponte/ponte'
import type { EstadoApp, EstadoSessao } from '../ponte/tipos'

function sessao(parcial: Partial<EstadoSessao> = {}): EstadoSessao {
  return {
    id: 'g1',
    iniciada_em: Date.now(),
    audio_ms: 42 * 60_000 + 10_000,
    nivel: 0.2,
    pausada: false,
    marcadores: [marcador(12 * 60_000 + 40_000, 'Decisão do orçamento'), marcador(31 * 60_000 + 5_000)],
    microfone: 'ok',
    silenciada: false,
    ...parcial,
  }
}

function abrir(estado: EstadoApp) {
  window.location.hash = '/'
  const ponte = ponteFalsa(estado)
  render(
    <PonteContexto.Provider value={ponte}>
      <App />
    </PonteContexto.Provider>,
  )
  return ponte
}

describe('Gravando', () => {
  it('mostra o tempo de áudio, os marcadores e pausa', async () => {
    const ponte = abrir(estadoBase({ sessao: sessao() }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    expect(screen.getByLabelText('Tempo de áudio')).toHaveTextContent('00:42:10')
    expect(screen.getByText('Espaço livre: cerca de 9 h')).toBeInTheDocument()
    expect(screen.getByText('Decisão do orçamento')).toBeInTheDocument()
    expect(screen.getByText('00:31:05')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(ponte.pausar).toHaveBeenCalled()

    act(() => ponte.emitir(estadoBase({ sessao: sessao({ pausada: true }) })))
    expect(await screen.findByText('Pausado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(ponte.continuar).toHaveBeenCalled()
  })

  it('marca na hora e a nota é opcional', async () => {
    const ponte = abrir(estadoBase({ sessao: sessao() }))
    ponte.marcar = async () => marcador(42 * 60_000 + 10_000)
    await userEvent.click(await screen.findByRole('button', { name: 'Marcador' }))
    expect(await screen.findByLabelText('Marcador em 00:42:10')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Marcador em 00:42:10'), 'Tanaka entra')
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(ponte.anotarMarcador).toHaveBeenCalledWith(`m-${42 * 60_000 + 10_000}`, 'Tanaka entra')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Adicionar' })).not.toBeInTheDocument())
  })

  it('avisa do microfone reconectando e do silêncio imposto pelo sistema', async () => {
    const ponte = abrir(estadoBase({ sessao: sessao() }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    expect(screen.queryByText('Microfone reconectando')).not.toBeInTheDocument()

    act(() => ponte.emitir(estadoBase({ sessao: sessao({ microfone: 'reconectando' }) })))
    expect(await screen.findByText('Microfone reconectando')).toBeInTheDocument()

    act(() => ponte.emitir(estadoBase({ sessao: sessao({ microfone: 'reconectando', silenciada: true }) })))
    expect(await screen.findByText('Silenciado pelo sistema')).toBeInTheDocument()
    expect(screen.queryByText('Microfone reconectando')).not.toBeInTheDocument()

    act(() => ponte.emitir(estadoBase({ sessao: sessao() })))
    await waitFor(() => expect(screen.queryByText('Silenciado pelo sistema')).not.toBeInTheDocument())
  })

  it('avisa da bateria baixa', async () => {
    abrir(
      estadoBase({
        sessao: sessao(),
        avisos: { armazenamento: null, bateria: { pct: 12, restante: 'cerca de 50 min' } },
      }),
    )
    expect(await screen.findByText('Bateria em 12 %')).toBeInTheDocument()
    expect(screen.getByText(/Dá para cerca de 50 min\. A gravação fica salva se o celular desligar\./)).toBeInTheDocument()
  })

  it('para e a folha salva título e tipo de agenda, ou pula', async () => {
    const ponte = abrir(estadoBase({ sessao: sessao() }))
    await userEvent.click(await screen.findByRole('button', { name: 'Parar' }))
    expect(ponte.parar).toHaveBeenCalled()

    const folha = { id: 'g1', iniciada_em: new Date(2026, 8, 26, 10, 42).getTime(), duracao_ms: 72 * 60_000, marcadores: 2 }
    act(() => ponte.emitir(estadoBase({ folha })))
    expect(await screen.findByRole('heading', { name: 'Gravação salva' })).toBeInTheDocument()
    expect(screen.getByText('1 h 12 min · 2 marcadores · neste celular')).toBeInTheDocument()
    expect(screen.getByLabelText('Título (opcional)')).toHaveAttribute('placeholder', 'sáb 26 set, 10:42')
    await userEvent.type(screen.getByLabelText('Título (opcional)'), 'Visita ao cliente')
    await userEvent.click(await screen.findByRole('button', { name: 'Visita ao cliente' }))
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(ponte.salvar).toHaveBeenCalledWith('g1', 'Visita ao cliente', 't2')

    await userEvent.click(screen.getByRole('button', { name: 'Pular' }))
    expect(ponte.salvar).toHaveBeenLastCalledWith('g1', null, null)
  })
})
