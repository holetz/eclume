import { createElement } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '../app/App'
import { BridgeContext } from '../bridge/bridge'
import { baseState, fakeBridge } from '../bridge/fake'
import en from './en'
import ptBR from './pt-BR'
import {
  activeLocale, deviceLocale, deviceTag, formatLocale, LOCALES, normalize,
  setLocale, subscribe, t, useLocale, useT,
  type Locale,
} from './index'
import { deviceStateLabel, deviceStateTone, reasonText, stepName, stepStateLabel, waitingPhrase } from './vocabulary'

// These calls are never run; tsc checks the public key contract.
function checkKeys() {
  t('common.cancel')
  t('vocabulary.queue.accountAhead', { count: 2 })
  t('vocabulary.queue.accountAhead_one')
  // @ts-expect-error Unknown leaves must be rejected.
  t('common.unknown')
  // @ts-expect-error Namespaces are not string leaves.
  t('vocabulary.step')
}
void checkKeys

describe('locale resolution', () => {
  it.each([
    [null, null], [undefined, null], ['', null], ['  ', null], ['fr-FR', null],
    [' EN_us ', 'en'], ['en', 'en'], ['en-GB', 'en'], ['PT_pt', 'pt-BR'],
    ['pt', 'pt-BR'], ['pt-BR', 'pt-BR'], ['english', null],
  ])('normalizes %s to %s', (tag, expected) => {
    expect(normalize(tag)).toBe(expected)
  })

  it('selects the first supported language and reports its original tag', () => {
    expect(LOCALES).toEqual(['en', 'pt-BR'])
    expect(deviceLocale(['fr', ' pt_PT ', 'en-US'])).toBe('pt-BR')
    expect(deviceTag(['fr', ' pt_PT ', 'en-US'])).toBe(' pt_PT ')
    expect(deviceLocale(['de', 'en-GB', 'pt'])).toBe('en')
    expect(deviceTag(['de', 'en-GB', 'pt'])).toBe('en-GB')
    expect(deviceLocale(['fr'])).toBe('en')
    expect(deviceTag(['fr', 'de'])).toBe('fr')
    expect(deviceLocale([])).toBe('en')
    expect(deviceTag([])).toBeNull()
    expect(deviceLocale()).toBe('pt-BR')
    expect(deviceTag()).toBe('pt-BR')
  })
})

describe('translations and subscriptions', () => {
  it.each<Locale>(['en', 'pt-BR'])('interpolates and selects plurals in %s', (locale) => {
    setLocale(locale)
    const queue = (locale === 'en' ? en : ptBR).vocabulary.queue
    expect(t('vocabulary.queue.position', { position: 4 })).toBe(queue.position.replace('{position}', '4'))
    expect(t('vocabulary.queue.accountAhead', { count: 0 })).toBe(queue.accountAhead_zero)
    expect(t('vocabulary.queue.accountAhead', { count: 1 })).toBe(queue.accountAhead_one)
    expect(t('vocabulary.queue.accountAhead', { count: 2 })).toBe(queue.accountAhead_other.replace('{count}', '2'))
    // pt-BR treats zero as singular, but its explicit zero form takes priority.
    expect(t('vocabulary.queue.accountAhead_other', { count: 3 })).toBe(queue.accountAhead_other.replace('{count}', '3'))
    expect(t('vocabulary.queue.position')).toBe(queue.position)
    expect(t('common.error')).toBe(locale === 'en' ? 'Something went wrong. Try again.' : 'Algo deu errado. Tente de novo.')
    expect(formatLocale()).toBe(locale)
    // @ts-expect-error Exercise the fallback for untyped callers.
    expect(t('missing.key')).toBe('missing.key')
  })

  it('updates the document, notifies only on changes, and unsubscribes', () => {
    const listener = vi.fn()
    const cancel = subscribe(listener)
    setLocale('en')
    expect(document.documentElement.lang).toBe('en')
    expect(listener).toHaveBeenCalledTimes(1)
    setLocale('en')
    expect(listener).toHaveBeenCalledTimes(1)
    cancel()
    setLocale('pt-BR')
    expect(document.documentElement.lang).toBe('pt-BR')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rerenders hook consumers on a locale switch', () => {
    function Translation() {
      const translate = useT()
      const locale = useLocale()
      return createElement('p', null, `${locale}: ${translate('common.cancel')}`)
    }
    render(createElement(Translation))
    expect(screen.getByText('pt-BR: Cancelar')).toBeInTheDocument()
    act(() => setLocale('en'))
    expect(screen.getByText('en: Cancel')).toBeInTheDocument()
  })

  it('keeps the catalog leaf keys identical', () => {
    function keys(catalog: object, prefix = ''): string[] {
      return Object.entries(catalog).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key
        return typeof value === 'string' ? [path] : keys(value, path)
      }).sort()
    }
    expect(keys(ptBR)).toEqual(keys(en))
  })
})

describe('pipeline vocabulary', () => {
  it.each<Locale>(['en', 'pt-BR'])('labels the pipeline in %s', (locale) => {
    setLocale(locale)
    const vocabulary = (locale === 'en' ? en : ptBR).vocabulary
    expect(stepName('transcription')).toBe(vocabulary.step.transcription)
    expect(stepStateLabel('waiting')).toBe(vocabulary.stepState.waiting)
    expect(reasonText('cancelled')).toBe(vocabulary.reason.cancelled)
    expect(deviceStateLabel('uploading')).toBe(vocabulary.device.uploading)
    expect(deviceStateTone('uploading')).toBe('progress')
    expect(stepName('future_step')).toBe('future_step')
    expect(reasonText('future_reason')).toBe('future_reason')
    expect(waitingPhrase(null)).toBeNull()
    expect(waitingPhrase(undefined)).toBeNull()
    expect(waitingPhrase({ reason: 'account_turn', account_ahead: 0 })).toBe(vocabulary.queue.accountNext)
    expect(waitingPhrase({ reason: 'account_turn', account_ahead: 2 })).toBe(vocabulary.queue.accountAhead_other.replace('{count}', '2'))
    expect(waitingPhrase({ reason: 'unknown' })).toBe(vocabulary.queue.waiting)
    expect(waitingPhrase({ reason: 'quota_window' })).toBe(vocabulary.queue.quotaLater)
    expect(waitingPhrase({ reason: 'unknown', processor: { online: false } })).toBe(vocabulary.queue.offline)
  })

  it('formats English queue times, positions, estimates, and offline precedence', () => {
    setLocale('en')
    const now = new Date(2026, 9, 2, 14, 0)
    const later = new Date(2026, 9, 2, 15, 20).toISOString()
    expect(waitingPhrase({ reason: 'capacity', ahead: 2, estimated_start_at: later }, now))
      .toBe('#3 in the queue · starts in about 1 h 20 min (estimate)')
    for (const [minutes, label] of [[0, 'less than 1 min'], [12, 'about 12 min'], [60, 'about 1 h']] as const) {
      expect(waitingPhrase({ reason: 'capacity', estimated_start_at: new Date(now.getTime() + minutes * 60_000).toISOString() }, now))
        .toBe(`starts in ${label} (estimate)`)
    }
    expect(waitingPhrase({ reason: 'quota_window', resumes_at: later }, now))
      .toBe('Your transcription minutes for the last 24 h are used up; the recording goes in at 15:20.')
    const previous = new Date(2026, 9, 1, 14, 2)
    const date = new Intl.DateTimeFormat('en', { day: '2-digit', month: '2-digit' }).format(previous)
    expect(waitingPhrase({ reason: 'account_turn', processor: { online: false, offline_since: previous.toISOString() } }, now))
      .toBe(`The processor has been down since ${date} at 14:02; your recording is saved and goes in when it is back.`)
  })
})

describe('App locale wiring', () => {
  it('follows core state and reports device tags on mount and language changes with cleanup', async () => {
    const bridge = fakeBridge(baseState({ locale: 'en' }))
    const { unmount } = render(createElement(BridgeContext.Provider, { value: bridge }, createElement(App)))
    await waitFor(() => expect(activeLocale()).toBe('en'))
    expect(bridge.reportDeviceLocale).toHaveBeenCalledWith('pt-BR')
    act(() => bridge.emit(baseState({ locale: 'pt-BR' })))
    expect(activeLocale()).toBe('pt-BR')
    Object.defineProperty(navigator, 'languages', { value: ['fr', 'en-GB'], configurable: true })
    try {
      act(() => window.dispatchEvent(new Event('languagechange')))
      expect(bridge.reportDeviceLocale).toHaveBeenLastCalledWith('en-GB')
      expect(activeLocale()).toBe('pt-BR')
      unmount()
      const count = vi.mocked(bridge.reportDeviceLocale).mock.calls.length
      window.dispatchEvent(new Event('languagechange'))
      expect(bridge.reportDeviceLocale).toHaveBeenCalledTimes(count)
    } finally {
      Object.defineProperty(navigator, 'languages', { value: ['pt-BR'], configurable: true })
    }
  })

  it('tolerates a rejected device locale report', async () => {
    const bridge = fakeBridge(baseState({ locale: 'en' }))
    vi.mocked(bridge.reportDeviceLocale).mockRejectedValue(new Error('unavailable'))
    render(createElement(BridgeContext.Provider, { value: bridge }, createElement(App)))
    await waitFor(() => expect(activeLocale()).toBe('en'))
    expect(bridge.reportDeviceLocale).toHaveBeenCalledWith('pt-BR')
  })
})
