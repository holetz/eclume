import { externalDestinations, PURPOSE_LABEL, usePrivacy, type DataDestination } from '../../app/privacy'

interface ExternalDataNoticeProps {
  /** As finalidades que a tela configura. */
  purposes: DataDestination['purpose'][]
  /** Muda quando a configuração muda, para reler os destinos. */
  revision?: string | number
}

/** Avisa que uma finalidade manda dados para fora do servidor, e que os usuários veem isso em Conta. */
export function ExternalDataNotice({ purposes, revision }: ExternalDataNoticeProps) {
  const outside = externalDestinations(usePrivacy(revision).data).filter((d) => purposes.includes(d.purpose))
  if (outside.length === 0) return null
  return (
    <div className="alert alert-warning" role="note" aria-label="Dados fora do servidor">
      <p>
        Saem deste servidor:{' '}
        {outside
          .map((d) => `${PURPOSE_LABEL[d.purpose].toLocaleLowerCase('pt-BR')} (${d.processor ?? 'serviço externo'})`)
          .join(', ')}
        . Os usuários veem isso em Conta › Privacidade e dados e na linha do cadastro.
      </p>
    </div>
  )
}
