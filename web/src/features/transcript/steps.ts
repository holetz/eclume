// The recording's seven processing steps in words, with the reason for a step that was skipped or that
// failed. The names come from the vocabulary shared with the desktop and the phone (lib/vocabulario.js).
import type { Schemas } from '../../api/client'
import { ESTADOS_ETAPA, ETAPAS, motivo, nomeDaEtapa } from '../../lib/vocabulario.js'

export type PipelineStep = Schemas['PipelineStep']
type Step = PipelineStep['step']

/**
 * The step in words, readable without the bar's color: the name when done, the progress label
 * when active and "name · state" in the others.
 */
export function stepLabel(step: Pick<PipelineStep, 'step' | 'state'>): string {
  if (step.state === 'done') return nomeDaEtapa(step.step)
  if (step.state === 'active') return ETAPAS.find((item) => item.etapa === step.step)?.andamento ?? step.step
  const state = ESTADOS_ETAPA[step.state as keyof typeof ESTADOS_ETAPA] ?? step.state
  return `${nomeDaEtapa(step.step)} · ${state}`
}

/** Why the step was skipped, failed or waits for the owner; `null` in the others. */
export function stepNote(step: Pick<PipelineStep, 'state' | 'reason' | 'error'>): string | null {
  if (step.state === 'failed') return step.error?.message ?? null
  if (step.state === 'skipped' || step.state === 'waiting') return step.reason ? motivo(step.reason) : null
  return null
}

/** The steps that moved to `done` between two reads of the recording. */
export function stepsDone(before: readonly PipelineStep[], after: readonly PipelineStep[]): Step[] {
  return after
    .filter((step) => step.state === 'done' && before.find((old) => old.step === step.step)?.state !== 'done')
    .map((step) => step.step)
}
