import { render, screen, waitFor, within } from '@testing-library/react'
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
          { step: 'transcription', state: 'done' },
          { step: 'fields', state: 'active' },
          { step: 'agenda_type', state: 'skipped', reason: 'set_by_user' },
          { step: 'summary', state: 'pending' },
        ],
        endereco_na_web: 'https://192.168.15.199:8443/gravacoes/r1',
      }
    })
    expect(await screen.findByRole('heading', { name: 'Reunião semanal' })).toBeInTheDocument()
    expect(screen.getByText('Enviada')).toHaveClass('badge-success')
    expect(document.querySelector('audio')).toHaveAttribute('src', 'asset://localhost//data/eclume/gravacoes/g1.ogg')
    expect(screen.getByText('Início da pauta')).toBeInTheDocument()
    // As sete etapas na ordem do servidor, com o estado em palavra e o motivo visível sob a barra.
    const etapas = within(screen.getByRole('list', { name: 'Etapas no servidor' })).getAllByRole('listitem')
    expect(etapas.map((etapa) => etapa.textContent)).toEqual([
      'Áudio recebido',
      'Pré-processamento',
      'Transcrição',
      'Locutores',
      'Tipo de agenda · pulada',
      'Preenchendo campos',
      'Resumo · esperando',
    ])
    expect(etapas[5]).toHaveAttribute('data-state', 'active')
    expect(etapas[6]).not.toHaveAttribute('data-state')
    expect(within(screen.getByRole('list', { name: 'Motivos das etapas' })).getByRole('listitem')).toHaveTextContent(
      'Tipo de agenda · pulada: o tipo foi escolhido por você',
    )
    expect(screen.getByText('54 min · 10 MB · Opus 25 kbps · Reunião de equipe')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir deste celular' }))
    expect(ponte.excluirLocal).toHaveBeenCalledWith('g1')
    expect(screen.getByText('O servidor mantém a cópia dele.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Abrir na web' }))
    expect(ponte.abrirNaWeb).toHaveBeenCalledWith('g1')
  })

  it('parada à espera dos nomes dos locutores, diz que aguarda você e por quê', async () => {
    abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal(),
        caminho: null,
        marcadores: [],
        etapas: [
          { step: 'received', state: 'done' },
          { step: 'preprocessing', state: 'done' },
          { step: 'transcription', state: 'done' },
          { step: 'speakers', state: 'waiting', reason: 'unnamed_speakers' },
          { step: 'agenda_type', state: 'pending' },
          { step: 'fields', state: 'pending' },
          { step: 'summary', state: 'pending' },
        ],
        endereco_na_web: 'https://192.168.15.199:8443/gravacoes/r1',
      }
    })
    const etapas = within(await screen.findByRole('list', { name: 'Etapas no servidor' })).getAllByRole('listitem')
    expect(etapas[3]).toHaveTextContent('Locutores · aguardando você')
    expect(etapas[3]).toHaveAttribute('data-state', 'waiting')
    expect(within(screen.getByRole('list', { name: 'Motivos das etapas' })).getByRole('listitem')).toHaveTextContent(
      'Locutores · aguardando você: há locutores sem pessoa; nomeie todos para seguir com o tipo, os campos e o resumo',
    )
  })

  it('sem título dado ao parar, mostra o que o servidor deu', async () => {
    abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal({ titulo: null, titulo_do_servidor: '2026-09-26 09-00 gravação' }),
        caminho: null,
        marcadores: [],
        etapas: [],
        endereco_na_web: 'https://192.168.15.199:8443/gravacoes/r1',
      }
    })
    expect(await screen.findByRole('heading', { name: '2026-09-26 09-00 gravação' })).toBeInTheDocument()
  })

  it('na fila do servidor, diz por que a transcrição espera', async () => {
    abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal(),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [],
        etapas: [{ step: 'received', state: 'done' }],
        espera: {
          reason: 'account_turn',
          ahead: null,
          account_ahead: 1,
          estimated_start_at: null,
          resumes_at: null,
          processor: { online: true, offline_since: null },
        },
        endereco_na_web: null,
      }
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Atrás de 1 gravação sua que chegou antes.')
  })

  it('aguardando, não oferece excluir nem mostra o servidor', async () => {
    abrir('/gravacao/g1', (p) => {
      p.detalhe = {
        gravacao: gravacaoLocal({ selo: 'aguardando', remote_id: null }),
        caminho: '/data/eclume/gravacoes/g1.ogg',
        marcadores: [],
        etapas: null,
        endereco_na_web: null,
      }
    })
    expect(await screen.findByText('Aguardando envio')).toBeInTheDocument()
    expect(screen.queryByText('No servidor')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Excluir deste celular' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abrir na web' })).not.toBeInTheDocument()
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
