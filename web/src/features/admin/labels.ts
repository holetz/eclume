import { ApiError } from '../../api/problem'
import { activeLocale, i18n } from '../../i18n'

// Labels for the contract values, read from the `admin` catalog when they are shown (getters), so a
// locale switch takes effect. An unknown value shows raw (the contract only grows).
type Option = { readonly value: string; readonly label: string; readonly hint?: string }

function option(value: string, label: () => string, hint?: () => string): Option {
  const entry = {
    value,
    get label() {
      return label()
    },
  }
  if (hint) Object.defineProperty(entry, 'hint', { enumerable: true, get: hint })
  return entry
}

/** A contract value shown as is (a model name, a product name). */
const raw = (value: string, label = value) => option(value, () => label)

export const ENGINES: readonly Option[] = [
  option(
    'whisperx-local',
    () => 'WhisperX (GPU)',
    () => i18n.t('admin:option.engine.whisperx-local.hint'),
  ),
  option(
    'openai-compatible',
    () => i18n.t('admin:option.engine.openai-compatible.label'),
    () => i18n.t('admin:option.engine.openai-compatible.hint'),
  ),
  option(
    'cpu',
    () => 'CPU',
    () => i18n.t('admin:option.engine.cpu.hint'),
  ),
]

export const MODELS = ['large-v3-turbo', 'large-v3', 'medium', 'small'] as const

// `float16` is left out: the GTX 16xx gives NaN on it, and the server refuses it.
export const COMPUTE_TYPES: readonly Option[] = [
  option('int8_float16', () => i18n.t('admin:option.computeType.int8_float16')),
  raw('int8'),
  raw('int8_float32'),
  option('float32', () => i18n.t('admin:option.computeType.float32')),
]

export const DENOISE_METHODS: readonly Option[] = [raw('rnnoise', 'RNNoise'), raw('afftdn')]

/** What a provider is for (`used_for`); each purpose has a single provider. */
export const PURPOSES: readonly Option[] = [
  option('summaries', () => i18n.t('admin:option.purpose.summaries')),
  option('fields', () => i18n.t('admin:option.purpose.fields')),
  option('chat', () => i18n.t('admin:option.purpose.chat')),
  option('agenda_detection', () => i18n.t('admin:option.purpose.agenda_detection')),
]

/** The first is the type preselected on creation: one that runs in-house, never the proprietary CLI. */
export const PROVIDER_KINDS: readonly Option[] = [
  option(
    'ollama',
    () => 'Ollama',
    () => i18n.t('admin:option.providerKind.ollama.hint'),
  ),
  option(
    'openai-compatible',
    () => i18n.t('admin:option.providerKind.openai-compatible.label'),
    () => i18n.t('admin:option.providerKind.openai-compatible.hint'),
  ),
  option(
    'anthropic',
    () => i18n.t('admin:option.providerKind.anthropic.label'),
    () => i18n.t('admin:option.providerKind.anthropic.hint'),
  ),
  option(
    'claude-cli',
    () => i18n.t('admin:option.providerKind.claude-cli.label'),
    () => i18n.t('admin:option.providerKind.claude-cli.hint'),
  ),
]

export const MODEL_PLACEHOLDERS: Record<string, string> = {
  'claude-cli': 'sonnet',
  anthropic: 'claude-sonnet-4-5',
  'openai-compatible': 'deepseek-chat',
  ollama: 'qwen2.5:7b',
}

export const NEEDS_BASE_URL = new Set(['ollama', 'openai-compatible'])

type ProviderSecret = { label: string; stored: string; missing: string; clear: string; help?: string }

/** The secret each provider type asks for: `claude-cli` authenticates through the `claude setup-token` token. */
export function providerSecret(kind: string): ProviderSecret {
  if (kind === 'claude-cli') {
    return {
      label: i18n.t('admin:option.claudeToken.label'),
      stored: i18n.t('admin:option.claudeToken.stored'),
      missing: i18n.t('admin:option.claudeToken.missing'),
      clear: i18n.t('admin:option.claudeToken.clear'),
      help: i18n.t('admin:option.claudeToken.help'),
    }
  }
  return {
    label: i18n.t('admin:option.apiKey.label'),
    stored: i18n.t('admin:option.apiKey.stored'),
    missing: i18n.t('admin:option.apiKey.missing'),
    clear: i18n.t('admin:option.apiKey.clear'),
  }
}

type SecretName = 'hf_token' | 'anthropic_api_key'

function secretInfo(name: SecretName): { readonly label: string; readonly hint: string } {
  return {
    get label() {
      return i18n.t(`admin:option.secretInfo.${name}.label`)
    },
    get hint() {
      return i18n.t(`admin:option.secretInfo.${name}.hint`)
    },
  }
}

export const SECRET_INFO: Record<string, { readonly label: string; readonly hint: string }> = {
  hf_token: secretInfo('hf_token'),
  anthropic_api_key: secretInfo('anthropic_api_key'),
}

export function labelOf(options: readonly Option[], value: string | null | undefined): string {
  if (value == null) return '—'
  return options.find((option) => option.value === value)?.label ?? value
}

interface SpeakerPreset {
  readonly value: string
  readonly label: string
  readonly min: number | null
  readonly max: number | null
  readonly custom?: boolean
}

/** "Pessoas esperadas" of Locutores: each option fixes `min_speakers` and `max_speakers`. */
export const SPEAKER_PRESETS: readonly SpeakerPreset[] = [
  {
    value: 'detectar',
    get label() {
      return i18n.t('admin:option.speakers.detect')
    },
    min: null,
    max: null,
  },
  { value: '2', label: '2', min: 2, max: 2 },
  { value: '3-6', label: '3–6', min: 3, max: 6 },
  { value: '7+', label: '7+', min: 7, max: null },
]

type SpeakerRange = { min_speakers: number | null; max_speakers: number | null }

/** The option of the saved value; outside the options, "Personalizado", which preserves it until the admin changes it. */
export function speakerPreset({ min_speakers: min, max_speakers: max }: SpeakerRange): SpeakerPreset {
  return (
    SPEAKER_PRESETS.find((preset) => preset.min === min && preset.max === max) ?? {
      value: 'personalizado',
      label: i18n.t('admin:option.speakers.custom', { min: min ?? '…', max: max ?? '…' }),
      min,
      max,
      custom: true,
    }
  )
}

const formats = new Map<string, Intl.DateTimeFormat>()
const numberFormats = new Map<string, Intl.NumberFormat>()

/** One number formatter per locale and options, so a locale switch formats with the new one. */
export function numberFormat(kind: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = activeLocale()
  const key = `${locale}|${kind}`
  let format = numberFormats.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, options)
    numberFormats.set(key, format)
  }
  return format
}

/** One date formatter per locale and options, so a locale switch formats with the new one. */
export function dateFormat(kind: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = activeLocale()
  const key = `${locale}|${kind}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options)
    formats.set(key, format)
  }
  return format
}

/** The short date of a secret's last update ("02/09/2026"). */
export function formatShortDay(iso: string): string {
  return dateFormat('day', { dateStyle: 'short' }).format(new Date(iso))
}

/** "Última alteração por <admin> em <data>", below the platform configuration forms. */
export function lastChangeText(settings: { updated_at: string; updated_by: { name: string } | null }): string {
  return settings.updated_by
    ? i18n.t('admin:lastChange', {
        name: settings.updated_by.name,
        date: dateFormat('lastChange', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(settings.updated_at)),
      })
    : i18n.t('admin:defaultSettings')
}

/** Number of an optional field: empty becomes `null`. */
export function optionalInt(value: string): number | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : Number.parseInt(trimmed, 10)
}

/** "02 set 2026": the short date of the panel tables. */
export function formatShortDate(iso: string): string {
  const parts = Object.fromEntries(dateFormat('shortDate', { day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  return `${parts.day} ${parts.month.replace('.', '')} ${parts.year}`
}

/** Compares ignoring accents and case. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase(activeLocale())
}

/** The messages of a per-field 422 (`errors[].field`), to show each one on its field. */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  return Object.fromEntries((error.problem?.errors ?? []).map((e) => [e.field, e.message]))
}

/** "Resumo: <seções>": the `##` titles of the instructions, up to three, or the start of the text. */
export function summaryOf(instructions: string): string {
  const headings = [...instructions.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim())
  if (headings.length > 0) return headings.slice(0, 3).join(', ')
  const text = instructions.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** Pipeline steps (holetz/eclume#33), in the order they run. */
export const STEPS: readonly Option[] = [
  option('received', () => i18n.t('admin:option.step.received')),
  option('preprocessing', () => i18n.t('admin:option.step.preprocessing')),
  option('transcription', () => i18n.t('admin:option.step.transcription')),
  option('fields', () => i18n.t('admin:option.step.fields')),
  option('agenda_type', () => i18n.t('admin:option.step.agenda_type')),
  option('summary', () => i18n.t('admin:option.step.summary')),
]

/** The rows of the Saúde steps table, always these and in this order. */
export const STEP_ORDER = ['preprocessing', 'transcription', 'fields', 'agenda_type', 'summary'] as const

export const SERVICES: readonly Option[] = [
  option('api', () => i18n.t('admin:option.service.api')),
  raw('postgres', 'Postgres + pgvector'),
  raw('redis', 'Redis'),
  option('storage', () => i18n.t('admin:option.service.storage')),
  option('gpu_worker', () => i18n.t('admin:option.service.gpu_worker')),
  option('cpu_worker', () => i18n.t('admin:option.service.cpu_worker')),
  option('mcp', () => i18n.t('admin:option.service.mcp')),
]

type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'absent'

const serviceStatus = (status: ServiceStatus, badge: string) => ({
  badge,
  get label() {
    return i18n.t(`admin:option.serviceStatus.${status}`)
  },
})

export const SERVICE_STATUS: Record<string, { readonly label: string; readonly badge: string }> = {
  healthy: serviceStatus('healthy', 'badge badge-success'),
  degraded: serviceStatus('degraded', 'badge badge-warning'),
  down: serviceStatus('down', 'badge badge-danger'),
  absent: serviceStatus('absent', 'badge'),
}

/** "m:ss" of a duration in milliseconds. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
