import { externalDestinations, PURPOSE_LABEL, usePrivacy, type DataDestination } from '../../app/privacy'

interface ExternalDataNoticeProps {
  /** The purposes the screen configures. */
  purposes: DataDestination['purpose'][]
  /** Changes when the configuration changes, to reread the destinations. */
  revision?: string | number
}

/** Warns that a purpose sends data outside the server, and that users see it in Conta. */
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
