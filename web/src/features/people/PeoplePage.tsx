import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useId, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDate } from '../library/format'
import styles from './People.module.css'
import { PersonForm, type PersonFields } from './PersonForm'
import { PEOPLE_KEY, usePeople, type Person } from './queries'

export function PeoplePage() {
  usePageTitle('Pessoas')
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const deferredQ = useDeferredValue(q.trim())
  const people = usePeople(deferredQ)
  const [creating, setCreating] = useState(false)
  const searchId = useId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const create = useMutation({
    mutationFn: (fields: PersonFields) => unwrap(api.POST('/api/v1/people', { body: fields })),
    onSuccess: (person) => {
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      navigate(`/pessoas/${person.id}`)
    },
  })
  const items = people.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className={styles.page} aria-labelledby="pessoas-titulo">
      <header className={styles.header}>
        <div>
          <h1 id="pessoas-titulo">Pessoas</h1>
          <p className="muted">Quem fala nas gravações da organização. Ligue os locutores a elas na página da gravação.</p>
        </div>
        {!creating && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Cadastrar pessoa
          </button>
        )}
      </header>

      {creating && (
        <div className="card">
          <PersonForm
            submitLabel="Cadastrar"
            pending={create.isPending}
            error={create.error}
            onSubmit={(fields) => create.mutate(fields)}
            onCancel={() => {
              create.reset()
              setCreating(false)
            }}
          />
        </div>
      )}

      <div className={`field ${styles.search}`}>
        <label htmlFor={searchId}>Buscar por nome ou e-mail</label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={q}
          onChange={(event) => setParams(event.target.value ? { q: event.target.value } : {}, { replace: true })}
        />
      </div>

      {people.isPending && <p role="status">Carregando pessoas…</p>}
      {people.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(people.error)}
        </p>
      )}
      {people.isSuccess && items.length === 0 && (
        <p className={`card ${styles.empty}`}>
          {deferredQ ? 'Ninguém com esse nome ou e-mail.' : 'Nenhuma pessoa cadastrada ainda.'}
        </p>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Pessoas">
          {items.map((person) => (
            <PersonRow key={person.id} person={person} />
          ))}
        </ul>
      )}
      {people.hasNextPage && (
        <button
          type="button"
          className={`btn ${styles.more}`}
          onClick={() => people.fetchNextPage()}
          disabled={people.isFetchingNextPage}
        >
          {people.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
        </button>
      )}
    </section>
  )
}

function PersonRow({ person }: { person: Person }) {
  const count = person.transcript_count
  return (
    <li className={`card ${styles.row}`}>
      <h2 className={styles.name}>
        <Link to={`/pessoas/${person.id}`}>{person.name}</Link>
      </h2>
      <p className={styles.meta}>
        {person.email && <span>{person.email}</span>}
        <span>{count === 1 ? '1 transcrição' : `${count} transcrições`}</span>
        {person.last_seen_at && <span>Última: {formatDate(person.last_seen_at)}</span>}
      </p>
    </li>
  )
}
