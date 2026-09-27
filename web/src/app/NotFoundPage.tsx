import { Link } from 'react-router'
import { PageHead } from './PageHead'

export function NotFoundPage() {
  return (
    <section>
      <PageHead title="Página não encontrada" />
      <p className="text-muted">
        O endereço não existe ou mudou. <Link to="/">Voltar à biblioteca</Link>.
      </p>
    </section>
  )
}
