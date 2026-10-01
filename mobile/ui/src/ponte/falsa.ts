// A ponte falsa dos testes: guarda um `EstadoApp` roteirizado, registra as chamadas e deixa o
// teste trocar o estado (como o evento `estado` faria) e as respostas de cada comando.

import { vi } from 'vitest'
import type { Ponte } from './ponte'
import type { Configuracoes, DetalheLocal, EstadoApp, GravacaoLocal, Marcador } from './tipos'

export function estadoBase(parcial: Partial<EstadoApp> = {}): EstadoApp {
  return {
    conexao: {
      fase: 'conectado',
      servidor: { url: 'https://192.168.15.199:8443', nome: 'eclume', ca_sha256: 'ab'.repeat(32) },
    },
    rede: { estado: 'on_network' },
    sessao: null,
    folha: null,
    pendentes: 0,
    avisos: { armazenamento: null, bateria: null },
    espaco_livre: 'cerca de 9 h',
    versao: '0.1.0',
    ...parcial,
  }
}

export function marcador(at_ms: number, note: string | null = null): Marcador {
  return { client_id: `m-${at_ms}`, recording_id: 'g1', at_ms, note, created_at: 0 }
}

export function gravacaoLocal(parcial: Partial<GravacaoLocal> = {}): GravacaoLocal {
  return {
    id: 'g1',
    titulo: 'Reunião semanal',
    titulo_do_servidor: null,
    iniciada_em: new Date(2026, 8, 26, 9, 0).getTime(),
    duracao_ms: 54 * 60_000,
    bytes: 10_000_000,
    marcadores: 3,
    selo: 'sincronizada',
    remote_id: 'r1',
    apagada: false,
    tipo_de_agenda: 'Reunião de equipe',
    ultimo_erro: null,
    ...parcial,
  }
}

export interface PonteFalsa extends Ponte {
  /** Troca o estado e avisa quem assina o evento. */
  emitir(estado: EstadoApp): void
  lista: GravacaoLocal[]
  detalhe: DetalheLocal | null
  config: Configuracoes
}

export function ponteFalsa(inicial: EstadoApp = estadoBase()): PonteFalsa {
  let atual = inicial
  const ouvintes = new Set<(estado: EstadoApp) => void>()
  const ponte: PonteFalsa = {
    lista: [],
    detalhe: null,
    config: {
      servidor: 'https://192.168.15.199:8443',
      preferencias: { sync_auto: true, qualidade: 'padrao', excluir_sincronizadas: false },
      reter_dias: 7,
      uso_bytes: 1_200_000_000,
      versao: '0.1.0',
    },
    emitir(estado) {
      atual = estado
      ouvintes.forEach((ouvinte) => ouvinte(estado))
    },
    estado: vi.fn(async () => atual),
    ouvirEstado: vi.fn(async (aoMudar) => {
      ouvintes.add(aoMudar)
      return () => ouvintes.delete(aoMudar)
    }),
    descobrir: vi.fn(async () => []),
    conectarDescoberto: vi.fn(async () => {}),
    conectarEndereco: vi.fn(async () => {}),
    confiarCa: vi.fn(async () => {}),
    cancelarCa: vi.fn(async () => {}),
    entrar: vi.fn(async () => {}),
    lerCodigo: vi.fn(async () => null),
    cancelarLeitura: vi.fn(async () => {}),
    parear: vi.fn(async () => {}),
    permissoes: vi.fn(async () => ({ microfone: true, notificacoes: true })),
    aparelho: vi.fn(async () => ({ notificacoes: true, isencaoDeBateria: 'concedida' as const })),
    abrirConfiguracoesDoApp: vi.fn(async () => {}),
    pedirIsencaoDeBateria: vi.fn(async () => {}),
    consumirAtalho: vi.fn(async () => false),
    gravar: vi.fn(async () => 'g1'),
    pausar: vi.fn(async () => {}),
    continuar: vi.fn(async () => {}),
    marcar: vi.fn(async () => marcador(1_000)),
    anotarMarcador: vi.fn(async (clientId: string, nota: string | null) => ({
      ...marcador(1_000, nota),
      client_id: clientId,
    })),
    parar: vi.fn(async () => 'g1'),
    salvar: vi.fn(async () => {}),
    sincronizarAgora: vi.fn(async () => {}),
    gravacoes: vi.fn(async () => ponte.lista),
    gravacao: vi.fn(async () => {
      if (!ponte.detalhe) throw 'gravação g1 não está no celular'
      return ponte.detalhe
    }),
    urlDoArquivo: (caminho) => `asset://localhost/${caminho}`,
    abrirNaWeb: vi.fn(async () => {}),
    excluirLocal: vi.fn(async () => {}),
    excluirSincronizadas: vi.fn(async () => 1_100_000_000),
    tiposDeAgenda: vi.fn(async () => [
      { id: 't1', nome: 'Reunião de equipe' },
      { id: 't2', nome: 'Visita ao cliente' },
    ]),
    configuracoes: vi.fn(async () => ponte.config),
    salvarConfiguracoes: vi.fn(async () => {}),
    sair: vi.fn(async () => {}),
    visibilidade: vi.fn(async () => {}),
    recortes: vi.fn(async () => ({ topo: 0, base: 0 })),
    verificarAtualizacao: vi.fn(async () => null),
    atualizar: vi.fn(async () => {}),
  }
  return ponte
}
