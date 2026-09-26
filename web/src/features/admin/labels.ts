// Rótulos em pt-BR dos valores do contrato. Valor desconhecido aparece cru (o contrato só cresce).
import type { Schemas } from '../../api/client'

type Option = { value: string; label: string; hint?: string }

export const ENGINES: readonly Option[] = [
  { value: 'whisperx-local', label: 'WhisperX na GPU do servidor', hint: 'Padrão: ASR, alinhamento por palavra e diarização.' },
  { value: 'openai-compatible', label: 'Servidor remoto OpenAI-compatível', hint: 'Ex.: speaches; exige o endereço.' },
  { value: 'cpu', label: 'CPU (faster-whisper)', hint: 'Só para desenvolvimento: lenta e sem diarização.' },
]

export const MODELS = ['large-v3-turbo', 'large-v3', 'medium', 'small'] as const

// `float16` fica de fora: a GTX 16xx dá NaN nele, e o server o recusa.
export const COMPUTE_TYPES: readonly Option[] = [
  { value: 'int8_float16', label: 'int8_float16 (recomendado na GTX 1660)' },
  { value: 'int8', label: 'int8' },
  { value: 'int8_float32', label: 'int8_float32' },
  { value: 'float32', label: 'float32 (mais VRAM)' },
]

export const LANGUAGES: readonly Option[] = [
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
]

export const PROVIDER_KINDS: readonly Option[] = [
  { value: 'claude-cli', label: 'Claude Code do servidor', hint: 'Roda o claude -p no servidor, autenticado pelo token do Claude; sem endereço.' },
  { value: 'anthropic', label: 'API da Anthropic', hint: 'Sem chave própria, usa o segredo anthropic_api_key.' },
  { value: 'openai-compatible', label: 'OpenAI-compatível', hint: 'DeepSeek, Groq, OpenRouter; exige o endereço.' },
  { value: 'ollama', label: 'Ollama', hint: 'Roda só com a fila da GPU vazia; exige o endereço.' },
]

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
    hint: 'Libera a diarização (pyannote). A conta precisa ter aceitado os termos de pyannote/speaker-diarization-community-1.',
  },
  anthropic_api_key: {
    label: 'Chave da API da Anthropic',
    hint: 'Usada pelos providers “API da Anthropic” cadastrados sem chave própria.',
  },
}

export const ROLES: readonly Option[] = [
  { value: 'member', label: 'Membro' },
  { value: 'admin', label: 'Administrador' },
]

export const INVITATION_DAYS = [1, 7, 14, 30] as const

export function labelOf(options: readonly Option[], value: string | null | undefined): string {
  if (value == null) return '—'
  return options.find((option) => option.value === value)?.label ?? value
}

export function invitationStatus(invitation: Schemas['Invitation']): { label: string; tone: string } {
  const status =
    invitation.status ??
    (invitation.accepted_at ? 'accepted' : new Date(invitation.expires_at) <= new Date() ? 'expired' : 'pending')
  if (status === 'accepted') return { label: 'Aceito', tone: 'success' }
  if (status === 'expired') return { label: 'Expirado', tone: 'warning' }
  if (status === 'pending') return { label: 'Pendente', tone: 'progress' }
  return { label: status, tone: 'neutral' }
}

/** Número de um campo opcional: vazio vira `null`. */
export function optionalInt(value: string): number | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : Number.parseInt(trimmed, 10)
}
