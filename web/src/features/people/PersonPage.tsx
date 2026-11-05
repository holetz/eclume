import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { usePageTitle } from '../../app/usePageTitle'

import styles from './People.module.css'
import { PersonForm, type PersonFields } from './PersonForm'
import { PEOPLE_KEY, recordingAt, usePerson, usePersonSegments, usePersonTranscripts, type Person } from './queries'
import { useVoiceprint, type Voiceprint } from './voice'
import { VoiceSection } from './VoiceSection'
import { formatClock, formatDate, formatDateTime, formatDuration } from '../../shared/format'

const TABS = [{ key: 'gravacoes' }, { key: 'falas' }, { key: 'amostras' }] as const
type TabKey = (typeof TABS)[number]['key']

export function PersonPage() {
  useHelpTopic('pessoa')
  const { t } = useTranslation('people')
  const { id = '' } = useParams()
  const person = usePerson(id)
  usePageTitle(person.data?.name ?? t('person.title'))

  return (
    <section className={styles.page}>
      <Link to="/pessoas" className={styles.back}>
        {t('person.back')}
      </Link>
      {person.isPending && <p role="status">{t('person.loading')}</p>}
      {person.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(person.error)}
        </p>
      )}
      {person.isSuccess && <PersonDetail person={person.data} />}
    </section>
  )
}

function PersonDetail({ person }: { person: Person }) {
  const { t } = useTranslation('people')
  const [dialog, setDialog] = useState<'editar' | 'excluir' | null>(null)
  const voiceprint = useVoiceprint(person.id)

  return (
    <>
      <PageHead
        kicker={t('person.title')}
        title={person.name}
        actions={
          <button type="button" className="btn btn-secondary" onClick={() => setDialog('editar')}>
            {t('person.edit')}
          </button>
        }
      />
      <PersonIdentity person={person} />
      <PersonStats person={person} voiceprint={voiceprint.data} />
      <PersonTabs person={person} />
      {dialog === 'editar' && (
        <EditDialog person={person} onClose={() => setDialog(null)} onDelete={() => setDialog('excluir')} />
      )}
      {dialog === 'excluir' && <DeleteDialog person={person} onClose={() => setDialog(null)} />}
    </>
  )
}

/** The record: where the person works, the tags, the contacts and the notes; only what was filled in. */
function PersonIdentity({ person }: { person: Person }) {
  const { t } = useTranslation('people')
  const role = [person.job_title, person.department, person.company].filter(Boolean).join(' · ')
  const contacts = [person.email, person.phone].filter(Boolean).join(' · ')
  if (!role && !contacts && !person.notes && person.tags.length === 0) return null
  return (
    <div className={styles.identity}>
      {role && <p>{role}</p>}
      {person.tags.length > 0 && (
        <ul className={styles.personTags} aria-label={t('form.tags')}>
          {person.tags.map((tag) => (
            <li key={tag} className="tag tag-neutral">
              {tag}
            </li>
          ))}
        </ul>
      )}
      {contacts && <p className="mono text-muted">{contacts}</p>}
      {person.notes && <p className={`text-muted ${styles.notes}`}>{person.notes}</p>}
    </div>
  )
}

function PersonStats({ person, voiceprint }: { person: Person; voiceprint: Voiceprint | undefined }) {
  const { t } = useTranslation('people')
  let samplesSub = ''
  if (voiceprint) {
    if (!voiceprint.enabled) samplesSub = t('person.samplesOff')
    else samplesSub = voiceprint.sample_count >= 1 ? t('person.samplesEnough') : t('person.samplesNone')
  }
  return (
    <div className={`stats ${styles.stats}`}>
      <div className="stat">
        <span className="kicker">{t('tab.gravacoes')}</span>
        <span className="stat-value">{person.transcript_count}</span>
      </div>
      <div className="stat">
        <span className="kicker">{t('person.speakingTime')}</span>
        <span className="stat-value">{formatDuration(person.speaking_time_ms)}</span>
      </div>
      <div className="stat">
        <span className="kicker">{t('tab.amostras')}</span>
        <span className="stat-value">{voiceprint ? voiceprint.sample_count : person.voice_sample_count}</span>
        {samplesSub && <span className="stat-sub">{samplesSub}</span>}
      </div>
    </div>
  )
}

function PersonTabs({ person }: { person: Person }) {
  const { t } = useTranslation('people')
  const [params, setParams] = useSearchParams()
  const current: TabKey = TABS.find((tab) => tab.key === params.get('aba'))?.key ?? 'gravacoes'
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({})
  const baseId = useId()

  function select(key: TabKey) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (key === 'gravacoes') next.delete('aba')
        else next.set('aba', key)
        return next
      },
      { replace: true },
    )
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = TABS.findIndex((tab) => tab.key === current)
    const next = TABS[(index + step + TABS.length) % TABS.length].key
    select(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className={styles.tabsBlock}>
      <div className="tabs" role="tablist" aria-label={t('person.about')} onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(element) => {
              tabRefs.current[tab.key] = element
            }}
            type="button"
            role="tab"
            className="tab"
            id={`${baseId}-${tab.key}`}
            aria-selected={tab.key === current}
            aria-controls={`${baseId}-${tab.key}-painel`}
            tabIndex={tab.key === current ? 0 : -1}
            onClick={() => select(tab.key)}
          >
            {t(`tab.${tab.key}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-${current}-painel`} aria-labelledby={`${baseId}-${current}`}>
        {current === 'gravacoes' && <PersonTranscripts personId={person.id} />}
        {current === 'falas' && <PersonSegments personId={person.id} />}
        {current === 'amostras' && <VoiceSection person={person} />}
      </div>
    </div>
  )
}

function EditDialog({ person, onClose, onDelete }: { person: Person; onClose: () => void; onDelete: () => void }) {
  const { t } = useTranslation('people')
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (fields: PersonFields) =>
      unwrap(api.PATCH('/api/v1/people/{person_id}', { params: { path: { person_id: person.id } }, body: fields })),
    onSuccess: (updated) => {
      queryClient.setQueryData([...PEOPLE_KEY, person.id], updated)
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      onClose()
    },
  })
  return (
    <Dialog title={t('person.editTitle')} onClose={onClose} plain>
      <PersonForm
        initial={person}
        pending={save.isPending}
        error={save.error}
        onSubmit={(fields) => save.mutate(fields)}
        onCancel={onClose}
        danger={
          <button type="button" className={`btn btn-ghost btn-danger ${styles.dangerAction}`} onClick={onDelete}>
            {t('person.delete')}
          </button>
        }
      />
    </Dialog>
  )
}

function DeleteDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const { t } = useTranslation('people')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/people/{person_id}', { params: { path: { person_id: person.id } } })),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: [...PEOPLE_KEY, person.id] })
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      navigate('/pessoas', { replace: true })
    },
  })
  return (
    <Dialog
      plain
      title={t('person.deleteTitle', { name: person.name })}
      message={t('person.deleteText')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('person.keep')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t('person.delete')}
          </button>
        </>
      }
    >
      {remove.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
    </Dialog>
  )
}

function PersonTranscripts({ personId }: { personId: string }) {
  const { t } = useTranslation('people')
  const transcripts = usePersonTranscripts(personId)
  const items = transcripts.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className={styles.section}>
      {transcripts.isPending && <p role="status">{t('person.loadingRecordings')}</p>}
      {transcripts.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(transcripts.error)}
        </p>
      )}
      {transcripts.isSuccess && items.length === 0 && (
        <p className={styles.empty}>{t('person.noRecordings')}</p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.plainList}`} aria-label={t('person.recordings')}>
          {items.map((transcript) => (
            <li key={transcript.id} className="list-row">
              <Link className={`list-row-title ${styles.rowLink}`} to={`/gravacoes/${transcript.recording_id}`}>
                {transcript.title}
              </Link>
              <span className="list-row-sub mono">
                {t('person.recordingLine', {
                  date: formatDateTime(transcript.recorded_at),
                  duration: formatDuration(transcript.duration_ms),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {transcripts.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => transcripts.fetchNextPage()}
          disabled={transcripts.isFetchingNextPage}
        >
          {t('person.moreRecordings')}
        </button>
      )}
    </div>
  )
}

function PersonSegments({ personId }: { personId: string }) {
  const { t } = useTranslation('people')
  const segments = usePersonSegments(personId)
  const items = segments.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className={styles.section}>
      {segments.isPending && <p role="status">{t('person.loadingSegments')}</p>}
      {segments.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(segments.error)}
        </p>
      )}
      {segments.isSuccess && items.length === 0 && (
        <p className={styles.empty}>{t('person.noSegments')}</p>
      )}
      {items.length > 0 && (
        <ol className={`list ${styles.plainList}`} aria-label={t('person.segments')}>
          {items.map((hit) => {
            const clock = formatClock(hit.segment.start_ms)
            return (
              <li key={`${hit.transcript.id}/${hit.segment.id}`} className="list-row">
                <span className="list-row-title">{hit.transcript.title}</span>
                <span className="list-row-sub mono">
                  {formatDate(hit.transcript.recorded_at)} ·{' '}
                  <Link
                    to={recordingAt(hit.transcript.recording_id, hit.segment.start_ms)}
                    aria-label={t('person.listen', { title: hit.transcript.title, time: clock })}
                  >
                    {clock}
                  </Link>
                </span>
                <p className={styles.quote}>{hit.segment.text}</p>
              </li>
            )
          })}
        </ol>
      )}
      {segments.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => segments.fetchNextPage()}
          disabled={segments.isFetchingNextPage}
        >
          {t('person.moreSegments')}
        </button>
      )}
    </div>
  )
}
