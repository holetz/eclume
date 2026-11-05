import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './Organize.module.css'

interface TagInputProps {
  id: string
  value: string[]
  onChange: (value: string[]) => void
  /** The name of the list ("Opções"), for screen-reader users. */
  listLabel: string
  /** One item, singular and feminine ("opção", "tag"): it becomes "Remover <item> …" and the field text. */
  itemLabel: string
  invalid?: boolean
  describedBy?: string
}

/** A list of short values as `.tag`: Enter appends, and the × on each one removes it. */
export function TagInput({ id, value, onChange, listLabel, itemLabel, invalid, describedBy }: TagInputProps) {
  const { t } = useTranslation('organize')
  const [text, setText] = useState('')

  function add() {
    const item = text.trim()
    if (item && !value.includes(item)) onChange([...value, item])
    setText('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    add()
  }

  return (
    <div className={styles.tagInput}>
      {value.length > 0 && (
        <ul className={styles.tags} aria-label={listLabel}>
          {value.map((item) => (
            <li key={item} className="tag tag-neutral">
              {item}
              <button
                type="button"
                className={styles.tagRemove}
                aria-label={t('tagInput.remove', { item: itemLabel, value: item })}
                onClick={() => onChange(value.filter((other) => other !== item))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        className={`input ${styles.tagText}`}
        value={text}
        placeholder={t('tagInput.placeholder', { item: itemLabel })}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  )
}
