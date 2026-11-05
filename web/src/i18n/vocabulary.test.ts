// The pipeline vocabulary the web shows comes from the `shared` catalog; the desktop and the phone read
// lib/vocabulario.js, copied byte for byte into their pillars. The pt-BR catalog must say exactly what
// that file says, so the three clients cannot drift; en is the web's own translation of the same keys.
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '.'
import { ESTADOS_APARELHO, ESTADOS_ETAPA, ETAPAS, MOTIVOS, fraseDaEspera, type FilaDaEspera } from '../lib/vocabulario.js'
import { deviceStateLabel, reasonText, stepName, stepStateLabel, waitingPhrase, type DeviceState, type StepState } from '../shared/format'
import en from './en/shared'
import ptBR from './pt-BR/shared'

describe('the pipeline vocabulary', () => {
  afterEach(() => setLocale('pt-BR'))

  it('says in pt-BR exactly what lib/vocabulario.js says', () => {
    expect(Object.fromEntries(ETAPAS.map((item) => [item.etapa, item.nome]))).toEqual(ptBR.step)
    expect(Object.fromEntries(ETAPAS.map((item) => [item.etapa, item.andamento]))).toEqual(ptBR.busy)
    expect(ESTADOS_ETAPA).toEqual(ptBR.stepState)
    expect(MOTIVOS).toEqual(ptBR.reason)
    expect(Object.fromEntries(Object.entries(ESTADOS_APARELHO).map(([state, item]) => [state, item.rotulo]))).toEqual(ptBR.device)
  })

  it('has an en text for every key', () => {
    for (const group of ['step', 'busy', 'stepState', 'reason', 'device'] as const) {
      expect(Object.keys(en[group])).toEqual(Object.keys(ptBR[group]))
    }
  })

  it('reads the labels in the active locale, and an unknown code raw', async () => {
    const states = Object.keys(ESTADOS_ETAPA) as StepState[]
    const devices = Object.keys(ESTADOS_APARELHO) as DeviceState[]
    expect(ETAPAS.map((item) => stepName(item.etapa))).toEqual(ETAPAS.map((item) => item.nome))
    expect(states.map(stepStateLabel)).toEqual(Object.values(ESTADOS_ETAPA))
    expect(Object.keys(MOTIVOS).map(reasonText)).toEqual(Object.values(MOTIVOS))
    expect(devices.map(deviceStateLabel)).toEqual(Object.values(ESTADOS_APARELHO).map((item) => item.rotulo))
    expect(reasonText('motivo_novo')).toBe('motivo_novo')
    expect(stepName('nova_etapa')).toBe('nova_etapa')
    await setLocale('en')
    expect(stepName('transcription')).toBe('Transcription')
    expect(stepStateLabel('skipped')).toBe('skipped')
    expect(reasonText('no_provider')).toBe('no agent configured; ask your administrator')
    expect(deviceStateLabel('failed')).toBe('Upload failed')
  })

  it('phrases the queue wait like fraseDaEspera in pt-BR, and in en after a switch', async () => {
    const now = new Date(2026, 9, 2, 14, 0)
    const at = (hours: number, minutes = 0, day = 2) => new Date(2026, 9, day, hours, minutes).toISOString()
    const cases: (FilaDaEspera | null)[] = [
      null,
      { reason: 'gpu', processor: { online: false } },
      { reason: 'gpu', processor: { online: false, offline_since: at(13, 5) } },
      { reason: 'gpu', processor: { online: false, offline_since: at(9, 30, 1) } },
      { reason: 'account_turn', account_ahead: 0 },
      { reason: 'account_turn' },
      { reason: 'account_turn', account_ahead: 1 },
      { reason: 'account_turn', account_ahead: 3 },
      { reason: 'quota_window', resumes_at: at(18, 40) },
      { reason: 'quota_window', resumes_at: at(8, 0, 3) },
      { reason: 'quota_window' },
      { reason: 'gpu', ahead: 0 },
      { reason: 'gpu', ahead: 2, estimated_start_at: at(14, 0) },
      { reason: 'gpu', ahead: 2, estimated_start_at: at(14, 12) },
      { reason: 'gpu', estimated_start_at: at(15, 0) },
      { reason: 'gpu', estimated_start_at: at(15, 20) },
      { reason: 'gpu' },
    ]
    expect(cases.map((queue) => waitingPhrase(queue, now))).toEqual(cases.map((queue) => fraseDaEspera(queue, now)))
    await setLocale('en')
    expect(waitingPhrase({ reason: 'gpu', ahead: 2, estimated_start_at: at(15, 20) }, now)).toBe(
      '#3 in the queue · starts in about 1 h 20 min (estimate)',
    )
    expect(waitingPhrase({ reason: 'account_turn', account_ahead: 3 }, now)).toBe('Behind 3 recordings of yours that arrived earlier.')
    expect(waitingPhrase({ reason: 'quota_window', resumes_at: at(8, 0, 3) }, now)).toBe(
      'Your transcription minutes for the last 24 h are used up; the recording goes in at 10/03 at 08:00.',
    )
  })
})
