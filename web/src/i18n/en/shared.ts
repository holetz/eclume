const shared = {
  state: {
    queued: 'Queued',
    uploading: 'Uploading',
    awaitingSpeakers: 'Awaiting speakers',
    ready: 'Ready',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },
  busy: {
    received: 'Uploading',
    preprocessing: 'Preprocessing',
    transcription: 'Transcribing',
    speakers: 'Checking speakers',
    agenda_type: 'Detecting the type',
    fields: 'Filling fields',
    summary: 'Summarizing',
  },
  stage: {
    asr: 'Recognizing speech',
    alignment: 'Aligning words',
    diarization: 'Separating speakers',
    embeddings: 'Computing voiceprints',
    finalizing: 'Finishing',
  },
  markers_one: '{{count}} marker',
  markers_other: '{{count}} markers',
  language: {
    auto: 'Detect automatically',
    list: 'Languages ({{count}})',
  },
} as const

export default shared
