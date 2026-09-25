import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDate, formatDateTime, formatDuration } from '../library/format'
import { formatClock } from '../transcript/segments'
import styles from './People.module.css'
import { PersonForm, type PersonFields } from './PersonForm'
import { PEOPLE_KEY, recordingAt, usePerson, usePersonSegments, usePersonTranscripts, type Person } from './queries'
import { VoiceSection } from './VoiceSection'

export function PersonPage() {
  const { id = '' } = useParams()
  const person = usePerson(id)
  usePageTitle(person.data?.name ?? 'Pessoa')

  return (
    <section className={styles.page} aria-labelledby="pessoa-titulo">
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
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const path = { params: { path: { person_id: person.id } } }
  const save = useMutation({
    mutationFn: (fields: PersonFields) => unwrap(api.PATCH('/api/v1/people/{person_id}', { ...path, body: fields })),
    onSuccess: (updated) => {
      queryClient.setQueryData([...PEOPLE_KEY, person.id], updated)
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      setEditing(false)
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/people/{person_id}', path)),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: [...PEOPLE_KEY, person.id] })
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      navigate('/pessoas', { replace: true })
    },
  })

  return (
    <>
      <header className={styles.header}>
        <div>
          <h1 id="pessoa-titulo">{person.name}</h1>
          <p className={styles.meta}>
            {person.email && <span>{person.email}</span>}
            <span>
              {person.transcript_count === 1 ? '1 transcrição' : `${person.transcript_count} transcrições`}
            </span>
            {person.last_seen_at && <span>Última: {formatDate(person.last_seen_at)}</span>}
          </p>
          {person.notes && <p className={`muted ${styles.notes}`}>{person.notes}</p>}
        </div>
        {!editing && (
          <div className={styles.actions}>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Editar
            </button>
            {confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Confirmar exclusão
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Manter
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
                Excluir
              </button>
            )}
          </div>
        )}
      </header>
      {confirming && !remove.isError && (
        <p className="alert alert-warning" role="status">
          Excluir desfaz os vínculos com os locutores e apaga a impressão de voz; as transcrições ficam.
        </p>
      )}
      {remove.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
      {editing && (
        <div className="card">
          <PersonForm
            initial={person}
            submitLabel="Salvar"
            pending={save.isPending}
            error={save.error}
            onSubmit={(fields) => save.mutate(fields)}
            onCancel={() => {
              save.reset()
              setEditing(false)
            }}
          />
        </div>
      )}
      <VoiceSection person={person} isAdmin={me.data?.user.role === 'admin'} />
      <div className={styles.columns}>
        <PersonTranscripts personId={person.id} />
        <PersonSegments personId={person.id} />
      </div>
    </>
  )
}

function PersonTranscripts({ personId }: { personId: string }) {
  const transcripts = usePersonTranscripts(personId)
  const items = transcripts.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <section className={styles.section} aria-labelledby="pessoa-transcricoes">
      <h2 id="pessoa-transcricoes">Transcrições</h2>
      {transcripts.isPending && <p role="status">Carregando transcrições…</p>}
      {transcripts.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(transcripts.error)}
        </p>
      )}
      {transcripts.isSuccess && items.length === 0 && (
        <p className={`card ${styles.empty}`}>Nenhuma transcrição visível para você com esta pessoa.</p>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Transcrições da pessoa">
          {items.map((transcript) => (
            <li key={transcript.id} className={`card ${styles.row}`}>
              <h3 className={styles.name}>
                <Link to={`/gravacoes/${transcript.recording_id}`}>{transcript.title}</Link>
              </h3>
              <p className={styles.meta}>
                <span>{formatDateTime(transcript.recorded_at)}</span>
                <span className="tabular">{formatDuration(transcript.duration_ms)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
      {transcripts.hasNextPage && (
        <button
          type="button"
          className={`btn ${styles.more}`}
          onClick={() => transcripts.fetchNextPage()}
          disabled={transcripts.isFetchingNextPage}
        >
          Carregar mais transcrições
        </button>
      )}
    </section>
  )
}

function PersonSegments({ personId }: { personId: string }) {
  const segments = usePersonSegments(personId)
  const items = segments.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <section className={styles.section} aria-labelledby="pessoa-falas">
      <h2 id="pessoa-falas">Falas</h2>
      {segments.isPending && <p role="status">Carregando falas…</p>}
      {segments.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(segments.error)}
        </p>
      )}
      {segments.isSuccess && items.length === 0 && (
        <p className={`card ${styles.empty}`}>Nenhuma fala ligada a esta pessoa ainda.</p>
      )}
      {items.length > 0 && (
        <ol className={styles.list} aria-label="Falas da pessoa">
          {items.map((hit) => {
            const clock = formatClock(hit.segment.start_ms)
            return (
              <li key={`${hit.transcript.id}/${hit.segment.id}`} className={`card ${styles.quote}`}>
                <p className={styles.quoteHead}>
                  <span>{hit.transcript.title}</span>
                  <span>{formatDate(hit.transcript.recorded_at)}</span>
                  <Link
                    to={recordingAt(hit.transcript.recording_id, hit.segment.start_ms)}
                    aria-label={`Ouvir em ${hit.transcript.title}, ${clock}`}
                  >
                    {clock}
                  </Link>
                </p>
                <p>{hit.segment.text}</p>
              </li>
            )
          })}
        </ol>
      )}
      {segments.hasNextPage && (
        <button
          type="button"
          className={`btn ${styles.more}`}
          onClick={() => segments.fetchNextPage()}
          disabled={segments.isFetchingNextPage}
        >
          Carregar mais falas
        </button>
      )}
    </section>
  )
}
