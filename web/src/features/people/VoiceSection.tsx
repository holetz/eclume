import { useId, useState, type FormEvent } from 'react'
import { errorMessage } from '../../api/problem'
import { formatDate, formatDateTime, formatDuration } from '../library/format'
import type { Person } from './queries'
import { useDeleteVoiceprint, useExportVoiceprint, useSetConsent, useVoiceprint, type Voiceprint } from './voice'
import styles from './VoiceSection.module.css'

const STATUS = {
  granted: { text: 'Consentimento registrado', badge: 'badge badge-success' },
  revoked: { text: 'Consentimento revogado', badge: 'badge badge-warning' },
  none: { text: 'Sem consentimento', badge: 'badge' },
} as const

/** Seção "Voz" da página da pessoa: consentimento LGPD, impressão de voz, exclusão e exportação. */
export function VoiceSection({ person, isAdmin }: { person: Person; isAdmin: boolean }) {
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
      {voiceprint.isSuccess && <VoiceDetail person={person} voiceprint={voiceprint.data} isAdmin={isAdmin} />}
    </section>
  )
}

type Mode = 'idle' | 'granting' | 'revoking' | 'deleting'

function VoiceDetail({ person, voiceprint, isAdmin }: { person: Person; voiceprint: Voiceprint; isAdmin: boolean }) {
  const [mode, setMode] = useState<Mode>('idle')
  const [notice, setNotice] = useState('')
  const consent = voiceprint.consent
  const status = STATUS[consent.status as keyof typeof STATUS] ?? { text: consent.status, badge: 'badge' }
  const setConsent = useSetConsent(person.id)
  const remove = useDeleteVoiceprint(person.id)
  const download = useExportVoiceprint(person.id, person.name)
  const done = (message: string) => {
    setMode('idle')
    setNotice(message)
  }

  return (
    <div className={styles.body}>
      <p className={styles.state}>
        <span className={status.badge}>{status.text}</span>
        {consent.updated_at && (
          <span className={styles.detail}>
            {consent.recorded_by ? `por ${consent.recorded_by.name}, ` : ''}em {formatDateTime(consent.updated_at)}
            {consent.term_version ? ` · termo v${consent.term_version}` : ''}
          </span>
        )}
      </p>
      {!voiceprint.opt_in && (
        <p className="alert alert-warning">
          A identificação por voz está desligada nesta organização: nada é comparado e nenhuma amostra é guardada.
        </p>
      )}
      <p className={styles.detail}>
        {voiceprint.sample_count === 0
          ? 'Nenhuma amostra na impressão de voz.'
          : voiceprint.sample_count === 1
            ? '1 amostra na impressão de voz (um locutor confirmado).'
            : `${voiceprint.sample_count} amostras na impressão de voz (locutores confirmados).`}{' '}
        Uma amostra entra quando alguém liga um locutor a esta pessoa com o consentimento registrado.
      </p>

      {mode === 'idle' && (
        <div className={styles.actions}>
          {consent.status === 'granted' ? (
            <button type="button" className="btn btn-secondary" onClick={() => setMode('revoking')}>
              Revogar consentimento
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setMode('granting')}>
              Registrar consentimento
            </button>
          )}
          {voiceprint.sample_count > 0 && (
            <button type="button" className="btn btn-danger" onClick={() => setMode('deleting')}>
              Excluir impressão
            </button>
          )}
          {isAdmin && (
            <button type="button" className="btn btn-ghost" onClick={() => download.mutate()} disabled={download.isPending}>
              Exportar dados de voz
            </button>
          )}
        </div>
      )}

      {mode === 'granting' && (
        <GrantForm
          voiceprint={voiceprint}
          pending={setConsent.isPending}
          onCancel={() => setMode('idle')}
          onSubmit={(notes) =>
            setConsent.mutate({ status: 'granted', notes }, { onSuccess: () => done('Consentimento registrado.') })
          }
        />
      )}
      {mode === 'revoking' && (
        <Confirm
          message="Revogar apaga a impressão de voz e as sugestões pendentes desta pessoa. Os vínculos já confirmados ficam."
          action="Confirmar revogação"
          pending={setConsent.isPending}
          onConfirm={() =>
            setConsent.mutate({ status: 'revoked' }, { onSuccess: () => done('Consentimento revogado e impressão apagada.') })
          }
          onCancel={() => setMode('idle')}
        />
      )}
      {mode === 'deleting' && (
        <Confirm
          message="Excluir apaga todas as amostras da impressão de voz. O consentimento continua registrado."
          action="Confirmar exclusão da impressão"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => done('Impressão de voz excluída.') })}
          onCancel={() => setMode('idle')}
        />
      )}
      {[setConsent, remove, download].map(
        (mutation, index) =>
          mutation.isError && (
            <p key={index} className="alert alert-error" role="alert">
              {errorMessage(mutation.error)}
            </p>
          ),
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
                <span>{sample.recording_title ?? 'Gravação que você não vê'}</span>
                <span className={styles.detail}>
                  {formatDuration(sample.talk_ms)} de fala · confirmada em {formatDate(sample.created_at)}
                  {sample.created_by ? ` por ${sample.created_by.name}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function GrantForm({
  voiceprint,
  pending,
  onSubmit,
  onCancel,
}: {
  voiceprint: Voiceprint
  pending: boolean
  onSubmit: (notes: string | null) => void
  onCancel: () => void
}) {
  const [notes, setNotes] = useState('')
  const [agreed, setAgreed] = useState(false)
  const notesId = useId()
  const termId = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (agreed) onSubmit(notes.trim() || null)
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Registrar consentimento de voz">
      <p className={styles.termTitle} id={termId}>
        Termo de consentimento (versão {voiceprint.term.version})
      </p>
      <blockquote className={styles.term} aria-labelledby={termId}>
        {voiceprint.term.text}
      </blockquote>
      <div className="field">
        <label htmlFor={notesId}>Como o consentimento foi colhido</label>
        <textarea
          id={notesId}
          className="input"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Termo assinado, e-mail, ata da reunião…"
        />
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        A pessoa leu e aceitou este termo
      </label>
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={!agreed || pending}>
          Registrar
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
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
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Manter
        </button>
      </div>
    </div>
  )
}
