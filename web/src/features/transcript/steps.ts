// The recording's seven processing steps in words, with the reason for a step that was skipped or that
// failed. The names are the pipeline vocabulary of the `shared` catalog, which in pt-BR is the one the desktop
// and the phone show (lib/vocabulario.js).
import type { Schemas } from '../../api/client'
import { i18n } from '../../i18n'
import { reasonText, stepName, stepStateLabel, type StepState } from '../../shared/format'

const STATES: readonly string[] = ['pending', 'active', 'done', 'skipped', 'failed', 'waiting']

export type PipelineStep = Schemas['PipelineStep']
type Step = PipelineStep['step']

/**
 * The step in words, readable without the bar's color: the name when done, the progress label
 * when active and "name · state" in the others.
 */
export function stepLabel(step: Pick<PipelineStep, 'step' | 'state'>): string {
  const name = stepName(step.step)
  if (step.state === 'done') return name
  if (step.state === 'active') return name === step.step ? step.step : i18n.t(`shared:busy.${step.step}`)
  const state = STATES.includes(step.state) ? stepStateLabel(step.state as StepState) : step.state
  return `${name} · ${state}`
}

/** Why the step was skipped, failed or waits for the owner; `null` in the others. */
export function stepNote(step: Pick<PipelineStep, 'state' | 'reason' | 'error'>): string | null {
  if (step.state === 'failed') return step.error?.message ?? null
  if (step.state === 'skipped' || step.state === 'waiting') return step.reason ? reasonText(step.reason) : null
  return null
}

/** The steps that moved to `done` between two reads of the recording. */
export function stepsDone(before: readonly PipelineStep[], after: readonly PipelineStep[]): Step[] {
  return after
    .filter((step) => step.state === 'done' && before.find((old) => old.step === step.step)?.state !== 'done')
    .map((step) => step.step)
}
