import { useState } from 'react'
import { errorMessage } from '../../api/problem'
import { formatDate, formatDuration } from '../library/format'
import type { Person } from './queries'
import { useDeleteVoiceprint, useVoiceprint, type Voiceprint } from './voice'
import styles from './VoiceSection.module.css'

/** Seção "Voz" da página da pessoa: a impressão de voz e esquecer a voz. */
export function VoiceSection({ person }: { person: Person }) {
  const voiceprint = useVoiceprint(person.id)
  return (
    <section className={`card ${styles.voice}`} aria-labelledby="pessoa-voz">
      <h2 id="pessoa-voz">Voz</h2>
      {voiceprint.isPending && <p role="status">Carregando a impressão de voz…</p>}
      {voiceprint.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(voiceprint.error)}
        </p>
      )}
      {voiceprint.isSuccess && <VoiceDetail person={person} voiceprint={voiceprint.data} />}
    </section>
  )
}

function VoiceDetail({ person, voiceprint }: { person: Person; voiceprint: Voiceprint }) {
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')
  const remove = useDeleteVoiceprint(person.id)

  return (
    <div className={styles.body}>
      {!voiceprint.enabled && (
        <p className="alert alert-warning">
          A identificação por voz está desligada: nada é comparado e nenhuma amostra é guardada.
        </p>
      )}
      <p className={styles.detail}>
        {voiceprint.sample_count === 0
          ? 'Nenhuma amostra na impressão de voz.'
          : voiceprint.sample_count === 1
            ? '1 amostra na impressão de voz (um locutor confirmado).'
            : `${voiceprint.sample_count} amostras na impressão de voz (locutores confirmados).`}{' '}
        Uma amostra entra quando você liga um locutor a esta pessoa.
      </p>

      {!deleting && voiceprint.sample_count > 0 && (
        <div className={styles.actions}>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            Esquecer a voz
          </button>
        </div>
      )}
      {deleting && (
        <Confirm
          message="Esquecer apaga todas as amostras da impressão de voz e as sugestões pendentes desta pessoa. Os vínculos já confirmados ficam."
          action="Confirmar: esquecer a voz"
          pending={remove.isPending}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                setDeleting(false)
                setNotice('Voz esquecida.')
              },
            })
          }
          onCancel={() => setDeleting(false)}
        />
      )}
      {remove.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>

      {voiceprint.samples.length > 0 && (
        <details className={styles.samples}>
          <summary>Amostras da impressão</summary>
          <ul aria-label="Amostras da impressão de voz">
            {voiceprint.samples.map((sample) => (
              <li key={`${sample.transcript_id}/${sample.speaker_id}`}>
                <span>{sample.recording_title ?? 'Gravação excluída'}</span>
                <span className={styles.detail}>
                  {formatDuration(sample.talk_ms)} de fala · confirmada em {formatDate(sample.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Confirm({
  message,
  action,
  pending,
  onConfirm,
  onCancel,
}: {
  message: string
  action: string
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={styles.form}>
      <p className="alert alert-warning">{message}</p>
      <div className={styles.actions}>
        <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={pending}>
          {action}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Manter
        </button>
      </div>
    </div>
  )
}
