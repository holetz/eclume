// As seis etapas do processamento da gravação em palavras, com o motivo de uma etapa pulada ou que falhou.
import type { Schemas } from '../../api/client'

export type PipelineStep = Schemas['PipelineStep']
type Step = PipelineStep['step']

const LABELS: Record<Step, { base: string; active?: string; done?: string; failed?: string }> = {
  received: { base: 'Áudio recebido' },
  preprocessing: { base: 'Pré-processamento' },
  transcription: { base: 'Transcrição', failed: 'Transcrição falhou' },
  fields: { base: 'Preenchimento de campos', active: 'Preenchendo campos', done: 'Campos preenchidos' },
  agenda_type: { base: 'Tipo de agenda' },
  summary: { base: 'Resumo', active: 'Resumindo', done: 'Resumo pronto' },
}

const REASONS: Record<string, string> = {
  no_provider: 'nenhum agente configurado para esta etapa',
  no_auto_fields: 'nenhum campo com preenchimento automático',
  no_types: 'nenhum tipo de agenda cadastrado',
  set_by_user: 'o tipo foi escolhido por você',
  no_agenda_type: 'a gravação não tem tipo de agenda',
  before_pipeline: 'gravação anterior ao processamento automático',
}

export function stepLabel(step: Pick<PipelineStep, 'step' | 'state'>): string {
  const labels = LABELS[step.step]
  if (!labels) return step.step
  if (step.state === 'active') return labels.active ?? labels.base
  if (step.state === 'done') return labels.done ?? labels.base
  if (step.state === 'failed') return labels.failed ?? labels.base
  return labels.base
}

/** Por que a etapa foi pulada ou falhou; `null` nas outras. */
export function stepNote(step: Pick<PipelineStep, 'state' | 'reason' | 'error'>): string | null {
  if (step.state === 'failed') return step.error?.message ?? null
  if (step.state === 'skipped') return step.reason ? (REASONS[step.reason] ?? step.reason) : null
  return null
}

/** As etapas que passaram a `done` entre duas leituras da gravação. */
export function stepsDone(before: readonly PipelineStep[], after: readonly PipelineStep[]): Step[] {
  return after
    .filter((step) => step.state === 'done' && before.find((old) => old.step === step.step)?.state !== 'done')
    .map((step) => step.step)
}
