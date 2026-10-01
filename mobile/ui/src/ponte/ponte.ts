// A ponte da UI com o núcleo: `invoke`/`listen` tipados sobre os comandos Tauri do app e do
// plugin `gravador`. Nos testes, a ponte falsa (falsa.ts) roteiriza o mesmo contrato.

import { createContext, useContext } from 'react'
import type {
  Achado,
  Aparelho,
  Atualizacao,
  Configuracoes,
  DetalheLocal,
  EstadoApp,
  GravacaoLocal,
  Marcador,
  Permissoes,
  Preferencias,
  TipoDeAgenda,
} from './tipos'

export interface Ponte {
  estado(): Promise<EstadoApp>
  /** Assina o evento `estado`; devolve a função que cancela. */
  ouvirEstado(aoMudar: (estado: EstadoApp) => void): Promise<() => void>
  /** Procura o servidor na rede por mDNS (o plugin) durante `segundos`. */
  descobrir(segundos: number): Promise<Achado[]>
  conectarDescoberto(url: string, ca: string | null): Promise<void>
  conectarEndereco(endereco: string): Promise<void>
  confiarCa(): Promise<void>
  cancelarCa(): Promise<void>
  entrar(email: string, senha: string): Promise<void>
  /** Abre a câmera e devolve o texto do QR, ou `null` se a pessoa cancelou. */
  lerCodigo(): Promise<string | null>
  cancelarLeitura(): Promise<void>
  parear(texto: string): Promise<void>
  /** Pede microfone e notificações; devolve o que foi concedido. */
  permissoes(): Promise<Permissoes>
  /** As notificações e a isenção da otimização de bateria, como o sistema as tem agora. */
  aparelho(): Promise<Aparelho>
  /** Abre a tela do sistema com as permissões do app. */
  abrirConfiguracoesDoApp(): Promise<void>
  /** Pede a isenção da otimização de bateria (o diálogo do sistema). */
  pedirIsencaoDeBateria(): Promise<void>
  /** `true` uma vez por toque no atalho "Gravar agora" do ícone. */
  consumirAtalho(): Promise<boolean>
  gravar(): Promise<string>
  pausar(): Promise<void>
  continuar(): Promise<void>
  marcar(nota?: string | null): Promise<Marcador>
  anotarMarcador(clientId: string, nota: string | null): Promise<Marcador>
  parar(): Promise<string>
  salvar(id: string, titulo: string | null, tipoDeAgendaId: string | null): Promise<void>
  sincronizarAgora(): Promise<void>
  gravacoes(): Promise<GravacaoLocal[]>
  gravacao(id: string): Promise<DetalheLocal>
  /** A URL do arquivo local para o `<audio>` (o protocolo de assets do Tauri). */
  urlDoArquivo(caminho: string): string
  /** Abre a gravação enviada no eclume web, no navegador do sistema. */
  abrirNaWeb(id: string): Promise<void>
  excluirLocal(id: string): Promise<void>
  excluirSincronizadas(): Promise<number>
  tiposDeAgenda(): Promise<TipoDeAgenda[]>
  configuracoes(): Promise<Configuracoes>
  salvarConfiguracoes(preferencias: Preferencias): Promise<void>
  sair(): Promise<void>
  visibilidade(visivel: boolean): Promise<void>
  /** Os recortes de borda a borda do aparelho, em px CSS. */
  recortes(): Promise<{ topo: number; base: number }>
  verificarAtualizacao(): Promise<Atualizacao | null>
  atualizar(): Promise<void>
}

export const PonteContexto = createContext<Ponte | null>(null)

export function usePonte(): Ponte {
  const ponte = useContext(PonteContexto)
  if (!ponte) throw new Error('usePonte fora do PonteContexto')
  return ponte
}

/** O texto de um erro de comando (o núcleo devolve texto). */
export function mensagemDeErro(erro: unknown): string {
  if (typeof erro === 'string') return erro
  if (erro instanceof Error) return erro.message
  return 'Algo deu errado. Tente de novo.'
}
