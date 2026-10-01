// Os tipos que o núcleo Rust serializa (eclume-mobile-core); a UI é função do `EstadoApp`.

import type { FilaDaEspera } from '../app/vocabulario.js'

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

/** `reconectando`: o microfone caiu e o núcleo tenta reabri-lo; o arquivo recebe silêncio. */
export type EstadoMicrofone = 'ok' | 'reconectando'

export interface EstadoSessao {
  id: string
  iniciada_em: number
  audio_ms: number
  nivel: number
  pausada: boolean
  marcadores: Marcador[]
  microfone: EstadoMicrofone
  /** O sistema silenciou a captura (chamada, assistente de voz, bloqueio do microfone). */
  silenciada: boolean
}

/** O que a UI pede antes de gravar: o microfone (obrigatório) e as notificações. */
export interface Permissoes {
  microfone: boolean
  notificacoes: boolean
}

/** A isenção da otimização de bateria: `pedir` antes da primeira vez, `recusada` depois. */
export type IsencaoDeBateria = 'concedida' | 'pedir' | 'recusada'

/** O que o aparelho diz das permissões que ficam nas configurações do sistema. */
export interface Aparelho {
  notificacoes: boolean
  isencaoDeBateria: IsencaoDeBateria
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
  /** O título que o servidor deu depois de processar; a lista o mostra sem o título local. */
  titulo_do_servidor: string | null
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
  /** Código do motivo de uma etapa pulada (texto em `MOTIVOS` do vocabulário). */
  reason?: string | null
  /** O erro de uma etapa que falhou. */
  error?: { code: string; message: string } | null
}

export interface DetalheLocal {
  gravacao: GravacaoLocal
  caminho: string | null
  marcadores: Marcador[]
  etapas: Etapa[] | null
  /** Por que a transcrição espera na fila (`Job.queue`); a frase sai de `fraseDaEspera`. */
  espera?: FilaDaEspera | null
  /** A página da gravação no eclume web, depois de enviada. */
  endereco_na_web: string | null
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

/** Uma opção do seletor de idioma da folha "Gravação salva"; `valor` vazio é o padrão da conta. */
export interface OpcaoDeIdioma {
  valor: string
  rotulo: string
}
