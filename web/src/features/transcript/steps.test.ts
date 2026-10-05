import { describe, expect, it } from 'vitest'
import { stepLabel, stepNote } from './steps'

describe('etapas em palavras', () => {
  it('a etapa de locutores em espera diz que aguarda você e por quê', () => {
    const step = { step: 'speakers', state: 'waiting', reason: 'unnamed_speakers', error: null } as const
    expect(stepLabel(step)).toBe('Locutores · aguardando você')
    expect(stepNote(step)).toMatch(/nomeie todos para seguir/)
  })

  it('a gravação solta sem os nomes mostra o motivo da etapa pulada', () => {
    const step = { step: 'speakers', state: 'skipped', reason: 'continued_by_user', error: null } as const
    expect(stepLabel(step)).toBe('Locutores · pulada')
    expect(stepNote(step)).toBe('você seguiu sem nomear todos os locutores')
  })

  it('concluída, a etapa de locutores leva só o nome', () => {
    expect(stepLabel({ step: 'speakers', state: 'done' })).toBe('Locutores')
    expect(stepNote({ state: 'done', reason: null, error: null })).toBeNull()
  })
})
