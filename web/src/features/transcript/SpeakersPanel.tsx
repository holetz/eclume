import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'

import { PEOPLE_KEY } from '../people/queries'
import { PersonCombobox } from '../people/PersonCombobox'
import { transcriptKey, updateTranscriptCache } from './queries'
import { speakerColorIndex, speakerName, type Speaker, type Transcript } from './segments'
import styles from './SpeakersPanel.module.css'
import { formatDuration } from '../../shared/format'

export function SpeakersPanel({ transcript }: { transcript: Transcript }) {
  const [merging, setMerging] = useState(false)
  const [notice, setNotice] = useState('')
  const titleId = useId()
  const { speakers } = transcript

  return (
    <section id="locutores" tabIndex={-1} className={styles.panel} aria-labelledby={titleId}>
      <h6 id={titleId}>Locutores</h6>
      <ul className={styles.list}>
        {speakers.map((speaker) => (
          <SpeakerItem
            key={speaker.id}
            transcriptId={transcript.id}
            speaker={speaker}
            color={speakerColorIndex(speakers, speaker.id)}
          />
        ))}
      </ul>
      <p className="visually-hidden" role="status">
        {notice}
      </p>
      {speakers.length > 1 &&
        (merging ? (
          <MergeForm
            transcript={transcript}
            onDone={(message) => {
              setMerging(false)
              setNotice(message)
            }}
          />
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMerging(true)}>
            Mesclar locutores
          </button>
        ))}
    </section>
  )
}

function SpeakerItem({ transcriptId, speaker, color }: { transcriptId: string; speaker: Speaker; color: number }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [label, setLabel] = useState(speaker.label)
  const inputId = useId()
  const patch = (body: { label?: string; person_id?: string | null }) =>
    unwrap(
      api.PATCH('/api/v1/transcripts/{transcript_id}/speakers/{speaker_id}', {
        params: { path: { transcript_id: transcriptId, speaker_id: speaker.id } },
        body,
      }),
    )
  const apply = (updated: Speaker) =>
    updateTranscriptCache(queryClient, transcriptId, (t) => ({
      ...t,
      speakers: t.speakers.map((s) => (s.id === updated.id ? updated : s)),
    }))
  const rename = useMutation({
    mutationFn: (newLabel: string) => patch({ label: newLabel }),
    onSuccess: (updated) => {
      apply(updated)
      setEditing(false)
    },
  })
  // Ligar ou desligar muda contagens, falas e impressões de voz no diretório de pessoas.
  const link = useMutation({
    mutationFn: (personId: string | null) => patch({ person_id: personId }),
    onSuccess: (updated) => {
      apply(updated)
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      setLinking(false)
    },
  })
  const reject = useMutation({
    mutationFn: (personId: string) =>
      unwrap(
        api.DELETE('/api/v1/transcripts/{transcript_id}/speakers/{speaker_id}/suggestions/{person_id}', {
          params: { path: { transcript_id: transcriptId, speaker_id: speaker.id, person_id: personId } },
        }),
      ),
    onSuccess: apply,
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = label.trim()
    if (value) rename.mutate(value)
  }

  const name = speakerName(speaker)
  const suggestions = speaker.person ? [] : (speaker.suggestions ?? [])
  const idle = !editing && !linking
  const deciding = link.isPending || reject.isPending

  return (
    <li className={styles.item} data-speaker={color}>
      <div className={styles.row}>
        <span className={styles.dot} aria-hidden="true" />
        <div className={styles.info}>
          <span className={styles.name}>{name}</span>
          <span className={styles.detail}>
            {speaker.person ? (
              <>
                Pessoa: <Link to={`/pessoas/${speaker.person.id}`}>{speaker.person.name}</Link>
              </>
            ) : (
              'Sem pessoa ligada'
            )}
          </span>
          {speaker.talk_ms != null && (
            <span className={styles.detail}>{formatDuration(speaker.talk_ms)} de fala</span>
          )}
        </div>
      </div>
      {idle && speaker.person && speaker.auto_score != null && (
        <div className={styles.suggestion}>
          <span>
            Atribuído pela voz — {Math.round(speaker.auto_score * 100)}%
          </span>
          <span className={styles.buttons}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => link.mutate(speaker.person!.id)}
              disabled={deciding}
              aria-label={`Confirmar ${speaker.person.name} para ${name}`}
            >
              Confirmar
            </button>
          </span>
        </div>
      )}
      {idle && suggestions.length > 0 && (
        <ul className={styles.suggestions} aria-label={`Sugestões por voz para ${name}`}>
          {suggestions.map((suggestion) => (
            <li key={suggestion.person.id} className={styles.suggestion}>
              <span>
                Parece ser <strong>{suggestion.person.name}</strong> — {Math.round(suggestion.score * 100)}%
              </span>
              <span className={styles.buttons}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => link.mutate(suggestion.person.id)}
                  disabled={deciding}
                  aria-label={`Aceitar ${suggestion.person.name} para ${name}`}
                >
                  Aceitar
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => reject.mutate(suggestion.person.id)}
                  disabled={deciding}
                  aria-label={`Recusar ${suggestion.person.name} para ${name}`}
                >
                  Recusar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {idle && (
        <div className={styles.buttons}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setLabel(speaker.label)
              rename.reset()
              setEditing(true)
            }}
            aria-label={`Renomear ${name}`}
          >
            Renomear
          </button>
          {speaker.person ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => link.mutate(null)}
              disabled={link.isPending}
              aria-label={`Desligar ${name} de ${speaker.person.name}`}
            >
              Desligar pessoa
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                link.reset()
                setLinking(true)
              }}
              aria-label={`Ligar ${name} a uma pessoa`}
            >
              Ligar a pessoa
            </button>
          )}
        </div>
      )}
      {linking && (
        <PersonCombobox
          label={`Pessoa para ${name}`}
          onSelect={(person) => link.mutate(person.id)}
          onCancel={() => setLinking(false)}
        />
      )}
      {(link.isError || reject.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(link.error ?? reject.error)}
        </p>
      )}
      {editing && (
        <form className={styles.form} onSubmit={submit}>
          <label htmlFor={inputId} className="visually-hidden">
            Novo nome de {name}
          </label>
          <input
            id={inputId}
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
            autoFocus
          />
          <div className={styles.actions}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={rename.isPending || !label.trim()}>
              Salvar
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
          {rename.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(rename.error)}
            </p>
          )}
        </form>
      )}
    </li>
  )
}

function MergeForm({ transcript, onDone }: { transcript: Transcript; onDone: (message: string) => void }) {
  const queryClient = useQueryClient()
  const { speakers } = transcript
  const [target, setTarget] = useState(speakers[0].id)
  const [sources, setSources] = useState<string[]>([])
  const targetId = useId()
  const merge = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/transcripts/{transcript_id}/speakers/merge', {
          params: { path: { transcript_id: transcript.id } },
          body: { source_speaker_ids: sources, target_speaker_id: target },
        }),
      ),
    onSuccess: (merged) => {
      queryClient.setQueryData(transcriptKey(transcript.id), merged)
      const names = speakers.filter((s) => sources.includes(s.id)).map(speakerName)
      const into = speakerName(speakers.find((s) => s.id === target))
      onDone(`${names.join(', ')} mesclado em ${into}.`)
    },
  })
  const candidates = speakers.filter((s) => s.id !== target)
  const chosen = sources.filter((id) => id !== target)

  function toggle(id: string, checked: boolean) {
    setSources((current) => (checked ? [...current, id] : current.filter((s) => s !== id)))
  }

  return (
    <form
      className={styles.merge}
      onSubmit={(event) => {
        event.preventDefault()
        if (chosen.length > 0) merge.mutate()
      }}
    >
      <div className="field">
        <label htmlFor={targetId}>Manter o locutor</label>
        <select
          id={targetId}
          className="input"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value)
            setSources((current) => current.filter((id) => id !== event.target.value))
          }}
        >
          {speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {speakerName(s)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className={styles.sources}>
        <legend className="field-label">Juntar a ele</legend>
        {candidates.map((s) => (
          <label key={s.id} className={styles.check}>
            <input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
            {speakerName(s)}
          </label>
        ))}
      </fieldset>
      <p className={styles.detail}>
        As falas dos locutores marcados passam para o que fica, e eles deixam de existir. Não dá para desfazer.
      </p>
      {merge.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(merge.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={merge.isPending || chosen.length === 0}>
          Mesclar
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onDone('')}>
          Cancelar
        </button>
      </div>
    </form>
  )
}
