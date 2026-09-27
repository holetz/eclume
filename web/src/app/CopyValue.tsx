import { Copy } from 'lucide-react'
import { useState } from 'react'

interface CopyValueProps {
  value: string
  /** `lg` desenha o código de vínculo: 22px, letras espaçadas e largura curta. */
  size?: 'lg'
}

/** O `.code-block` do Design System: o valor, o botão Copiar e o anúncio "Copiado". */
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
