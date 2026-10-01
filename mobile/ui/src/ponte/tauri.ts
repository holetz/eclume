// A ponte real: os comandos do app (`invoke('<comando>')`) e os do plugin nativo
// (`invoke('plugin:eclume-gravador|<comando>')`), mais o leitor de QR do plugin oficial.

import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { cancel, Format, scan } from '@tauri-apps/plugin-barcode-scanner'
import type { Ponte } from './ponte'
import type { Aparelho, EstadoApp } from './tipos'

export const ponteTauri: Ponte = {
  estado: () => invoke('estado'),
  async ouvirEstado(aoMudar) {
    return listen<EstadoApp>('estado', (evento) => aoMudar(evento.payload))
  },
  descobrir: (segundos) => invoke('descobrir', { segundos }),
  conectarDescoberto: (url, ca) => invoke('conectar_descoberto', { url, ca }),
  conectarEndereco: (endereco) => invoke('conectar_endereco', { endereco }),
  confiarCa: () => invoke('confiar_ca'),
  cancelarCa: () => invoke('cancelar_ca'),
  entrar: (email, senha) => invoke('entrar', { email, senha }),
  async lerCodigo() {
    try {
      const lido = await scan({ windowed: true, formats: [Format.QRCode] })
      return lido.content
    } catch {
      return null
    }
  },
  cancelarLeitura: () => cancel(),
  parear: (texto) => invoke('parear', { texto }),
  async permissoes() {
    const estados = await invoke<Record<string, string>>('plugin:eclume-gravador|request_permissions', {
      permissions: ['microfone', 'notificacoes'],
    })
    return { microfone: estados.microfone === 'granted', notificacoes: estados.notificacoes === 'granted' }
  },
  async aparelho() {
    const aparelho = await invoke<Aparelho>('plugin:eclume-gravador|estado_do_dispositivo')
    return { notificacoes: aparelho.notificacoes, isencaoDeBateria: aparelho.isencaoDeBateria }
  },
  abrirConfiguracoesDoApp: () => invoke('plugin:eclume-gravador|abrir_configuracoes_do_app'),
  pedirIsencaoDeBateria: () => invoke('plugin:eclume-gravador|pedir_isencao_de_bateria'),
  async consumirAtalho() {
    const atalho = await invoke<{ gravar: boolean }>('plugin:eclume-gravador|consumir_atalho')
    return atalho.gravar
  },
  gravar: () => invoke('gravar'),
  pausar: () => invoke('pausar'),
  continuar: () => invoke('continuar'),
  marcar: (nota) => invoke('marcar', { nota: nota ?? null }),
  anotarMarcador: (clientId, nota) => invoke('anotar_marcador', { clientId, nota }),
  parar: () => invoke('parar'),
  salvar: (id, titulo, tipoDeAgendaId, idioma) => invoke('salvar', { id, titulo, tipoDeAgendaId, idioma }),
  sincronizarAgora: () => invoke('sincronizar_agora'),
  gravacoes: () => invoke('gravacoes'),
  gravacao: (id) => invoke('gravacao', { id }),
  urlDoArquivo: (caminho) => convertFileSrc(caminho),
  abrirNaWeb: (id) => invoke('abrir_na_web', { id }),
  excluirLocal: (id) => invoke('excluir_local', { id }),
  excluirSincronizadas: () => invoke('excluir_sincronizadas'),
  tiposDeAgenda: () => invoke('tipos_de_agenda'),
  idiomas: () => invoke('idiomas'),
  configuracoes: () => invoke('configuracoes'),
  salvarConfiguracoes: (preferencias) => invoke('salvar_configuracoes', { preferencias }),
  sair: () => invoke('sair'),
  visibilidade: (visivel) => invoke('visibilidade', { visivel }),
  async recortes() {
    const aparelho = await invoke<{ insetTopo: number; insetBase: number }>(
      'plugin:eclume-gravador|estado_do_dispositivo',
    )
    return { topo: aparelho.insetTopo, base: aparelho.insetBase }
  },
  verificarAtualizacao: () => invoke('verificar_atualizacao'),
  atualizar: () => invoke('atualizar'),
}
