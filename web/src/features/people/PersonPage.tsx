import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
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

const TABS = [
  { key: 'gravacoes', label: 'Gravações' },
  { key: 'falas', label: 'Falas' },
  { key: 'amostras', label: 'Amostras de voz' },
] as const
type TabKey = (typeof TABS)[number]['key']

export function PersonPage() {
  useHelpTopic('pessoa')
  const { id = '' } = useParams()
  const person = usePerson(id)
  usePageTitle(person.data?.name ?? 'Pessoa')

  return (
    <section className={styles.page}>
      <Link to="/pessoas" className={styles.back}>
        ← Pessoas
      </Link>
      {person.isPending && <p role="status">Carregando pessoa…</p>}
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
  const [dialog, setDialog] = useState<'editar' | 'excluir' | null>(null)
  const voiceprint = useVoiceprint(person.id)

  return (
    <>
      <PageHead
        kicker="Pessoa"
        title={person.name}
        actions={
          <button type="button" className="btn btn-secondary" onClick={() => setDialog('editar')}>
            Editar
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

/** O cadastro: onde a pessoa trabalha, as tags, os contatos e as notas; só o que foi preenchido. */
function PersonIdentity({ person }: { person: Person }) {
  const role = [person.job_title, person.department, person.company].filter(Boolean).join(' · ')
  const contacts = [person.email, person.phone].filter(Boolean).join(' · ')
  if (!role && !contacts && !person.notes && person.tags.length === 0) return null
  return (
    <div className={styles.identity}>
      {role && <p>{role}</p>}
      {person.tags.length > 0 && (
        <ul className={styles.personTags} aria-label="Tags da pessoa">
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
  let samplesSub = ''
  if (voiceprint) {
    if (!voiceprint.enabled) samplesSub = 'Desligada neste servidor'
    else samplesSub = voiceprint.sample_count >= 1 ? 'Suficiente para sugerir' : 'Nenhuma ainda'
  }
  return (
    <div className={`stats ${styles.stats}`}>
      <div className="stat">
        <span className="kicker">Gravações</span>
        <span className="stat-value">{person.transcript_count}</span>
      </div>
      <div className="stat">
        <span className="kicker">Tempo de fala</span>
        <span className="stat-value">{formatDuration(person.speaking_time_ms)}</span>
      </div>
      <div className="stat">
        <span className="kicker">Amostras de voz</span>
        <span className="stat-value">{voiceprint ? voiceprint.sample_count : person.voice_sample_count}</span>
        {samplesSub && <span className="stat-sub">{samplesSub}</span>}
      </div>
    </div>
  )
}

function PersonTabs({ person }: { person: Person }) {
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
      <div className="tabs" role="tablist" aria-label="Sobre a pessoa" onKeyDown={onKeyDown}>
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
            {tab.label}
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
    <Dialog title="Editar pessoa" onClose={onClose} plain>
      <PersonForm
        initial={person}
        pending={save.isPending}
        error={save.error}
        onSubmit={(fields) => save.mutate(fields)}
        onCancel={onClose}
        danger={
          <button type="button" className={`btn btn-ghost btn-danger ${styles.dangerAction}`} onClick={onDelete}>
            Excluir pessoa
          </button>
        }
      />
    </Dialog>
  )
}

function DeleteDialog({ person, onClose }: { person: Person; onClose: () => void }) {
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
      title={`Excluir ${person.name}?`}
      message="Excluir desfaz os vínculos com os locutores e apaga a impressão de voz. As transcrições ficam."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Manter
          </button>
          <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Excluir pessoa
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
  const transcripts = usePersonTranscripts(personId)
  const items = transcripts.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className={styles.section}>
      {transcripts.isPending && <p role="status">Carregando gravações…</p>}
      {transcripts.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(transcripts.error)}
        </p>
      )}
      {transcripts.isSuccess && items.length === 0 && (
        <p className={styles.empty}>Nenhuma gravação com esta pessoa ainda.</p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.plainList}`} aria-label="Gravações da pessoa">
          {items.map((transcript) => (
            <li key={transcript.id} className="list-row">
              <Link className={`list-row-title ${styles.rowLink}`} to={`/gravacoes/${transcript.recording_id}`}>
                {transcript.title}
              </Link>
              <span className="list-row-sub mono">
                {formatDateTime(transcript.recorded_at)} · {formatDuration(transcript.duration_ms)}
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
          Carregar mais gravações
        </button>
      )}
    </div>
  )
}

function PersonSegments({ personId }: { personId: string }) {
  const segments = usePersonSegments(personId)
  const items = segments.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className={styles.section}>
      {segments.isPending && <p role="status">Carregando falas…</p>}
      {segments.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(segments.error)}
        </p>
      )}
      {segments.isSuccess && items.length === 0 && (
        <p className={styles.empty}>Nenhuma fala ligada a esta pessoa ainda.</p>
      )}
      {items.length > 0 && (
        <ol className={`list ${styles.plainList}`} aria-label="Falas da pessoa">
          {items.map((hit) => {
            const clock = formatClock(hit.segment.start_ms)
            return (
              <li key={`${hit.transcript.id}/${hit.segment.id}`} className="list-row">
                <span className="list-row-title">{hit.transcript.title}</span>
                <span className="list-row-sub mono">
                  {formatDate(hit.transcript.recorded_at)} ·{' '}
                  <Link
                    to={recordingAt(hit.transcript.recording_id, hit.segment.start_ms)}
                    aria-label={`Ouvir em ${hit.transcript.title}, ${clock}`}
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
          Carregar mais falas
        </button>
      )}
    </div>
  )
}
