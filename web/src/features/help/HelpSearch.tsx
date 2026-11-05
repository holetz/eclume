import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode, Ref } from 'react'
import type { SearchHit } from './search'

interface HelpSearchProps {
  value: string
  onChange: (value: string) => void
  inputRef?: Ref<HTMLInputElement>
  placeholder?: string
  /** Shows the "/" `.kbd` of the shortcut that focuses search. */
  shortcut?: boolean
  className?: string
}

/** The Design System `.help-search`: icon, search field and, optionally, the "/" shortcut. */
export function HelpSearch({ value, onChange, inputRef, placeholder, shortcut, className }: HelpSearchProps) {
  const { t } = useTranslation('shell')
  return (
    <label className={className ? `help-search ${className}` : 'help-search'}>
      <Search size={18} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        aria-label={t('helpCenter.search')}
        placeholder={placeholder ?? t('helpCenter.searchArticles')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {shortcut && (
        <kbd className="kbd" aria-hidden="true">
          /
        </kbd>
      )}
    </label>
  )
}

/** The snippet of a search result, with the terms in `<mark>`. */
export function Snippet({ snippet }: { snippet: NonNullable<SearchHit['snippet']> }) {
  const parts: ReactNode[] = []
  let at = 0
  snippet.marks.forEach(([start, end]) => {
    parts.push(snippet.text.slice(at, start), <mark key={start}>{snippet.text.slice(start, end)}</mark>)
    at = end
  })
  parts.push(snippet.text.slice(at))
  return <>{parts}</>
}
