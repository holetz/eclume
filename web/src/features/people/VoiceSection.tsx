import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { HelpHint } from '../../app/HelpHint'
import { formatDate, formatDuration } from '../library/format'
import type { Person } from './queries'
import { useDeleteVoiceprint, useVoiceprint, type Voiceprint } from './voice'
import styles from './VoiceSection.module.css'

/** A aba "Amostras de voz" da pessoa: as amostras da impressão de voz e "Esquecer a voz". */
export function VoiceSection({ person }: { person: Person }) {
  const voiceprint = useVoiceprint(person.id)
  return (
    <div className={styles.voice}>
      {voiceprint.isPending && <p role="status">Carregando as amostras de voz…</p>}
      {voiceprint.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(voiceprint.error)}
        </p>
      )}
      {voiceprint.isSuccess && <VoiceDetail person={person} voiceprint={voiceprint.data} />}
    </div>
  )
}

function VoiceDetail({ person, voiceprint }: { person: Person; voiceprint: Voiceprint }) {
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const remove = useDeleteVoiceprint(person.id)

  return (
    <>
      {!voiceprint.enabled && (
        <p className="alert alert-warning">
          A identificação por voz está desligada neste servidor: nada é comparado e nenhuma amostra é guardada.
        </p>
      )}
      {voiceprint.samples.length > 0 ? (
        <ul className={`list ${styles.samples}`} aria-label="Amostras de voz">
          {voiceprint.samples.map((sample) => (
            <li key={`${sample.transcript_id}/${sample.speaker_id}`} className="list-row">
              <span className="list-row-title">{sample.recording_title ?? 'Gravação excluída'}</span>
              <span className="list-row-sub mono">
                {formatDuration(sample.talk_ms)} de fala · confirmada em {formatDate(sample.created_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">Nenhuma amostra de voz ainda.</p>
      )}
      <p className={styles.detail}>
        Uma amostra entra quando você liga um locutor a esta pessoa na página da gravação.{' '}
        <Link to="/ajuda/sugestoes-por-voz">Como funcionam as sugestões por voz</Link>{' '}
        <HelpHint subject="a impressão de voz" title="Impressão de voz" article="esquecer-a-voz">
          As amostras são os trechos em que você confirmou que um locutor era esta pessoa. Esquecer a voz
          apaga todas, e os vínculos confirmados ficam.
        </HelpHint>
      </p>
      {voiceprint.sample_count > 0 && (
        <div>
          <button type="button" className="btn btn-secondary btn-danger" onClick={() => setConfirming(true)}>
            Esquecer a voz
          </button>
        </div>
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      {confirming && (
        <Dialog
          plain
          title="Esquecer a voz?"
          message="Apaga todas as amostras e as sugestões pendentes desta pessoa. Os vínculos já confirmados ficam."
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
                Manter
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      setConfirming(false)
                      setNotice('Voz esquecida.')
                    },
                  })
                }
              >
                Esquecer a voz
              </button>
            </>
          }
        >
          {remove.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(remove.error)}
            </p>
          )}
        </Dialog>
      )}
    </>
  )
}
