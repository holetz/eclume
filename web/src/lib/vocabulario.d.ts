// Tipos do vocabulario.js (módulo ES puro, copiado byte a byte para o desktop e o celular).

export type Tom = 'neutral' | 'progress' | 'success' | 'danger' | 'warning'

export type EstadoAparelho = 'recording' | 'pending' | 'uploading' | 'uploaded' | 'interrupted' | 'failed'
export type EstadoServidor = 'na_fila' | 'em_andamento' | 'pronta' | 'falhou' | 'cancelada'
export type Etapa = 'received' | 'preprocessing' | 'transcription' | 'agenda_type' | 'fields' | 'summary'
export type EstadoEtapa = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

export const ESTADOS_APARELHO: Record<EstadoAparelho, { rotulo: string; tom: Tom }>
export const ESTADOS_SERVIDOR: Record<EstadoServidor, { rotulo: string; tom: Tom }>
export const ETAPAS: ReadonlyArray<{ etapa: Etapa; nome: string; andamento: string }>
export const ESTADOS_ETAPA: Record<EstadoEtapa, string>
export const MOTIVOS: Readonly<Record<string, string>>
export function motivo(codigo: string): string
export function nomeDaEtapa(etapa: string): string

export interface FilaDaEspera {
  reason: string
  ahead?: number | null
  account_ahead?: number | null
  estimated_start_at?: string | null
  resumes_at?: string | null
  processor?: { online: boolean; offline_since?: string | null }
}
export function fraseDaEspera(fila: FilaDaEspera | null | undefined, agora?: Date): string | null
