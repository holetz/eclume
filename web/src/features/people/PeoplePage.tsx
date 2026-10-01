import { Columns3 } from 'lucide-react'
import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'

import { AutoAssignCard } from './AutoAssignCard'
import { PERSON_COLUMNS, readPersonColumns, savePersonColumns, type PersonColumn } from './columns'
import styles from './People.module.css'
import { useCreatePerson, usePeople, usePersonFacets, type Person } from './queries'
import { formatDate } from '../../shared/format'

export function PeoplePage() {
  useHelpTopic('pessoas')
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const deferredQ = useDeferredValue(q.trim())
  const people = usePeople(deferredQ)
  const items = people.data?.pages.flatMap((page) => page.items) ?? []
  const [columns, setColumns] = useState(readPersonColumns)
  const shown = PERSON_COLUMNS.filter((column) => columns.includes(column.key))

  function changeColumns(next: PersonColumn[]) {
    setColumns(next)
    savePersonColumns(next)
  }

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
        <ColumnsMenu columns={columns} onChange={changeColumns} />
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
              {shown.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <NewPersonRow span={shown.length} />
            {items.map((person, index) => (
              <PersonRow key={person.id} person={person} index={index} columns={columns} />
            ))}
            {people.isPending && (
              <tr>
                <td colSpan={shown.length + 1} role="status">
                  Carregando pessoas…
                </td>
              </tr>
            )}
            {people.isSuccess && items.length === 0 && (
              <tr>
                <td colSpan={shown.length + 1} className="text-muted">
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

/** A primeira linha da tabela: nome, empresa e Adicionar. Enter num dos campos também envia. */
function NewPersonRow({ span }: { span: number }) {
  const create = useCreatePerson()
  const [name, setName] = useState('')
  const [company, setOrganization] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const listId = useId()
  const facets = usePersonFacets()

  function submit() {
    if (!name.trim() || create.isPending) return
    create.mutate(
      { name: name.trim(), company: company.trim() || null },
      {
        onSuccess: () => {
          setName('')
          setOrganization('')
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
          onChange={(event) => {
            setName(event.target.value)
            if (create.isError) create.reset()
          }}
          onKeyDown={onEnter}
          aria-describedby={create.isError ? errorId : undefined}
          required
        />
        {create.isError && (
          <span id={errorId} className={`field-hint ${styles.rowError}`} role="alert">
            {errorMessage(create.error)}
          </span>
        )}
      </td>
      <td colSpan={Math.max(span, 1)}>
        <div className={styles.newRowRest}>
          <input
            className="input"
            placeholder="Empresa (opcional)"
            aria-label="Empresa da nova pessoa"
            autoComplete="off"
            list={listId}
            value={company}
            onKeyDown={onEnter}
            onChange={(event) => setOrganization(event.target.value)}
          />
          <datalist id={listId}>
            {(facets.data?.companies ?? []).map((item) => (
              <option key={item.value} value={item.value} />
            ))}
          </datalist>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={create.isPending || !name.trim()}
            onClick={submit}
          >
            Adicionar
          </button>
        </div>
      </td>
    </tr>
  )
}

function PersonRow({ person, index, columns }: { person: Person; index: number; columns: PersonColumn[] }) {
  return (
    <tr>
      <td>
        <span className={`speaker speaker-${(index % 6) + 1} ${styles.speaker}`}>
          <Link to={`/pessoas/${person.id}`}>{person.name}</Link>
        </span>
      </td>
      {PERSON_COLUMNS.filter((column) => columns.includes(column.key)).map(({ key }) => (
        <PersonCell key={key} person={person} column={key} />
      ))}
    </tr>
  )
}

function PersonCell({ person, column }: { person: Person; column: PersonColumn }) {
  switch (column) {
    case 'tags':
      return (
        <td>
          {person.tags.length > 0 ? (
            <span className={styles.personTags}>
              {person.tags.map((tag) => (
                <span key={tag} className="tag tag-neutral">
                  {tag}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
      )
    case 'transcript_count':
    case 'voice_sample_count':
      return <td className="tabular">{person[column]}</td>
    case 'last_seen_at':
      return <td className="tabular">{person.last_seen_at ? formatDate(person.last_seen_at) : '—'}</td>
    case 'email':
    case 'phone':
      return <td className="mono text-muted">{person[column] ?? '—'}</td>
    default:
      return <td>{person[column] ?? <span className="text-muted">—</span>}</td>
  }
}

/** O botão Colunas: um popover com uma caixa por coluna; Esc e o clique fora fecham. */
function ColumnsMenu({ columns, onChange }: { columns: PersonColumn[]; onChange: (columns: PersonColumn[]) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const toggle = (key: PersonColumn) =>
    onChange(columns.includes(key) ? columns.filter((column) => column !== key) : [...columns, key])

  return (
    <div
      ref={rootRef}
      className={styles.columns}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          buttonRef.current?.focus()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        <Columns3 size={14} aria-hidden="true" />
        Colunas
      </button>
      {open && (
        <fieldset id={panelId} className={`menu ${styles.columnsPanel}`}>
          <legend className="kicker">Mostrar colunas</legend>
          {PERSON_COLUMNS.map(({ key, label }) => (
            <label key={key} className="check">
              <input type="checkbox" checked={columns.includes(key)} onChange={() => toggle(key)} />
              <span className="box" />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  )
}
