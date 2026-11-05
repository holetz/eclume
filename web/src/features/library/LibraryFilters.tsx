import { PanelRight, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { useCollections } from '../collections/queries'
import { usePeopleOptions, usePersonFacets } from '../people/queries'
import { useTags } from '../tags/queries'
import { PersonCombobox } from '../people/PersonCombobox'
import {
  activeFilterCount,
  KINDS,
  STATUS_GROUPS,
  type KindParam,
  type LibraryFilters,
  type NeedsParam,
  type StatusParam,
} from './filters'
import styles from './LibraryPage.module.css'
import { useUserFields } from './queries'

type Field = Schemas['Field']

interface FilterProps {
  filters: LibraryFilters
  onChange: (filters: LibraryFilters) => void
}

/**
 * Checks or unchecks in a group where "nothing in the URL" is "everything checked" (kind and status): everything checked
 * goes back to not sending the parameter, and the last checked one does not leave.
 */
function toggleAll<T extends string>(selected: T[], all: T[], value: T): T[] {
  const current = selected.length === 0 ? all : selected
  const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
  if (next.length === 0) return selected
  return next.length === all.length ? [] : all.filter((item) => next.includes(item))
}

/** Checks or unchecks in a group where nothing checked is "any" (tags, collections, options). */
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
  const { t } = useTranslation('library')
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
        placeholder={t('filters.anyValue')}
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

type ParticipantKey = 'personCompany' | 'personDepartment' | 'personTag'

/**
 * Participants: company, department and person tag of whoever spoke in the recording, with the values in use
 * in the directory. Combined, they apply to one same person.
 */
function ParticipantFilter({ filters, onChange }: FilterProps) {
  const { t } = useTranslation('library')
  const facets = usePersonFacets()
  const sections: { key: ParticipantKey; title: string; values: string[] }[] = [
    { key: 'personCompany', title: t('filters.company'), values: facets.data?.companies.map((f) => f.value) ?? [] },
    { key: 'personDepartment', title: t('filters.department'), values: facets.data?.departments.map((f) => f.value) ?? [] },
    { key: 'personTag', title: t('filters.personTag'), values: facets.data?.tags.map((f) => f.value) ?? [] },
  ]
  const visible = sections.filter((section) => section.values.length > 0 || filters[section.key].length > 0)
  if (visible.length === 0) return null
  return (
    <Group title={t('filters.participants')}>
      <p className={`field-hint ${styles.participantHint}`}>{t('filters.participantsHint')}</p>
      {visible.map(({ key, title, values }) => {
        // A checked value that left the directory stays in the list, so it can be unchecked.
        const all = [...values, ...filters[key].filter((value) => !values.includes(value))]
        return (
          <div key={key} className={styles.participantSection} role="group" aria-label={title}>
            <span className="kicker">{title}</span>
            {all.map((value) => (
              <Check
                key={value}
                label={value}
                checked={filters[key].includes(value)}
                onChange={() => onChange({ ...filters, [key]: toggle(filters[key], value) })}
              />
            ))}
          </div>
        )
      })}
    </Group>
  )
}

/** The library filter groups: in the right-hand panel or, on a narrow screen, in a dialog. */
export function FilterGroups({ filters, onChange }: FilterProps) {
  const { t } = useTranslation('library')
  const tags = useTags()
  const collections = useCollections()
  const fields = useUserFields()
  const people = usePeopleOptions()
  const kinds = Object.keys(KINDS) as KindParam[]
  const statuses = Object.keys(STATUS_GROUPS) as StatusParam[]
  const personName = (id: string) => people.data?.items.find((person) => person.id === id)?.name ?? t('filters.person')
  const own = (fields.data?.items ?? []).filter((field) => field.builtin === null)
  // After choosing, the combobox comes back empty (it is remounted) for the next person.
  const [personPick, setPersonPick] = useState(0)

  return (
    <>
      <Group title={t('filters.kind')}>
        {kinds.map((kind) => {
          const checked = filters.kind.length === 0 || filters.kind.includes(kind)
          return (
            <Check
              key={kind}
              label={t(`filters.kinds.${kind}`)}
              checked={checked}
              disabled={checked && filters.kind.length === 1}
              onChange={() => onChange({ ...filters, kind: toggleAll(filters.kind, kinds, kind) })}
            />
          )
        })}
      </Group>
      <Group title={t('filters.needs')}>
        <Check
          label={t('filters.awaitingSpeakers')}
          checked={filters.needs.includes('locutores')}
          onChange={() => onChange({ ...filters, needs: toggle(filters.needs, 'locutores') as NeedsParam[] })}
        />
      </Group>
      <Group title={t('filters.status')}>
        {statuses.map((status) => {
          const checked = filters.status.length === 0 || filters.status.includes(status)
          return (
            <Check
              key={status}
              label={t(`filters.statuses.${status}`)}
              checked={checked}
              disabled={checked && filters.status.length === 1}
              onChange={() => onChange({ ...filters, status: toggleAll(filters.status, statuses, status) })}
            />
          )
        })}
      </Group>
      {(tags.data?.items.length ?? 0) > 0 && (
        <Group title={t('filters.tags')}>
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
      <Group title={t('filters.people')}>
        {filters.person.length > 0 && (
          <div className={styles.tags}>
            {filters.person.map((id) => (
              <span key={id} className="tag tag-accent">
                {personName(id)}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={t('filters.removePerson', { name: personName(id) })}
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
          label={t('filters.pickPerson')}
          placeholder={t('filters.anyPerson')}
          onSelect={(person) => {
            setPersonPick(personPick + 1)
            if (!filters.person.includes(person.id)) onChange({ ...filters, person: [...filters.person, person.id] })
          }}
        />
      </Group>
      <ParticipantFilter filters={filters} onChange={onChange} />
      {(collections.data?.items.length ?? 0) > 0 && (
        <Group title={t('filters.collections')}>
          {collections.data?.items.map((collection) => (
            <Check
              key={collection.id}
              label={collection.name}
              checked={filters.collection.includes(collection.id)}
              onChange={() => onChange({ ...filters, collection: toggle(filters.collection, collection.id) })}
            />
          ))}
          <Link to="/colecoes" className={styles.manage}>
            {t('filters.manageCollections')}
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

/** The `.filters` panel on the right, collapsible down to the DS 48px strip. */
export function LibraryFilters({ id, collapsed, onToggle, onClear, filters, onChange }: LibraryFiltersProps) {
  const { t } = useTranslation('library')
  const count = activeFilterCount(filters)
  return (
    <aside className="filters" id={id} aria-label={t('filters.label')}>
      <div className="filters-head">
        <h5 className={styles.filtersTitle}>
          {t('filters.title')}
          {count > 0 && <span className={`badge badge-neutral ${styles.count}`}>{count}</span>}
        </h5>
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${styles.collapse}`}
          aria-label={collapsed ? t('filters.expand') : t('filters.collapse')}
          aria-expanded={!collapsed}
          aria-controls={`${id}-grupos`}
          onClick={onToggle}
        >
          <PanelRight size={16} aria-hidden />
        </button>
      </div>
      {/* Collapsed, the DS CSS hides everything but the button; the content stays mounted. */}
      <div id={`${id}-grupos`} className={styles.groups}>
        {count > 0 && (
          <button type="button" className={`btn btn-ghost btn-sm ${styles.clear}`} onClick={onClear}>
            {t('filters.clear')}
          </button>
        )}
        <FilterGroups filters={filters} onChange={onChange} />
      </div>
    </aside>
  )
}
