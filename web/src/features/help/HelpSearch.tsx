import { Search } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import type { SearchHit } from './search'

interface HelpSearchProps {
  value: string
  onChange: (value: string) => void
  inputRef?: Ref<HTMLInputElement>
  placeholder?: string
  /** Mostra o `.kbd` "/" do atalho que põe o foco na busca. */
  shortcut?: boolean
  className?: string
}

/** O `.help-search` do Design System: ícone, campo de busca e, opcionalmente, o atalho "/". */
export function HelpSearch({ value, onChange, inputRef, placeholder, shortcut, className }: HelpSearchProps) {
  return (
    <label className={className ? `help-search ${className}` : 'help-search'}>
      <Search size={18} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        aria-label="Buscar na ajuda"
        placeholder={placeholder ?? 'Buscar artigos e termos'}
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

/** O trecho de um resultado da busca, com os termos em `<mark>`. */
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
