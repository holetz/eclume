import { Copy } from 'lucide-react'
import { useState } from 'react'

interface CopyValueProps {
  value: string
  /** `lg` draws the link code: 22px, spaced letters and a short width. */
  size?: 'lg'
}

/** The Design System `.code-block`: the value, the "Copiar" button and the "Copiado" announcement. */
export function CopyValue({ value, size }: CopyValueProps) {
  const [status, setStatus] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setStatus('Copiado')
    } catch {
      setStatus('Não foi possível copiar. Selecione o texto e copie.')
    }
  }

  return (
    <div className={size === 'lg' ? 'code-block code-block-lg' : 'code-block'}>
      <span>{value}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        <Copy size={14} aria-hidden />
        Copiar
      </button>
      <span className="visually-hidden" role="status">
        {status}
      </span>
    </div>
  )
}
