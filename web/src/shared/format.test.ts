import { describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client'
import { fixtures } from '../test/fixtures'
import { formatBytes, formatDuration, recordingState, shortRef } from './format'

type Step = Schemas['PipelineStep']

function withSteps(status: Schemas['Recording']['status'], states: Partial<Record<Step['step'], Step['state']>>) {
  const recording = fixtures.recordingTranscribed()
  recording.status = status
  recording.pipeline = recording.pipeline.map((step) => ({ ...step, state: states[step.step] ?? step.state }))
  return recording
}

describe('formatos', () => {
  it('formata duração e tamanho', () => {
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(166_000)).toBe('2 min 46 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
    expect(formatDuration(null)).toBe('—')
    expect(formatBytes(11_604_992)).toBe('11,1 MB')
  })
})

describe('estado da gravação', () => {
  it('pronta quando o pipeline terminou, com o aviso de resumo que falhou', () => {
    expect(recordingState(fixtures.recordingTranscribed())).toEqual({
      state: 'ready',
      label: 'Pronta',
      tone: 'success',
      noSummary: false,
    })
    expect(recordingState(withSteps('transcribed', { summary: 'failed' }))).toMatchObject({
      state: 'ready',
      noSummary: true,
    })
    // Etapa pulada (sem provider, sem tipo) não segura a gravação.
    expect(recordingState(withSteps('transcribed', { summary: 'skipped', fields: 'skipped' })).state).toBe('ready')
  })

  it('falhou quando a gravação, a transcrição ou o pré-processamento falhou', () => {
    for (const recording of [
      withSteps('failed', {}),
      withSteps('processing', { transcription: 'failed' }),
      withSteps('processing', { preprocessing: 'failed' }),
    ]) {
      expect(recordingState(recording)).toMatchObject({ state: 'failed', label: 'Falhou', tone: 'danger' })
    }
  })

  it('em andamento mostra a etapa corrente em palavra', () => {
    const busy = (recording: Schemas['Recording']) => {
      const state = recordingState(recording)
      expect(state.state).toBe('busy')
      expect(state.tone).toBe('progress')
      return state.label
    }
    expect(busy(withSteps('uploading', { preprocessing: 'pending', transcription: 'pending' }))).toBe('Enviando')
    expect(busy(withSteps('queued', { preprocessing: 'pending', transcription: 'pending' }))).toBe('Na fila')
    expect(busy(withSteps('processing', { preprocessing: 'active', transcription: 'pending' }))).toBe('Pré-processando')
    expect(busy(withSteps('processing', { transcription: 'active' }))).toBe('Transcrevendo')
    expect(busy(withSteps('processing', { transcription: 'pending' }))).toBe('Transcrevendo')
    expect(busy(withSteps('transcribed', { fields: 'active', agenda_type: 'pending', summary: 'pending' }))).toBe(
      'Preenchendo campos',
    )
    expect(busy(withSteps('transcribed', { agenda_type: 'active', summary: 'pending' }))).toBe('Detectando o tipo')
    expect(busy(withSteps('transcribed', { summary: 'active' }))).toBe('Resumindo')
    // Transcrita, com uma etapa depois dela ainda na fila.
    expect(busy(withSteps('transcribed', { summary: 'pending' }))).toBe('Resumindo')
  })
})

describe('shortRef', () => {
  it('são os 8 primeiros caracteres do id, sem os hífens', () => {
    expect(shortRef('01928f3a-1c00-7a00-8000-000000000101')).toBe('01928f3a')
    expect(shortRef('a-b-c')).toBe('abc')
    expect(shortRef('')).toBe('')
  })
})
