import { useState, type KeyboardEvent } from 'react'
import styles from './Organize.module.css'

interface TagInputProps {
  id: string
  value: string[]
  onChange: (value: string[]) => void
  /** O nome da lista ("Opções"), para quem usa leitor de tela. */
  listLabel: string
  /** Um item, no singular e feminino ("opção", "tag"): vira "Remover <item> …" e o texto do campo. */
  itemLabel: string
  placeholder?: string
  invalid?: boolean
  describedBy?: string
}

/** Uma lista de valores curtos como `.tag`: Enter acrescenta, e o × de cada um remove. */
export function TagInput({ id, value, onChange, listLabel, itemLabel, placeholder, invalid, describedBy }: TagInputProps) {
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
                aria-label={`Remover ${itemLabel} ${item}`}
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
        placeholder={placeholder ?? `Nova ${itemLabel} e Enter`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  )
}
