import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { HelpHint } from '../../app/HelpHint'

import type { Person } from './queries'
import { useDeleteVoiceSample, useDeleteVoiceprint, useVoiceprint, type Voiceprint } from './voice'
import styles from './VoiceSection.module.css'
import { formatDate, formatDuration } from '../../shared/format'

/** The person's "Amostras de voz" tab: listen to and remove each sample of the voiceprint, and "Esquecer a voz". */
export function VoiceSection({ person }: { person: Person }) {
  const { t } = useTranslation('people')
  const voiceprint = useVoiceprint(person.id)
  return (
    <div className={styles.voice}>
      {voiceprint.isPending && <p role="status">{t('voice.loading')}</p>}
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
  const { t } = useTranslation('people')
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const remove = useDeleteVoiceprint(person.id)
  const removeSample = useDeleteVoiceSample(person.id)
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState<Sample | null>(null)

  function toggle(sample: Sample) {
    const el = audio.current
    if (!el || !sample.recording_id || !sample.excerpt) return
    if (playing && sampleKey(playing) === sampleKey(sample)) {
      el.pause()
      setPlaying(null)
      return
    }
    const src = `/api/v1/recordings/${sample.recording_id}/audio`
    if (!el.src.endsWith(src)) el.src = src
    el.currentTime = sample.excerpt.start_ms / 1000
    setPlaying(sample)
    Promise.resolve(el.play()).catch(() => setPlaying(null))
  }

  function stopAtEnd() {
    const el = audio.current
    if (el && playing?.excerpt && el.currentTime * 1000 >= playing.excerpt.end_ms) {
      el.pause()
      setPlaying(null)
    }
  }

  return (
    <>
      {!voiceprint.enabled && (
        <p className="alert alert-warning">
          {t('voice.off')}
        </p>
      )}
      {voiceprint.samples.length > 0 ? (
        <ul className={`list ${styles.samples}`} aria-label={t('tab.amostras')}>
          {voiceprint.samples.map((sample) => (
            <li key={sampleKey(sample)} className="list-row">
              <span className="list-row-title">{sample.recording_title ?? t('voice.deletedRecording')}</span>
              <span className="list-row-sub mono">
                {t('voice.sampleLine', { duration: formatDuration(sample.talk_ms), date: formatDate(sample.created_at) })}
              </span>
              <span className="list-row-actions">
                {sample.recording_id && sample.excerpt && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    aria-label={
                      playing && sampleKey(playing) === sampleKey(sample)
                        ? t('voice.pause')
                        : t('voice.listen', { title: sample.recording_title ?? t('voice.recording') })
                    }
                    aria-pressed={playing ? sampleKey(playing) === sampleKey(sample) : false}
                    onClick={() => toggle(sample)}
                  >
                    {playing && sampleKey(playing) === sampleKey(sample) ? <PauseIcon /> : <PlayIcon />}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={removeSample.isPending}
                  onClick={() =>
                    removeSample.mutate(
                      { transcript_id: sample.transcript_id, speaker_id: sample.speaker_id },
                      {
                        onSuccess: () => {
                          if (playing && sampleKey(playing) === sampleKey(sample)) {
                            audio.current?.pause()
                            setPlaying(null)
                          }
                          setNotice(t('voice.removed'))
                        },
                      },
                    )
                  }
                >
                  {t('voice.remove')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t('voice.none')}</p>
      )}
      <audio ref={audio} preload="none" onTimeUpdate={stopAtEnd} onEnded={() => setPlaying(null)} hidden />
      {removeSample.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(removeSample.error)}
        </p>
      )}
      <p className={styles.detail}>
        {t('voice.detail')} <Link to="/ajuda/voice-suggestions">{t('voice.howItWorks')}</Link>{' '}
        <HelpHint subject={t('voice.hintSubject')} title={t('voice.hintTitle')} article="forget-a-voice">
          {t('voice.hint')}
        </HelpHint>
      </p>
      {voiceprint.sample_count > 0 && (
        <div>
          <button type="button" className="btn btn-secondary btn-danger" onClick={() => setConfirming(true)}>
            {t('voice.forget')}
          </button>
        </div>
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      {confirming && (
        <Dialog
          plain
          title={t('voice.forgetTitle')}
          message={t('voice.forgetText')}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
                {t('person.keep')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      setConfirming(false)
                      setNotice(t('voice.forgotten'))
                    },
                  })
                }
              >
                {t('voice.forget')}
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

type Sample = Voiceprint['samples'][number]

const sampleKey = (sample: Sample) => `${sample.transcript_id}/${sample.speaker_id}`

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4l14 8-14 8z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
    </svg>
  )
}
