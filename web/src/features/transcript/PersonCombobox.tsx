import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useId, useState, type KeyboardEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { PEOPLE_KEY } from '../people/queries'
import styles from './SpeakersPanel.module.css'

type Person = Schemas['Person']
type Option = { kind: 'person'; person: Person } | { kind: 'create'; name: string }

interface PersonComboboxProps {
  label: string
  onSelect: (person: Pick<Person, 'id' | 'name'>) => void
  onCancel: () => void
}

/**
 * Combobox (ARIA 1.2, lista em popup) para escolher uma pessoa do diretório pelo nome ou e-mail,
 * com a opção de cadastrar na hora quem ainda não existe. Setas navegam, Enter escolhe, Esc cancela.
 */
export function PersonCombobox({ label, onSelect, onCancel }: PersonComboboxProps) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const inputId = useId()
  const listId = useId()
  const term = useDeferredValue(text.trim())
  const people = useQuery({
    queryKey: [...PEOPLE_KEY, 'combobox', term],
    queryFn: () =>
      unwrap(api.GET('/api/v1/people', { params: { query: { limit: 8, ...(term ? { q: term } : {}) } } })),
    placeholderData: keepPreviousData,
  })
  const create = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/people', { body: { name } })),
    onSuccess: (person) => {
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      onSelect(person)
    },
  })

  const name = text.trim()
  const matches = people.data?.items ?? []
  const exists = matches.some((p) => p.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))
  const options: Option[] = [
    ...matches.map((person) => ({ kind: 'person' as const, person })),
    ...(name && !exists ? [{ kind: 'create' as const, name }] : []),
  ]
  const current = Math.min(active, options.length - 1)
  const optionId = (index: number) => `${listId}-${index}`

  function choose(option: Option) {
    if (option.kind === 'person') onSelect(option.person)
    else create.mutate(option.name)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(current + 1, options.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (current >= 0 && !create.isPending) choose(options[current])
    } else if (event.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className={styles.combo}>
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input
        id={inputId}
        className="input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        placeholder="Nome ou e-mail"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        autoFocus
      />
      <ul id={listId} role="listbox" aria-label={label} className={styles.options} hidden={options.length === 0}>
        {options.map((option, index) => (
          <li
            key={option.kind === 'person' ? option.person.id : 'nova'}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            className={styles.option}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(option)}
          >
            {option.kind === 'person' ? (
              <>
                <span>{option.person.name}</span>
                {option.person.email && <span className={styles.detail}>{option.person.email}</span>}
              </>
            ) : (
              <span>Cadastrar “{option.name}”</span>
            )}
          </li>
        ))}
      </ul>
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}
        </p>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  )
}
