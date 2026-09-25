import { fixtures } from './fixtures'
import { mockFetch } from './http'

/** API da página de gravação transcrita (3 locutores), com rotas extras ou substitutas. */
export function mockTranscriptApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings/:id': () => fixtures.recordingTranscribed(),
    'GET /api/v1/transcripts/:id': () => fixtures.transcript(),
    'GET /api/v1/summary-templates': () => fixtures.summaryTemplatePage(),
    'GET /api/v1/transcripts/:id/summaries': () => fixtures.summaryPage(),
    ...extra,
  })
}

export const RECORDING_ID = '01928f3a-1c00-7a00-8000-000000000401'
export const TRANSCRIPT_ID = '01928f3a-1c00-7a00-8000-000000000501'
