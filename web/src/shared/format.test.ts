import { afterEach, describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client'
import { fixtures } from '../test/fixtures'
import { setLocale } from '../i18n'
import { languageLabel } from '../lib/languages'
import {
  formatBytes,
  formatDate,
  formatDuration,
  markersLabel,
  recordingState,
  shortDayLabel,
  shortRef,
  weekdayShort,
} from './format'

type Step = Schemas['PipelineStep']

function withSteps(status: Schemas['Recording']['status'], states: Partial<Record<Step['step'], Step['state']>>) {
  const recording = fixtures.recordingTranscribed()
  recording.status = status
  recording.pipeline = recording.pipeline.map((step) => ({ ...step, state: states[step.step] ?? step.state }))
  return recording
}

describe('formats', () => {
  it('formats duration and size', () => {
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(166_000)).toBe('2 min 46 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
    expect(formatDuration(null)).toBe('—')
    expect(formatBytes(11_604_992)).toBe('11,1 MB')
  })
})

describe('recording state', () => {
  it('awaiting speakers when the speakers step waits for the owner, before the pending type and summary', () => {
    const recording = withSteps('transcribed', { speakers: 'waiting', agenda_type: 'pending', fields: 'pending', summary: 'pending' })
    expect(recordingState(recording)).toEqual({
      state: 'waiting',
      label: 'Aguardando locutores',
      tone: 'warning',
      noSummary: false,
    })
  })

  it('ready when the pipeline finished, with the failed-summary notice', () => {
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
    // A skipped step (no provider, no type) does not hold the recording back.
    expect(recordingState(withSteps('transcribed', { summary: 'skipped', fields: 'skipped' })).state).toBe('ready')
  })

  it('failed when the recording, the transcription or the preprocessing failed', () => {
    for (const recording of [
      withSteps('failed', {}),
      withSteps('processing', { transcription: 'failed' }),
      withSteps('processing', { preprocessing: 'failed' }),
    ]) {
      expect(recordingState(recording)).toMatchObject({ state: 'failed', label: 'Falhou', tone: 'danger' })
    }
  })

  it('cancelled when the recording failed with a step skipped by cancellation', () => {
    const recording = withSteps('failed', {})
    recording.pipeline = recording.pipeline.map((step) =>
      step.step === 'transcription' ? { ...step, state: 'skipped', reason: 'cancelled' } : step,
    )
    expect(recordingState(recording)).toMatchObject({ state: 'failed', label: 'Cancelada', tone: 'neutral' })
  })

  it('in progress shows the current step as a word', () => {
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
    // Transcribed, with a step after it still queued.
    expect(busy(withSteps('transcribed', { summary: 'pending' }))).toBe('Resumindo')
  })
})

describe('shortRef', () => {
  it('is the first 8 characters of the id, without the hyphens', () => {
    expect(shortRef('01928f3a-1c00-7a00-8000-000000000101')).toBe('01928f3a')
    expect(shortRef('a-b-c')).toBe('abc')
    expect(shortRef('')).toBe('')
  })
})

describe('in the active locale', () => {
  afterEach(() => setLocale('pt-BR'))

  it('formats labels, dates, sizes and language names in English after a switch', async () => {
    const day = new Date(2026, 8, 26, 9, 5)
    expect(weekdayShort(day)).toBe('sáb')
    expect(markersLabel(2)).toBe('2 marcadores')
    expect(languageLabel('auto')).toBe('Detectar automaticamente')
    await setLocale('en')
    expect(weekdayShort(day)).toBe('Sat')
    expect(shortDayLabel(day)).toBe('Sat 26 Sep')
    expect(markersLabel(1)).toBe('1 marker')
    expect(markersLabel(2)).toBe('2 markers')
    expect(formatBytes(11.1 * 1024 * 1024)).toBe('11.1 MB')
    expect(formatDate(day.toISOString())).toBe('Sep 26, 2026')
    expect(recordingState(fixtures.recordingTranscribed()).label).toBe('Ready')
    expect(languageLabel('auto')).toBe('Detect automatically')
    expect(languageLabel('pt-BR')).toBe('Portuguese')
  })
})
