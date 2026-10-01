import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../app/App'
import { seguirTemaDoSistema } from '../app/tema'
import { estadoBase, gravacaoLocal, marcador, ponteFalsa, type PonteFalsa } from '../ponte/falsa'
import { PonteContexto } from '../ponte/ponte'

function abrir(rota: string, preparar?: (ponte: PonteFalsa) => void) {
  window.location.hash = rota
  const ponte = ponteFalsa(estadoBase({ pendentes: 2 }))
  preparar?.(ponte)
  render(
    <PonteContexto.Provider value={ponte}>
      <App />
    </PonteContexto.Provider>,
  )
  return ponte
}

describe('Detalhe da gravação', () => {
  it('toca o arquivo local, mostra os marcadores e as etapas no servidor', async () => {
    const ponte = abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal({ bytes: 10_000_000, duracao_ms: 54 * 60_000 }),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [marcador(4 * 60_000 + 2_000, 'Início da pauta'), marcador(41 * 60_000 + 18_000)],
        etapas: [
          { step: 'received', state: 'done' },
          { step: 'preprocessing', state: 'done' },
          { step: 'transcription', state: 'active' },
          { step: 'fields', state: 'pending' },
          { step: 'agenda_type', state: 'pending' },
          { step: 'summary', state: 'pending' },
        ],
      }
    })
    expect(await screen.findByRole('heading', { name: 'Reunião semanal' })).toBeInTheDocument()
    expect(screen.getByText('Sincronizada')).toBeInTheDocument()
    expect(document.querySelector('audio')).toHaveAttribute('src', 'asset://localhost//data/eclume/gravacoes/g1.ogg')
    expect(screen.getByText('Início da pauta')).toBeInTheDocument()
    expect(screen.getByText('Transcrição')).toHaveAttribute('data-state', 'active')
    expect(screen.getByText('Resumo')).not.toHaveAttribute('data-state')
    expect(screen.getByText('54 min · 10 MB · Opus 25 kbps · Reunião de equipe')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir deste celular' }))
    expect(ponte.excluirLocal).toHaveBeenCalledWith('g1')
    expect(screen.getByText('O servidor mantém a cópia dele.')).toBeInTheDocument()
  })

  it('aguardando, não oferece excluir nem mostra o servidor', async () => {
    abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal({ selo: 'aguardando', remote_id: null }),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [],
        etapas: null,
      }
    })
    expect(await screen.findByText('Aguardando')).toBeInTheDocument()
    expect(screen.queryByText('No servidor')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Excluir deste celular' })).not.toBeInTheDocument()
  })
})

describe('Configurações', () => {
  it('muda o sync, a qualidade e a retenção', async () => {
    const ponte = abrir('/configuracoes')
    expect(await screen.findByText('192.168.15.199:8443')).toBeInTheDocument()
    expect(screen.getByText('Cerca de 11 MB por hora')).toBeInTheDocument()
    expect(screen.getByText('1,2 GB · 9 h livres')).toBeInTheDocument()
    expect(screen.getByLabelText('Só no Wi‑Fi do servidor')).toBeDisabled()
    await userEvent.click(screen.getByLabelText('Sincronizar automaticamente'))
    expect(ponte.salvarConfiguracoes).toHaveBeenLastCalledWith({
      sync_auto: false,
      qualidade: 'padrao',
      excluir_sincronizadas: false,
    })
    await userEvent.click(screen.getByLabelText('Alta'))
    expect(await screen.findByText('Cerca de 22 MB por hora')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Excluir depois de sincronizar'))
    expect(ponte.salvarConfiguracoes).toHaveBeenLastCalledWith({
      sync_auto: false,
      qualidade: 'alta',
      excluir_sincronizadas: true,
    })
    expect(screen.getByText('eclume para Android · v0.1.0')).toBeInTheDocument()
  })

  it('mostra a isenção da otimização de bateria e pede quando falta', async () => {
    const ponte = abrir('/configuracoes', (p) => {
      p.aparelho = vi.fn(async () => ({ notificacoes: true, isencaoDeBateria: 'recusada' as const }))
    })
    expect(await screen.findByText('A otimização de bateria pode parar a gravação')).toBeInTheDocument()
    ponte.aparelho = vi.fn(async () => ({ notificacoes: true, isencaoDeBateria: 'concedida' as const }))
    await userEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    expect(ponte.pedirIsencaoDeBateria).toHaveBeenCalled()
    expect(await screen.findByText('Sem otimização de bateria')).toBeInTheDocument()
  })

  it('sair confirma e lembra das gravações aguardando e de desvincular na web', async () => {
    const ponte = abrir('/configuracoes')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair e esquecer o servidor' }))
    expect(await screen.findByText(/2 gravações aguardam o sync/)).toBeInTheDocument()
    expect(screen.getByText(/Desvincule este aparelho na web/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    await waitFor(() => expect(ponte.sair).toHaveBeenCalled())
  })

  it('oferece a versão nova do movel.json', async () => {
    const ponte = abrir('/configuracoes', (p) => {
      p.verificarAtualizacao = async () => ({ versao: '0.2.0', notas: null })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Nova versão disponível · v0.2.0' }))
    expect(ponte.atualizar).toHaveBeenCalled()
  })
})

describe('tema', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('segue o tema do sistema', () => {
    const ouvintes: ((e: { matches: boolean }) => void)[] = []
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_: string, f: (e: { matches: boolean }) => void) => ouvintes.push(f),
      removeEventListener: () => {},
    }))
    const parar = seguirTemaDoSistema()
    expect(document.documentElement.dataset.theme).toBe('dark')
    ouvintes[0]({ matches: false })
    expect(document.documentElement.dataset.theme).toBe('light')
    parar()
  })
})
