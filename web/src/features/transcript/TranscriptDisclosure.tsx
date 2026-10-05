import { useEffect, useMemo, useRef, useState } from 'react'

import { placeMarkers, type Marker } from './markers'
import { usePlayback, usePlaybackSelect } from './playback'
import { scrollWithin } from './scroll'
import { SegmentMarker, SegmentRow } from './SegmentRow'
import { findSegmentAt, speakerColorIndex, speakerName, type Transcript } from './segments'
import { SpeakersPanel } from './SpeakersPanel'
import styles from './TranscriptView.module.css'
import { markersLabel } from '../../shared/format'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const NO_MARKERS: Marker[] = []

function Segments({
  transcript,
  markers,
  recordingId,
  anchorMs,
}: {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
  anchorMs: number | null
}) {
  const { seek } = usePlayback()
  const listRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { segments, speakers } = transcript
  // Só a troca de fala ativa renderiza a lista; o tick que não a troca não chega aqui.
  const active = usePlaybackSelect((ms) => findSegmentAt(segments, ms))
  // Nome e cor do locutor e os marcadores de cada fala, calculados uma vez por transcrição.
  const who = useMemo(
    () =>
      segments.map((segment) => ({
        name: speakerName(speakers.find((item) => item.id === segment.speaker_id)),
        color: speakerColorIndex(speakers, segment.speaker_id),
      })),
    [segments, speakers],
  )
  const markersAt = useMemo(() => {
    const byIndex = new Map<number, Marker[]>()
    placeMarkers(segments, markers).forEach((index, position) => {
      byIndex.set(index, [...(byIndex.get(index) ?? []), markers[position]])
    })
    return byIndex
  }, [segments, markers])

  const anchored = useRef(false)

  // Aberta pela URL com `?t=` (busca, fonte do chat, marcador): uma vez, traz a lista à janela e
  // centra nela a fala do instante.
  useEffect(() => {
    const list = listRef.current
    if (anchored.current || anchorMs === null || !list) return
    anchored.current = true
    const index = findSegmentAt(segments, anchorMs)
    if (index < 0) return
    list.scrollIntoView({ block: 'nearest' })
    scrollWithin(list, list.children[index], 'center')
  }, [anchorMs, segments])

  // Acompanhar o áudio rola só a lista, que é o contêiner com rolagem própria: `scrollIntoView` na
  // fala rolaria também a página e tiraria o player da tela.
  useEffect(() => {
    const list = listRef.current
    if (!follow || active < 0 || !list?.children[active]) return
    scrollWithin(list, list.children[active], 'nearest', 'smooth')
  }, [active, follow])

  return (
    <>
      <label className={`check ${styles.follow}`}>
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
        <span className="box" />
        <span>Acompanhar o áudio</span>
      </label>
      {segments.length === 0 ? (
        <p className="text-muted">A transcrição não tem falas.</p>
      ) : (
        <div ref={listRef} role="list" aria-label="Falas" className={styles.scroller}>
          {segments.map((segment, index) => (
            <SegmentRow
              key={segment.id}
              segment={segment}
              name={who[index].name}
              color={who[index].color}
              markers={markersAt.get(index) ?? NO_MARKERS}
              active={index === active}
              editing={editingId === segment.id}
              transcriptId={transcript.id}
              recordingId={recordingId}
              onSeek={seek}
              onEdit={setEditingId}
            />
          ))}
        </div>
      )}
      {(markersAt.get(segments.length) ?? NO_MARKERS).map((marker) => (
        <SegmentMarker key={marker.id} marker={marker} recordingId={recordingId} />
      ))}
    </>
  )
}

interface TranscriptDisclosureProps {
  transcript: Transcript
  markers: Marker[]
  recordingId: string
  /** O instante do `?t=` da URL, para a rolagem única até a fala dele. */
  anchorMs?: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * A transcrição recolhida (`details.disclosure`): o resumo diz locutores, falas e marcadores; aberta,
 * traz o bloco Locutores e as falas com os marcadores. As falas só renderizam com ela aberta.
 */
export function TranscriptDisclosure({
  transcript,
  markers,
  recordingId,
  anchorMs = null,
  open,
  onOpenChange,
}: TranscriptDisclosureProps) {
  return (
    <details
      className={`disclosure ${styles.disclosure}`}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onOpenChange(event.currentTarget.open)
      }}
    >
      <summary>
        Transcrição
        <span className="text-muted">
          {plural(transcript.speakers.length, 'locutor', 'locutores')} ·{' '}
          {plural(transcript.segments.length, 'fala', 'falas')}
          {markers.length > 0 && (
            <>
              {' '}
              · <span className="marker-count">{markersLabel(markers.length)}</span>
            </>
          )}{' '}
          · abra para conferir ou corrigir
        </span>
      </summary>
      {open && (
        <div className={styles.view}>
          <SpeakersPanel transcript={transcript} />
          <Segments transcript={transcript} markers={markers} recordingId={recordingId} anchorMs={anchorMs} />
        </div>
      )}
    </details>
  )
}
