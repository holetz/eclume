import { ApiError } from '../../api/problem'

// Rótulos em pt-BR dos valores do contrato. Valor desconhecido aparece cru (o contrato só cresce).
type Option = { value: string; label: string; hint?: string }

export const ENGINES: readonly Option[] = [
  { value: 'whisperx-local', label: 'WhisperX (GPU)', hint: 'Padrão: na GPU do servidor, com alinhamento por palavra e separação de locutores.' },
  { value: 'openai-compatible', label: 'Remoto (OpenAI-compatível)', hint: 'Um servidor como o speaches; exige o endereço.' },
  { value: 'cpu', label: 'CPU', hint: 'faster-whisper na CPU, só para desenvolvimento: lento e sem separação de locutores.' },
]

export const MODELS = ['large-v3-turbo', 'large-v3', 'medium', 'small'] as const

// `float16` fica de fora: a GTX 16xx dá NaN nele, e o server o recusa.
export const COMPUTE_TYPES: readonly Option[] = [
  { value: 'int8_float16', label: 'int8_float16 (recomendado na GTX 1660)' },
  { value: 'int8', label: 'int8' },
  { value: 'int8_float32', label: 'int8_float32' },
  { value: 'float32', label: 'float32 (mais VRAM)' },
]

export const DENOISE_METHODS: readonly Option[] = [
  { value: 'rnnoise', label: 'RNNoise' },
  { value: 'afftdn', label: 'afftdn' },
]

/** Para que um provider serve (`used_for`); cada finalidade tem um provider só. */
export const PURPOSES: readonly Option[] = [
  { value: 'summaries', label: 'Resumos' },
  { value: 'fields', label: 'Preenchimento de campos' },
  { value: 'chat', label: 'Chat do resumo' },
  { value: 'agenda_detection', label: 'Detecção do tipo de agenda' },
]

export const PROVIDER_KINDS: readonly Option[] = [
  { value: 'claude-cli', label: 'Claude Code do servidor', hint: 'Roda o claude -p no servidor, autenticado pelo token do Claude; sem endereço.' },
  { value: 'anthropic', label: 'API da Anthropic', hint: 'Sem chave própria, usa o segredo anthropic_api_key.' },
  { value: 'openai-compatible', label: 'OpenAI-compatível', hint: 'DeepSeek, Groq, OpenRouter; exige o endereço.' },
  { value: 'ollama', label: 'Ollama', hint: 'Roda só com a fila da GPU vazia; exige o endereço.' },
]

export const MODEL_PLACEHOLDERS: Record<string, string> = {
  'claude-cli': 'sonnet',
  anthropic: 'claude-sonnet-4-5',
  'openai-compatible': 'deepseek-chat',
  ollama: 'qwen2.5:7b',
}

export const NEEDS_BASE_URL = new Set(['ollama', 'openai-compatible'])

type ProviderSecret = { label: string; stored: string; missing: string; clear: string; help?: string }

const API_KEY: ProviderSecret = {
  label: 'Chave de API',
  stored: 'Guardada',
  missing: 'Sem chave',
  clear: 'Apagar a chave guardada',
}

/** O segredo que cada tipo de provider pede: o `claude-cli` autentica pelo token do `claude setup-token`. */
const PROVIDER_SECRETS: Record<string, ProviderSecret> = {
  'claude-cli': {
    label: 'Token do Claude',
    stored: 'Token guardado',
    missing: 'Sem token',
    clear: 'Apagar o token guardado',
    help:
      'Num computador com o Claude Code logado na assinatura, rode claude setup-token, autorize no navegador e cole aqui o token sk-ant-oat01-… que ele imprime. Vale 1 ano: quando os resumos falharem por autenticação, gere outro. Uma chave de API da Anthropic (sk-ant-api…) também serve.',
  },
}

export function providerSecret(kind: string): ProviderSecret {
  return PROVIDER_SECRETS[kind] ?? API_KEY
}

export const SECRET_INFO: Record<string, { label: string; hint: string }> = {
  hf_token: {
    label: 'Token do Hugging Face',
    hint: 'Baixa os modelos do pyannote. A conta precisa ter aceitado os termos de pyannote/speaker-diarization-community-1.',
  },
  anthropic_api_key: {
    label: 'Chave da API da Anthropic',
    hint: 'Usada pelos providers “API da Anthropic” cadastrados sem chave própria.',
  },
}

export function labelOf(options: readonly Option[], value: string | null | undefined): string {
  if (value == null) return '—'
  return options.find((option) => option.value === value)?.label ?? value
}

export interface SpeakerPreset {
  value: string
  label: string
  min: number | null
  max: number | null
  custom?: boolean
}

/** "Pessoas esperadas" de Locutores: cada opção fixa `min_speakers` e `max_speakers`. */
export const SPEAKER_PRESETS: readonly SpeakerPreset[] = [
  { value: 'detectar', label: 'Detectar', min: null, max: null },
  { value: '2', label: '2', min: 2, max: 2 },
  { value: '3-6', label: '3–6', min: 3, max: 6 },
  { value: '7+', label: '7+', min: 7, max: null },
]

type SpeakerRange = { min_speakers: number | null; max_speakers: number | null }

/** A opção do valor salvo; fora das opções, "Personalizado", que o preserva até o admin trocar. */
export function speakerPreset({ min_speakers: min, max_speakers: max }: SpeakerRange): SpeakerPreset {
  return (
    SPEAKER_PRESETS.find((preset) => preset.min === min && preset.max === max) ?? {
      value: 'personalizado',
      label: `Personalizado (${min ?? '…'}–${max ?? '…'})`,
      min,
      max,
      custom: true,
    }
  )
}

const lastChange = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

/** "Última alteração por <admin> em <data>", abaixo dos forms da configuração da plataforma. */
export function lastChangeText(settings: { updated_at: string; updated_by: { name: string } | null }): string {
  return settings.updated_by
    ? `Última alteração por ${settings.updated_by.name} em ${lastChange.format(new Date(settings.updated_at))}.`
    : 'Configuração padrão, ainda não alterada.'
}

/** Número de um campo opcional: vazio vira `null`. */
export function optionalInt(value: string): number | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : Number.parseInt(trimmed, 10)
}

const shortDateParts = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })

/** "02 set 2026": a data curta das tabelas do painel. */
export function formatShortDate(iso: string): string {
  const parts = Object.fromEntries(shortDateParts.formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  return `${parts.day} ${parts.month.replace('.', '')} ${parts.year}`
}

/** Compara sem acento e sem caixa. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR')
}

/** As mensagens de um 422 por campo (`errors[].field`), para mostrar cada uma no seu campo. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  return Object.fromEntries((error.problem?.errors ?? []).map((e) => [e.field, e.message]))
}

/** "Resumo: <seções>": os títulos `##` das instruções, até três, ou o começo do texto. */
export function summaryOf(instructions: string): string {
  const headings = [...instructions.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim())
  if (headings.length > 0) return headings.slice(0, 3).join(', ')
  const text = instructions.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** Etapas do pipeline (holetz/eclume#33), na ordem em que rodam. */
export const STEPS: readonly Option[] = [
  { value: 'received', label: 'Recebido' },
  { value: 'preprocessing', label: 'Pré-processamento' },
  { value: 'transcription', label: 'Transcrição' },
  { value: 'fields', label: 'Preenchimento de campos' },
  { value: 'agenda_type', label: 'Tipo de agenda' },
  { value: 'summary', label: 'Resumo' },
]

/** As linhas da tabela de etapas da Saúde, sempre estas e nesta ordem. */
export const STEP_ORDER = ['preprocessing', 'transcription', 'fields', 'agenda_type', 'summary'] as const

export const SERVICES: readonly Option[] = [
  { value: 'api', label: 'Servidor da API' },
  { value: 'postgres', label: 'Postgres + pgvector' },
  { value: 'redis', label: 'Redis' },
  { value: 'storage', label: 'Armazenamento (MinIO)' },
  { value: 'gpu_worker', label: 'Worker GPU' },
  { value: 'cpu_worker', label: 'Worker CPU' },
  { value: 'mcp', label: 'Servidor MCP' },
]

export const SERVICE_STATUS: Record<string, { label: string; badge: string }> = {
  healthy: { label: 'Saudável', badge: 'badge badge-success' },
  degraded: { label: 'Degradado', badge: 'badge badge-warning' },
  down: { label: 'Fora', badge: 'badge badge-danger' },
  absent: { label: 'Ausente', badge: 'badge' },
}

/** "m:ss" de uma duração em milissegundos. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
