import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { activeLocale, i18n } from '../../i18n'
import { useCollections } from '../collections/queries'
import {
  useSpeakerNaming,
  useUpdateSpeakerNaming,
  useVoiceAssignment,
  type SpeakerNaming,
  type VoiceAssignment,
} from '../people/queries'
import { Switch } from '../../shared/Switch'
import { useTagAssignment, type TagAssignment } from '../tags/queries'
import styles from './Automation.module.css'
import { useAgendaTypes, useFields } from '../organize/queries'

const percents = new Map<string, Intl.NumberFormat>()

/** The voice threshold as a percentage, in the active locale (one formatter per locale). */
function formatPercent(value: number): string {
  const locale = activeLocale()
  let format = percents.get(locale)
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
    percents.set(locale, format)
  }
  return format.format(value)
}

interface Step {
  title: string
  /** What the step does, in one sentence. */
  what: string
  /** The screen that configures the step; without one, the step belongs to the platform. */
  to?: string
  linkLabel?: string
  state: ReactNode
  /** The switch that is changed right here, when no other screen owns it. */
  control?: ReactNode
}

/** The state of a step coming from a query: loading, error or the computed text. */
function stateOf<T>(query: UseQueryResult<T>, describe: (data: T) => string): ReactNode {
  if (query.isPending) return i18n.t('automation:loading')
  if (query.isError) return <span role="alert">{errorMessage(query.error)}</span>
  return describe(query.data)
}

function voiceState(voice: VoiceAssignment): string {
  if (!voice.platform_enabled) return i18n.t('automation:voice.platformOff')
  if (!voice.keep_samples) return i18n.t('automation:voice.noSamples')
  if (!voice.enabled) return i18n.t('automation:voice.suggestOnly')
  return i18n.t('automation:voice.auto', { threshold: formatPercent(voice.threshold) })
}

function namingState(naming: SpeakerNaming): string {
  if (!naming.required) return i18n.t('automation:naming.optional')
  if (naming.waiting_count === 0) return i18n.t('automation:naming.required')
  return i18n.t('automation:naming.waiting', { count: naming.waiting_count })
}

function tagState(tags: TagAssignment): string {
  if (!tags.auto_fill) return i18n.t('automation:tags.off')
  if (tags.mode === 'fixed') return i18n.t('automation:tags.fixed', { n: tags.catalog_count })
  return i18n.t('automation:tags.free')
}

/**
 * Automatic processing (its own folder: it reads people, tags, collections and organize without
 * creating a cycle between them): the overview, in pipeline order, of what eclume does on its own
 * after each recording. It reads what each step's screens configure and links to them; only the
 * mandatory speaker labelling, which has no other screen, is switched on right here.
 */
export function AutomationPage() {
  useHelpTopic('automacao')
  const { t } = useTranslation('automation')
  const voice = useVoiceAssignment()
  const naming = useSpeakerNaming()
  const updateNaming = useUpdateSpeakerNaming()
  const agendaTypes = useAgendaTypes()
  const fields = useFields()
  const tags = useTagAssignment()
  const collections = useCollections()

  const steps: Step[] = [
    {
      title: t('transcription.title'),
      what: t('transcription.what'),
      state: t('transcription.state'),
    },
    {
      title: t('voice.title'),
      what: t('voice.what'),
      to: '/pessoas',
      linkLabel: t('voice.link'),
      state: stateOf(voice, voiceState),
    },
    {
      title: t('naming.title'),
      what: t('naming.what'),
      state: updateNaming.isError ? (
        <span role="alert">{errorMessage(updateNaming.error)}</span>
      ) : (
        stateOf(naming, namingState)
      ),
      control: naming.data && (
        <Switch
          label={t('naming.switch')}
          checked={naming.data.required}
          disabled={updateNaming.isPending}
          onChange={(required) => updateNaming.mutate({ required })}
        />
      ),
    },
    {
      title: t('agendaType.title'),
      what: t('agendaType.what'),
      to: '/config/agendas',
      linkLabel: t('agendaType.link'),
      state: stateOf(agendaTypes, (data) => t('agendaType.count', { count: data.items.length })),
    },
    {
      title: t('fields.title'),
      what: t('fields.what'),
      to: '/config/campos',
      linkLabel: t('fields.link'),
      state: stateOf(fields, (data) => {
        const auto = data.items.filter((field) => field.auto_fill && !field.builtin).length
        return auto === 0 ? t('fields.none') : t('fields.count', { count: auto })
      }),
    },
    {
      title: t('tags.title'),
      what: t('tags.what'),
      to: '/tags',
      linkLabel: t('tags.link'),
      state: stateOf(tags, tagState),
    },
    {
      title: t('collections.title'),
      what: t('collections.what'),
      to: '/colecoes',
      linkLabel: t('collections.link'),
      state: stateOf(collections, (data) => {
        const ruled = data.items.filter((collection) => collection.auto_assign).length
        return ruled === 0 ? t('collections.none') : t('collections.count', { count: ruled })
      }),
    },
    {
      title: t('summary.title'),
      what: t('summary.what'),
      to: '/config/agendas',
      linkLabel: t('summary.link'),
      state: stateOf(agendaTypes, (data) => {
        const own = data.items.filter((type) => type.summary_instructions.trim()).length
        return own === 0 ? t('summary.none') : t('summary.count', { count: own })
      }),
    },
  ]

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('title')} />
      <p className="text-muted">
        <Trans t={t} i18nKey="lede" components={{ how: <Link to="/ajuda/after-the-recording" /> }} />
      </p>
      <ol className={`list ${styles.list}`} aria-label={t('steps')}>
        {steps.map((step, index) => (
          <li key={step.title} className="list-row">
            <span className="list-row-title">
              {index + 1}. {step.title}
            </span>
            <span className="list-row-sub">
              {step.what} <strong>{step.state}</strong>
            </span>
            {step.control && <span className="list-row-actions">{step.control}</span>}
            {step.to && (
              <span className="list-row-actions">
                <Link to={step.to} aria-label={step.linkLabel}>
                  {t('configure')}
                </Link>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
