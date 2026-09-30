import { useDeferredValue, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'
import { AutoAssignCard } from './AutoAssignCard'
import styles from './People.module.css'
import { useCreatePerson, usePeople, type Person } from './queries'

export function PeoplePage() {
  useHelpTopic('pessoas')
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const deferredQ = useDeferredValue(q.trim())
  const people = usePeople(deferredQ)
  const items = people.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Organizar"
        title="Pessoas"
        hint={
          <HelpHint subject="as sugestões por voz" title="Sugestões por voz" article="sugestoes-por-voz">
            O eclume compara a voz de um locutor sem pessoa com as amostras das pessoas que você
            cadastrou. Abaixo da sua pontuação mínima, a sugestão só vira vínculo quando você aceita; acima dela,
            o eclume liga sozinho e você pode desfazer.
          </HelpHint>
        }
      />
      <p className="text-muted">Quem fala nas suas gravações. Ligue os locutores a elas na página da gravação.</p>
      <AutoAssignCard />

      <div className="toolbar">
        <input
          className={`input ${styles.search}`}
          type="search"
          placeholder="Buscar pessoas"
          aria-label="Buscar pessoas"
          value={q}
          onChange={(event) => setParams(event.target.value ? { q: event.target.value } : {}, { replace: true })}
        />
      </div>

      {people.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(people.error)}
        </p>
      )}
      <div className={styles.tableWrap}>
        <table className="table" aria-label="Pessoas">
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">E-mail</th>
              <th scope="col">Gravações</th>
              <th scope="col">Amostras de voz</th>
            </tr>
          </thead>
          <tbody>
            <NewPersonRow />
            {items.map((person, index) => (
              <PersonRow key={person.id} person={person} index={index} />
            ))}
            {people.isPending && (
              <tr>
                <td colSpan={4} role="status">
                  Carregando pessoas…
                </td>
              </tr>
            )}
            {people.isSuccess && items.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted">
                  {deferredQ ? 'Ninguém com esse nome ou e-mail.' : 'Nenhuma pessoa cadastrada ainda.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {people.hasNextPage && (
        <button
          type="button"
          className={`btn btn-secondary ${styles.more}`}
          onClick={() => people.fetchNextPage()}
          disabled={people.isFetchingNextPage}
        >
          {people.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
        </button>
      )}
    </section>
  )
}

/** A primeira linha da tabela: nome, e-mail e Adicionar. Enter num dos campos também envia. */
function NewPersonRow() {
  const create = useCreatePerson()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const duplicate = create.error instanceof ApiError && create.error.status === 409
  const message = duplicate ? 'Já existe uma pessoa com este e-mail.' : create.error && errorMessage(create.error)

  function submit() {
    if (!name.trim() || create.isPending) return
    create.mutate(
      { name: name.trim(), email: email.trim() || null, notes: null },
      {
        onSuccess: () => {
          setName('')
          setEmail('')
          nameInput.current?.focus()
        },
      },
    )
  }

  function onEnter(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  }

  return (
    <tr className={styles.newRow}>
      <td>
        <input
          ref={nameInput}
          className="input"
          placeholder="Nome da nova pessoa"
          aria-label="Nome da nova pessoa"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onEnter}
          required
        />
      </td>
      <td>
        <input
          className="input"
          type="email"
          placeholder="E-mail (opcional)"
          aria-label="E-mail da nova pessoa"
          autoComplete="off"
          value={email}
          onKeyDown={onEnter}
          onChange={(event) => {
            setEmail(event.target.value)
            if (create.isError) create.reset()
          }}
          aria-invalid={duplicate || undefined}
          aria-describedby={message ? errorId : undefined}
        />
        {message && (
          <span id={errorId} className={`field-hint ${styles.rowError}`} role="alert">
            {message}
          </span>
        )}
      </td>
      <td colSpan={2}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={create.isPending || !name.trim()}
          onClick={submit}
        >
          Adicionar
        </button>
      </td>
    </tr>
  )
}

function PersonRow({ person, index }: { person: Person; index: number }) {
  return (
    <tr>
      <td>
        <span className={`speaker speaker-${(index % 6) + 1} ${styles.speaker}`}>
          <Link to={`/pessoas/${person.id}`}>{person.name}</Link>
        </span>
      </td>
      <td className="mono text-muted">{person.email ?? '—'}</td>
      <td className="tabular">{person.transcript_count}</td>
      <td className="tabular">{person.voice_sample_count}</td>
    </tr>
  )
}
