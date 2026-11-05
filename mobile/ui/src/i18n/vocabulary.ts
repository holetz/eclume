import en from './en'
import { activeLocale, formatLocale, t } from './index'
import {
  ESTADOS_APARELHO, ESTADOS_ETAPA, fraseDaEspera, motivo, nomeDaEtapa,
  type EstadoAparelho, type EstadoEtapa, type Etapa, type FilaDaEspera, type Tom,
} from '../app/vocabulario.js'

export type DeviceState = EstadoAparelho
export type StepState = EstadoEtapa

export function stepName(step: string): string {
  if (activeLocale() === 'pt-BR') return nomeDaEtapa(step)
  return Object.hasOwn(en.vocabulary.step, step) ? t(`vocabulary.step.${step as Etapa}`) : step
}

export function stepStateLabel(state: StepState): string {
  return activeLocale() === 'pt-BR' ? ESTADOS_ETAPA[state] : t(`vocabulary.stepState.${state}`)
}

export function reasonText(code: string): string {
  if (activeLocale() === 'pt-BR') return motivo(code)
  return Object.hasOwn(en.vocabulary.reason, code)
    ? t(`vocabulary.reason.${code as keyof typeof en.vocabulary.reason}`) : code
}

export function deviceStateLabel(state: DeviceState): string {
  return activeLocale() === 'pt-BR' ? ESTADOS_APARELHO[state].rotulo : t(`vocabulary.device.${state}`)
}

export function deviceStateTone(state: DeviceState): Tom {
  return ESTADOS_APARELHO[state].tom
}

/** An instant's time: "14:02" on the same day, else the day and the time. */
function instantLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  const time = new Intl.DateTimeFormat(formatLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  if (date.toDateString() === now.toDateString()) return time
  const day = new Intl.DateTimeFormat(formatLocale(), { day: '2-digit', month: '2-digit' }).format(date)
  return t('vocabulary.queue.dayTime', { date: day, time })
}

/** How long until an instant, in words: "less than 1 min", "about 12 min", "about 1 h 20 min". */
function etaLabel(iso: string, now: Date): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60000)
  if (minutes < 1) return t('vocabulary.queue.lessThanMinute')
  if (minutes < 60) return t('vocabulary.queue.minutes', { minutes })
  const rest = minutes % 60
  const hours = Math.floor(minutes / 60)
  return rest ? t('vocabulary.queue.hoursMinutes', { hours, minutes: rest }) : t('vocabulary.queue.hours', { hours })
}

/**
 * The wait of a recording in the transcription queue (`Job.queue`), the same rule as the desktop's
 * and the phone's (`fraseDaEspera` in lib/vocabulario.js); `null` with no wait. The start forecast is
 * always labeled as an estimate.
 */
export function waitingPhrase(queue: FilaDaEspera | null | undefined, now = new Date()): string | null {
  if (activeLocale() === 'pt-BR') return fraseDaEspera(queue, now)
  if (!queue) return null
  const processor = queue.processor
  if (processor && !processor.online) {
    return processor.offline_since
      ? t('vocabulary.queue.offlineSince', { time: instantLabel(processor.offline_since, now) })
      : t('vocabulary.queue.offline')
  }
  if (queue.reason === 'account_turn') {
    const ahead = queue.account_ahead ?? 0
    return ahead === 0 ? t('vocabulary.queue.accountNext') : t('vocabulary.queue.accountAhead', { count: ahead })
  }
  if (queue.reason === 'quota_window') {
    return queue.resumes_at
      ? t('vocabulary.queue.quotaAt', { time: instantLabel(queue.resumes_at, now) })
      : t('vocabulary.queue.quotaLater')
  }
  const parts: string[] = []
  if (queue.ahead != null) parts.push(t('vocabulary.queue.position', { position: queue.ahead + 1 }))
  if (queue.estimated_start_at) parts.push(t('vocabulary.queue.starts', { eta: etaLabel(queue.estimated_start_at, now) }))
  return parts.length > 0 ? parts.join(' · ') : t('vocabulary.queue.waiting')
}
