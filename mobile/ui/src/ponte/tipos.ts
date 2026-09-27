// Os tipos que o núcleo Rust serializa (eclume-mobile-core); a UI é função do `EstadoApp`.

export interface Servidor {
  url: string
  nome: string
  ca_sha256: string
}

export type EstadoConexao =
  | { fase: 'sem_servidor' }
  | { fase: 'confirmar_ca'; url: string; impressao: string }
  | { fase: 'sem_credencial'; servidor: Servidor }
  | { fase: 'conectado'; servidor: Servidor }

export type EstadoRede =
  | { estado: 'away' }
  | { estado: 'on_network' }
  | { estado: 'syncing'; i: number; n: number; pct: number; bytes_s: number }
  | { estado: 'ca_mismatch' }
  | { estado: 'sem_credencial' }

export interface Marcador {
  client_id: string
  recording_id: string
  at_ms: number
  note: string | null
  created_at: number
}

export interface EstadoSessao {
  id: string
  iniciada_em: number
  audio_ms: number
  nivel: number
  pausada: boolean
  marcadores: Marcador[]
}

export interface Folha {
  id: string
  iniciada_em: number
  duracao_ms: number
  marcadores: number
}

export interface Avisos {
  armazenamento: { restante: string; sincronizadas_bytes: number } | null
  bateria: { pct: number; restante: string | null } | null
}

export interface EstadoApp {
  conexao: EstadoConexao
  rede: EstadoRede
  sessao: EstadoSessao | null
  folha: Folha | null
  pendentes: number
  avisos: Avisos
  espaco_livre: string | null
  versao: string
}

export type Selo = 'gravando' | 'aguardando' | 'sincronizando' | 'sincronizada' | 'interrompida' | 'falhou'

export interface GravacaoLocal {
  id: string
  titulo: string | null
  iniciada_em: number
  duracao_ms: number | null
  bytes: number | null
  marcadores: number
  selo: Selo
  remote_id: string | null
  apagada: boolean
  tipo_de_agenda: string | null
  ultimo_erro: string | null
}

export interface Etapa {
  step: string
  state: 'pending' | 'active' | 'done' | 'failed' | 'skipped'
}

export interface DetalheLocal {
  gravacao: GravacaoLocal
  caminho: string | null
  marcadores: Marcador[]
  etapas: Etapa[] | null
}

export interface TipoDeAgenda {
  id: string
  nome: string
}

export type Qualidade = 'padrao' | 'alta'

export interface Preferencias {
  sync_auto: boolean
  qualidade: Qualidade
  excluir_sincronizadas: boolean
}

export interface Configuracoes {
  servidor: string | null
  preferencias: Preferencias
  reter_dias: number
  uso_bytes: number
  versao: string
}

/** Um servidor achado pelo mDNS (o TXT `url`, `ca`, `v`, `name`). */
export interface Achado {
  nome: string
  url: string
  ca_sha256: string | null
}

/** Uma versão nova no `movel.json` do servidor. */
export interface Atualizacao {
  versao: string
  notas: string | null
}
