import type en from '../en/shared'
import type { Catalog } from '../locale'

const shared: Catalog<typeof en> = {
  state: {
    queued: 'Na fila',
    uploading: 'Enviando',
    awaitingSpeakers: 'Aguardando locutores',
    ready: 'Pronta',
    failed: 'Falhou',
    cancelled: 'Cancelada',
  },
  busy: {
    received: 'Enviando',
    preprocessing: 'Pré-processando',
    transcription: 'Transcrevendo',
    speakers: 'Conferindo locutores',
    agenda_type: 'Detectando o tipo',
    fields: 'Preenchendo campos',
    summary: 'Resumindo',
  },
  stage: {
    asr: 'Reconhecendo a fala',
    alignment: 'Alinhando palavras',
    diarization: 'Separando locutores',
    embeddings: 'Calculando impressões de voz',
    finalizing: 'Finalizando',
  },
  markers_one: '{{count}} marcador',
  markers_other: '{{count}} marcadores',
  language: {
    auto: 'Detectar automaticamente',
    list: 'Idiomas ({{count}})',
  },
}

export default shared
