import { Link, useSearchParams } from 'react-router'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from '../auth/AuthLayout'
import styles from './Connect.module.css'

/** "K7Q4MX" vira "K7Q-4MX", como a tela do código mostra. */
function formatCode(code: string): string {
  const clean = code.replace(/[^0-9a-z]/gi, '').toUpperCase()
  return clean.length === 6 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean
}

/**
 * Onde cai quem lê o QR com a câmera comum, sem o app: explica o que fazer. Pública e sem chamada à
 * API; o código só vale dentro do app.
 */
export function PairPage() {
  usePageTitle('Parear o celular')
  const [params] = useSearchParams()
  const code = params.get('codigo')

  return (
    <AuthLayout>
      <div className={styles.pair}>
        <h2>Parear o celular</h2>
        <p>Este código é para o app eclume. Abra o app no celular e toque em Ler um código.</p>
        {code && (
          <p>
            Código: <strong className="mono">{formatCode(code)}</strong>
          </p>
        )}
        <Link to="/entrar">Entrar no eclume</Link>
      </div>
    </AuthLayout>
  )
}
