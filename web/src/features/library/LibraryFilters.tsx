import { PanelRight, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { useCollections, useTags } from '../collections/queries'
import { usePeopleOptions } from '../people/queries'
import { PersonCombobox } from '../transcript/PersonCombobox'
import { activeFilterCount, KINDS, STATUS_GROUPS, type KindParam, type LibraryFilters, type StatusParam } from './filters'
import styles from './LibraryPage.module.css'
import { useUserFields } from './queries'

type Field = Schemas['Field']

const KIND_LABELS: Record<KindParam, string> = { reuniao: 'Reuniões', nota: 'Notas' }
const STATUS_LABELS: Record<StatusParam, string> = { pronta: 'Pronta', processando: 'Processando', falhou: 'Falhou' }

interface FilterProps {
  filters: LibraryFilters
  onChange: (filters: LibraryFilters) => void
}

/**
 * Marca ou desmarca num grupo em que "nada na URL" é "tudo marcado" (tipo e situação): tudo marcado
 * volta a não mandar o parâmetro, e o último marcado não sai.
 */
function toggleAll<T extends string>(selected: T[], all: T[], value: T): T[] {
  const current = selected.length === 0 ? all : selected
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
  if (next.length === 0) return selected
  return next.length === all.length ? [] : all.filter((item) => next.includes(item))
}

/** Marca ou desmarca num grupo em que nada marcado é "qualquer um" (tags, coleções, opções). */
function toggle(selected: string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="box" />
      <span>{label}</span>
    </label>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <div className="filter-group" role="group" aria-labelledby={titleId}>
      <h6 id={titleId}>{title}</h6>
      {children}
    </div>
  )
}

function FieldFilter({ field, filters, onChange }: FilterProps & { field: Field }) {
  const prefix = `${field.id}:`
  const values = filters.field.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length))
  const others = filters.field.filter((value) => !value.startsWith(prefix))
  const set = (next: string[]) => onChange({ ...filters, field: [...others, ...next.map((value) => prefix + value)] })
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? values[0] ?? ''

  if (field.kind === 'choice') {
    return (
      <Group title={field.name}>
        {field.options.map((option) => (
          <Check key={option} label={option} checked={values.includes(option)} onChange={() => set(toggle(values, option))} />
        ))}
      </Group>
    )
  }
  const apply = () => {
    setDraft(null)
    const next = text.trim()
    if (next !== (values[0] ?? '')) set(next ? [next] : [])
  }
  return (
    <Group title={field.name}>
      <input
        className="input"
        placeholder="Qualquer valor"
        aria-label={field.name}
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
        }}
      />
    </Group>
  )
}

/** Os grupos de filtro da biblioteca: no painel à direita ou, em tela estreita, num diálogo. */
export function FilterGroups({ filters, onChange }: FilterProps) {
  const tags = useTags()
  const collections = useCollections()
  const fields = useUserFields()
  const people = usePeopleOptions()
  const kinds = Object.keys(KINDS) as KindParam[]
  const statuses = Object.keys(STATUS_GROUPS) as StatusParam[]
  const personName = (id: string) => people.data?.items.find((person) => person.id === id)?.name ?? 'Pessoa'
  const own = (fields.data?.items ?? []).filter((field) => field.builtin === null)
  // Depois de escolher, o combobox volta vazio (é remontado) para a próxima pessoa.
  const [personPick, setPersonPick] = useState(0)

  return (
    <>
      <Group title="Tipo">
        {kinds.map((kind) => {
          const checked = filters.kind.length === 0 || filters.kind.includes(kind)
          return (
            <Check
              key={kind}
              label={KIND_LABELS[kind]}
              checked={checked}
              disabled={checked && filters.kind.length === 1}
              onChange={() => onChange({ ...filters, kind: toggleAll(filters.kind, kinds, kind) })}
            />
          )
        })}
      </Group>
      <Group title="Situação">
        {statuses.map((status) => {
          const checked = filters.status.length === 0 || filters.status.includes(status)
          return (
            <Check
              key={status}
              label={STATUS_LABELS[status]}
              checked={checked}
              disabled={checked && filters.status.length === 1}
              onChange={() => onChange({ ...filters, status: toggleAll(filters.status, statuses, status) })}
            />
          )
        })}
      </Group>
      {(tags.data?.items.length ?? 0) > 0 && (
        <Group title="Tags">
          <div className={styles.tags}>
            {tags.data?.items.map(({ name }) => {
              const pressed = filters.tag.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className={`tag ${pressed ? 'tag-accent' : 'tag-neutral'} ${styles.tagButton}`}
                  aria-pressed={pressed}
                  onClick={() => onChange({ ...filters, tag: toggle(filters.tag, name) })}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </Group>
      )}
      <Group title="Pessoas">
        {filters.person.length > 0 && (
          <div className={styles.tags}>
            {filters.person.map((id) => (
              <span key={id} className="tag tag-accent">
                {personName(id)}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Tirar ${personName(id)} do filtro`}
                  onClick={() => onChange({ ...filters, person: filters.person.filter((item) => item !== id) })}
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <PersonCombobox
          key={personPick}
          label="Filtrar por pessoa"
          placeholder="Qualquer pessoa"
          onSelect={(person) => {
            setPersonPick(personPick + 1)
            if (!filters.person.includes(person.id)) onChange({ ...filters, person: [...filters.person, person.id] })
          }}
        />
      </Group>
      {(collections.data?.items.length ?? 0) > 0 && (
        <Group title="Coleções">
          {collections.data?.items.map((collection) => (
            <Check
              key={collection.id}
              label={collection.name}
              checked={filters.collection.includes(collection.id)}
              onChange={() => onChange({ ...filters, collection: toggle(filters.collection, collection.id) })}
            />
          ))}
          <Link to="/colecoes" className={styles.manage}>
            Gerenciar coleções
          </Link>
        </Group>
      )}
      {own.map((field) => (
        <FieldFilter key={field.id} field={field} filters={filters} onChange={onChange} />
      ))}
    </>
  )
}

interface LibraryFiltersProps extends FilterProps {
  id: string
  collapsed: boolean
  onToggle: () => void
  onClear: () => void
}

/** O painel `.filters` à direita, recolhível até a faixa de 48px do DS. */
export function LibraryFilters({ id, collapsed, onToggle, onClear, filters, onChange }: LibraryFiltersProps) {
  const count = activeFilterCount(filters)
  return (
    <aside className="filters" id={id} aria-label="Filtros">
      <div className="filters-head">
        <h5 className={styles.filtersTitle}>
          Filtros{count > 0 && <span className={`badge badge-neutral ${styles.count}`}>{count}</span>}
        </h5>
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${styles.collapse}`}
          aria-label={collapsed ? 'Expandir filtros' : 'Recolher filtros'}
          aria-expanded={!collapsed}
          aria-controls={`${id}-grupos`}
          onClick={onToggle}
        >
          <PanelRight size={16} aria-hidden />
        </button>
      </div>
      {/* Recolhido, o CSS do DS esconde tudo menos o botão; o conteúdo fica montado. */}
      <div id={`${id}-grupos`} className={styles.groups}>
        {count > 0 && (
          <button type="button" className={`btn btn-ghost btn-sm ${styles.clear}`} onClick={onClear}>
            Limpar filtros
          </button>
        )}
        <FilterGroups filters={filters} onChange={onChange} />
      </div>
    </aside>
  )
}
