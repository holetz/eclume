import { useState, type FormEvent } from 'react'
import { clock } from '../app/formats'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { Marker } from '../bridge/types'

/** The optional note of the marker just made: the marker already exists, the note comes after. */
export function MarkerNote({ marker, onDone }: { marker: Marker; onDone: () => void }) {
  const bridge = useBridge()
  const [note, setNote] = useState(marker.note ?? '')
  const [error, setError] = useState<string | null>(null)

  async function add(event: FormEvent) {
    event.preventDefault()
    try {
      await bridge.annotateMarker(marker.client_id, note.trim() || null)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <form
      className="m-section border-top gap-2"
      onSubmit={add}
    >
      <label htmlFor="marker-note" className="text-muted text-12">
        Marcador em {clock(marker.at_ms)}
      </label>
      <div className="field-and-button">
        <input
          id="marker-note"
          className="input"
          placeholder="Nota (opcional)"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          Adicionar
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
