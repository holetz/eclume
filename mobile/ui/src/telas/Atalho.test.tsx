import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'
import { estadoBase, marcador, ponteFalsa, type PonteFalsa } from '../ponte/falsa'
import { PonteContexto } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'

const SERVIDOR = { url: 'https://192.168.15.199:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) }

/** Abre o app com um toque pendente no atalho "Gravar agora" (consumido uma vez). */
function abrirPeloAtalho(estado: EstadoApp, rota = '/', preparar?: (ponte: PonteFalsa) => void) {
  window.location.hash = rota
  const ponte = ponteFalsa(estado)
  let pendente = true
  ponte.consumirAtalho = vi.fn(async () => {
    const gravar = pendente
    pendente = false
    return gravar
  })
  preparar?.(ponte)
  render(
    <PonteContexto.Provider value={ponte}>
      <App />
    </PonteContexto.Provider>,
  )
  return ponte
}

function voltarAoApp() {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

describe('atalho Gravar agora', () => {
  beforeEach(() => {
    window.location.hash = '/'
  })

  it('conectado e sem gravação, grava pelo mesmo fluxo do botão, uma vez', async () => {
    const ponte = abrirPeloAtalho(estadoBase(), '/configuracoes')
    await waitFor(() => expect(ponte.gravar).toHaveBeenCalledTimes(1))
    expect(ponte.permissoes).toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
    // Voltar ao app (recentes, outra Activity) não grava de novo.
    voltarAoApp()
    await waitFor(() => expect(ponte.consumirAtalho).toHaveBeenCalledTimes(2))
    expect(ponte.gravar).toHaveBeenCalledTimes(1)
  })

  it('sem o microfone, para e explica como no botão', async () => {
    const ponte = abrirPeloAtalho(estadoBase(), '/', (p) => {
      p.permissoes = vi.fn(async () => ({ microfone: false, notificacoes: true }))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Sem o microfone')
    expect(ponte.gravar).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Abrir configurações do app' })).toBeInTheDocument()
  })

  it('antes do primeiro Gravar sem a isenção, explica a bateria', async () => {
    const ponte = abrirPeloAtalho(estadoBase(), '/', (p) => {
      p.aparelho = vi.fn(async () => ({ notificacoes: true, isencaoDeBateria: 'pedir' as const }))
    })
    expect(await screen.findByRole('alertdialog', { name: 'Gravar com a tela bloqueada' })).toBeInTheDocument()
    expect(ponte.gravar).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Agora não' }))
    await waitFor(() => expect(ponte.gravar).toHaveBeenCalledTimes(1))
  })

  it('com uma gravação em curso, só mostra a tela dela', async () => {
    const sessao = {
      id: 'g1',
      iniciada_em: Date.now(),
      audio_ms: 60_000,
      nivel: 0.2,
      pausada: false,
      marcadores: [marcador(1_000)],
      microfone: 'ok' as const,
      silenciada: false,
    }
    const ponte = abrirPeloAtalho(estadoBase({ sessao }))
    expect(await screen.findByText('Gravando')).toBeInTheDocument()
    await waitFor(() => expect(ponte.consumirAtalho).toHaveBeenCalled())
    expect(ponte.gravar).not.toHaveBeenCalled()
  })

  it('sem credencial, descarta o atalho e mostra a tela de entrar', async () => {
    const ponte = abrirPeloAtalho(estadoBase({ conexao: { fase: 'sem_credencial', servidor: SERVIDOR } }))
    await waitFor(() => expect(ponte.consumirAtalho).toHaveBeenCalled())
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(ponte.gravar).not.toHaveBeenCalled()
    // Entrou depois: o toque já foi descartado e não grava sozinho.
    act(() => ponte.emitir(estadoBase()))
    voltarAoApp()
    await waitFor(() => expect(ponte.consumirAtalho).toHaveBeenCalledTimes(2))
    expect(ponte.gravar).not.toHaveBeenCalled()
  })
})
