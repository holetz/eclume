// As sete etapas do processamento da gravação em palavras, com o motivo de uma etapa pulada ou que
// falhou. Os nomes vêm do vocabulário compartilhado com o desktop e o celular (lib/vocabulario.js).
import type { Schemas } from '../../api/client'
import { ESTADOS_ETAPA, ETAPAS, motivo, nomeDaEtapa } from '../../lib/vocabulario.js'

export type PipelineStep = Schemas['PipelineStep']
type Step = PipelineStep['step']

/**
 * A etapa em palavras, legível sem a cor da barra: o nome quando concluída, o rótulo de andamento
 * quando ativa e "nome · estado" nas outras.
 */
export function stepLabel(step: Pick<PipelineStep, 'step' | 'state'>): string {
  if (step.state === 'done') return nomeDaEtapa(step.step)
  if (step.state === 'active') return ETAPAS.find((item) => item.etapa === step.step)?.andamento ?? step.step
  const state = ESTADOS_ETAPA[step.state as keyof typeof ESTADOS_ETAPA] ?? step.state
  return `${nomeDaEtapa(step.step)} · ${state}`
}

/** Por que a etapa foi pulada, falhou ou espera o dono; `null` nas outras. */
export function stepNote(step: Pick<PipelineStep, 'state' | 'reason' | 'error'>): string | null {
  if (step.state === 'failed') return step.error?.message ?? null
  if (step.state === 'skipped' || step.state === 'waiting') return step.reason ? motivo(step.reason) : null
  return null
}

/** As etapas que passaram a `done` entre duas leituras da gravação. */
export function stepsDone(before: readonly PipelineStep[], after: readonly PipelineStep[]): Step[] {
  return after
    .filter((step) => step.state === 'done' && before.find((old) => old.step === step.step)?.state !== 'done')
    .map((step) => step.step)
}
