import { describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n'
import { stepLabel, stepNote } from './steps'

describe('steps in words', () => {
  it('the speakers step while waiting says it awaits you and why', () => {
    const step = { step: 'speakers', state: 'waiting', reason: 'unnamed_speakers', error: null } as const
    expect(stepLabel(step)).toBe('Locutores · aguardando você')
    expect(stepNote(step)).toMatch(/nomeie todos para seguir/)
  })

  it('the recording released without the names shows the skipped step\'s reason', () => {
    const step = { step: 'speakers', state: 'skipped', reason: 'continued_by_user', error: null } as const
    expect(stepLabel(step)).toBe('Locutores · pulada')
    expect(stepNote(step)).toBe('você seguiu sem nomear todos os locutores')
  })

  it('done, the speakers step carries only the name', () => {
    expect(stepLabel({ step: 'speakers', state: 'done' })).toBe('Locutores')
    expect(stepNote({ state: 'done', reason: null, error: null })).toBeNull()
  })

  it('in English, the step label and its state come from the shared catalog', async () => {
    await setLocale('en')
    try {
      expect(stepLabel({ step: 'speakers', state: 'skipped' })).toBe(`${stepLabel({ step: 'speakers', state: 'done' })} · skipped`)
      expect(stepLabel({ step: 'summary', state: 'active' })).toBe('Summarizing')
    } finally {
      await setLocale('pt-BR')
    }
  })
})
